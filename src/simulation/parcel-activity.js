import { keyedRandom } from "./prng.js";

const MAX_TICKS = 1_000_000;
const MAX_ACTIVITIES = 256;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finiteOr = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const freezeArray = (values) => Object.freeze(values);

function integerIn(value, fallback, minimum, maximum) {
  return clamp(Math.round(finiteOr(value, fallback)), minimum, maximum);
}

function compareIds(first, second) {
  return String(first).localeCompare(String(second));
}

const DEFAULT_ACTIVITY_TYPES = freezeArray([
  Object.freeze({ id: "green", label: "Green", frequency: 1, weight: 0.42, minimumCells: 2 }),
  Object.freeze({ id: "home", label: "Home", frequency: 6, weight: 0.18, minimumCells: 1 }),
  Object.freeze({ id: "market", label: "Market", frequency: 1.25, weight: 0.72, minimumCells: 3 }),
  Object.freeze({ id: "well", label: "Well", frequency: 0.75, weight: 0.62, minimumCells: 2 }),
  Object.freeze({ id: "workshop", label: "Workshop", frequency: 2, weight: 0.48, minimumCells: 2 }),
]);

function normalizeActivityTypes(input) {
  const source = Array.isArray(input) && input.length > 0 ? input : DEFAULT_ACTIVITY_TYPES;
  const seen = new Set();
  const types = [];
  for (let index = 0; index < source.length; index += 1) {
    const candidate = source[index];
    if (!candidate || typeof candidate !== "object") continue;
    const id = String(candidate.id ?? `activity-${index}`).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    types.push(Object.freeze({
      id,
      label: String(candidate.label ?? candidate.name ?? id),
      frequency: clamp(finiteOr(candidate.frequency ?? candidate.share, 1), 0.001, 1_000),
      weight: clamp(finiteOr(candidate.weight, 0.4), 0, 1_000),
      minimumCells: integerIn(candidate.minimumCells, 1, 1, 1_024),
    }));
  }
  return freezeArray([...(types.length > 0 ? types : DEFAULT_ACTIVITY_TYPES)]
    .sort((first, second) => compareIds(first.id, second.id)));
}

/** Normalize the policy that turns mature, fronted parcels into journey demand. */
export function normalizeParcelActivityConfig(input) {
  if (!input || typeof input !== "object" || input.enabled === false) return null;
  return Object.freeze({
    enabled: true,
    startTick: integerIn(input.startTick, 480, 0, MAX_TICKS),
    maturationTicks: integerIn(input.maturationTicks, 120, 1, MAX_TICKS),
    frontageLossTicks: integerIn(input.frontageLossTicks, 90, 1, MAX_TICKS),
    minimumParcelCells: integerIn(input.minimumParcelCells, 2, 1, 1_024),
    maximumActivities: integerIn(input.maximumActivities, 8, 1, MAX_ACTIVITIES),
    radius: clamp(finiteOr(input.radius, 10), 1, 100),
    accessOffset: clamp(finiteOr(input.accessOffset, 10), 0, 100),
    types: normalizeActivityTypes(input.types),
  });
}

function sideBetween(target, road) {
  if (road.row < target.row) return "north";
  if (road.column > target.column) return "east";
  if (road.row > target.row) return "south";
  return "west";
}

function accessPoint(target, side, offset, worldWidth, worldHeight) {
  let x = target.center.x;
  let y = target.center.y;
  if (side === "north") y = target.y - offset;
  else if (side === "east") x = target.x + target.width + offset;
  else if (side === "south") y = target.y + target.height + offset;
  else x = target.x - offset;
  return Object.freeze({
    x: clamp(x, 0, worldWidth),
    y: clamp(y, 0, worldHeight),
  });
}

function copyCounters(counters) {
  return {
    openings: counters.openings,
    closures: counters.closures,
    trips: counters.trips,
  };
}

/**
 * Dynamic, engine-owned activity demand. A parcel has to survive long enough
 * and touch the current public network before it can become a destination.
 * The chosen frontage stays stable while that public edge survives, avoiding
 * a target that jitters whenever neighboring traffic changes.
 */
export class ParcelActivityDemand {
  #cellById;

  constructor(config, {
    land,
    circulation,
    seed = 0,
    worldWidth = 1_000,
    worldHeight = 650,
  } = {}) {
    this.config = normalizeParcelActivityConfig(config);
    if (!this.config) throw new TypeError("ParcelActivityDemand requires an enabled activity configuration.");
    if (!land?.config || !Array.isArray(land.config.cells)) {
      throw new TypeError("ParcelActivityDemand requires a LandGridState instance.");
    }
    if (!circulation || typeof circulation.isPublic !== "function") {
      throw new TypeError("ParcelActivityDemand requires a PublicCirculation instance.");
    }
    this.land = land;
    this.circulation = circulation;
    this.seed = Number(seed) >>> 0;
    this.worldWidth = Math.max(1, finiteOr(worldWidth, land.config.geometry?.worldWidth ?? 1_000));
    this.worldHeight = Math.max(1, finiteOr(worldHeight, land.config.geometry?.worldHeight ?? 650));
    this.#cellById = new Map(land.config.cells.map((cell) => [cell.id, cell]));
    this.reset();
  }

  reset() {
    this.tick = -1;
    this.revision = 0;
    this.ageByParcel = new Map();
    this.frontageLossByParcel = new Map();
    this.typeByParcel = new Map();
    this.activeByParcel = new Map();
    this.visitsByDestination = new Map();
    this.tripsByType = new Map(this.config.types.map((type) => [type.id, 0]));
    this.counters = { openings: 0, closures: 0, trips: 0 };
    this.lastEvents = freezeArray([]);
    this.destinationCache = freezeArray([]);
    return this.frame();
  }

  #eligibleTypes(parcel) {
    return this.config.types.filter((type) => parcel.cellIds.length >= type.minimumCells);
  }

  #activityType(parcel) {
    const assignedId = this.typeByParcel.get(parcel.id);
    const assigned = this.config.types.find((type) => type.id === assignedId);
    if (assigned && parcel.cellIds.length >= assigned.minimumCells) return assigned;

    const eligible = this.#eligibleTypes(parcel);
    if (eligible.length === 0) return null;
    const activeCounts = new Map(this.config.types.map((type) => [type.id, 0]));
    for (const active of this.activeByParcel.values()) {
      activeCounts.set(active.typeId, (activeCounts.get(active.typeId) ?? 0) + 1);
    }
    const selected = [...eligible].sort((first, second) => (
      (activeCounts.get(first.id) ?? 0) / first.frequency
        - (activeCounts.get(second.id) ?? 0) / second.frequency
      || keyedRandom(this.seed, parcel.id, first.id, "activity-type-tie")
        - keyedRandom(this.seed, parcel.id, second.id, "activity-type-tie")
      || compareIds(first.id, second.id)
    ))[0];
    this.typeByParcel.set(parcel.id, selected.id);
    return selected;
  }

  #frontages(parcel) {
    const options = [];
    for (const landId of parcel.cellIds) {
      const target = this.#cellById.get(landId);
      if (!target) continue;
      for (const roadLandId of target.neighborIds) {
        if (!this.circulation.isPublic(roadLandId)) continue;
        const road = this.#cellById.get(roadLandId);
        if (!road) continue;
        const side = sideBetween(target, road);
        const point = accessPoint(
          target,
          side,
          this.config.accessOffset,
          this.worldWidth,
          this.worldHeight,
        );
        options.push(Object.freeze({
          key: `${target.id}:${side}:${road.id}`,
          landId: target.id,
          roadLandId: road.id,
          side,
          x: point.x,
          y: point.y,
          use: Math.max(0, finiteOr(this.circulation.usage?.(road.id), 0)),
        }));
      }
    }
    return options.sort((first, second) => (
      second.use - first.use
      || keyedRandom(this.seed, parcel.id, first.key, "activity-frontage")
        - keyedRandom(this.seed, parcel.id, second.key, "activity-frontage")
      || compareIds(first.key, second.key)
    ));
  }

  #destination(parcel, type, access) {
    const id = `activity:${parcel.id}`;
    const visits = this.visitsByDestination.get(id) ?? 0;
    const sizeMultiplier = 1 + Math.log2(Math.max(1, parcel.cellIds.length)) / 4;
    return Object.freeze({
      id,
      label: `${type.label} · person ${parcel.ownerId}`,
      kind: "parcel-activity",
      activityType: type.id,
      parcelId: parcel.id,
      ownerId: parcel.ownerId,
      landId: access.landId,
      roadLandId: access.roadLandId,
      side: access.side,
      x: access.x,
      y: access.y,
      radius: this.config.radius,
      weight: type.weight * sizeMultiplier,
      visits,
    });
  }

  #close(parcelId, reason, events) {
    const active = this.activeByParcel.get(parcelId);
    if (!active) return;
    this.activeByParcel.delete(parcelId);
    this.frontageLossByParcel.delete(parcelId);
    if (reason === "tenure-ended") {
      this.typeByParcel.delete(parcelId);
      this.visitsByDestination.delete(active.destination.id);
    }
    this.counters.closures += 1;
    events.push(Object.freeze({
      type: "activity-closure",
      tick: this.tick,
      activityId: active.destination.id,
      parcelId,
      reason,
    }));
  }

  #refreshDestinations() {
    this.destinationCache = freezeArray([...this.activeByParcel.values()]
      .map((active) => active.destination)
      .sort((first, second) => compareIds(first.id, second.id)));
  }

  advance(tick) {
    const nextTick = Math.max(0, Math.round(finiteOr(tick, 0)));
    const elapsed = this.tick < 0 ? 1 : Math.max(0, nextTick - this.tick);
    this.tick = nextTick;
    if (elapsed === 0) return this.frame();

    const events = [];
    const parcels = [...(this.land.frame(nextTick).parcels || [])]
      .sort((first, second) => compareIds(first.id, second.id));
    const parcelById = new Map(parcels.map((parcel) => [parcel.id, parcel]));
    const frontageByParcel = new Map();

    for (const parcel of parcels) {
      this.ageByParcel.set(parcel.id, (this.ageByParcel.get(parcel.id) ?? 0) + elapsed);
      frontageByParcel.set(parcel.id, this.#frontages(parcel));
    }
    for (const parcelId of [...this.ageByParcel.keys()]) {
      if (!parcelById.has(parcelId)) this.ageByParcel.delete(parcelId);
    }
    for (const parcelId of [...this.typeByParcel.keys()]) {
      if (!parcelById.has(parcelId) && !this.activeByParcel.has(parcelId)) {
        this.typeByParcel.delete(parcelId);
      }
    }

    for (const parcelId of [...this.activeByParcel.keys()].sort(compareIds)) {
      const parcel = parcelById.get(parcelId);
      if (!parcel) {
        this.#close(parcelId, "tenure-ended", events);
        continue;
      }
      const options = frontageByParcel.get(parcelId) || [];
      if (options.length === 0) {
        const quiet = (this.frontageLossByParcel.get(parcelId) ?? 0) + elapsed;
        this.frontageLossByParcel.set(parcelId, quiet);
        if (quiet >= this.config.frontageLossTicks) this.#close(parcelId, "frontage-lost", events);
        continue;
      }

      this.frontageLossByParcel.set(parcelId, 0);
      const active = this.activeByParcel.get(parcelId);
      const access = options.find((option) => option.key === active.accessKey) ?? options[0];
      const type = this.config.types.find((candidate) => candidate.id === active.typeId)
        ?? this.#activityType(parcel);
      this.activeByParcel.set(parcelId, Object.freeze({
        typeId: type.id,
        accessKey: access.key,
        destination: this.#destination(parcel, type, access),
      }));
    }

    const vacancies = this.config.maximumActivities - this.activeByParcel.size;
    if (vacancies > 0 && nextTick >= this.config.startTick) {
      const candidates = parcels
        .filter((parcel) => {
          if (this.activeByParcel.has(parcel.id)) return false;
          const assignedType = this.config.types.find(
            (type) => type.id === this.typeByParcel.get(parcel.id),
          );
          const hasEligibleType = assignedType
            ? parcel.cellIds.length >= assignedType.minimumCells
            : this.#eligibleTypes(parcel).length > 0;
          return hasEligibleType
            && parcel.cellIds.length >= this.config.minimumParcelCells
            && (this.ageByParcel.get(parcel.id) ?? 0) >= this.config.maturationTicks
            && (frontageByParcel.get(parcel.id)?.length ?? 0) > 0;
        })
        .sort((first, second) => (
          (this.ageByParcel.get(second.id) ?? 0) - (this.ageByParcel.get(first.id) ?? 0)
          || keyedRandom(this.seed, first.id, "activity-priority")
            - keyedRandom(this.seed, second.id, "activity-priority")
          || compareIds(first.id, second.id)
        ))
        .slice(0, vacancies);

      for (const parcel of candidates) {
        const type = this.#activityType(parcel);
        const access = frontageByParcel.get(parcel.id)[0];
        const destination = this.#destination(parcel, type, access);
        this.activeByParcel.set(parcel.id, Object.freeze({
          typeId: type.id,
          accessKey: access.key,
          destination,
        }));
        this.frontageLossByParcel.set(parcel.id, 0);
        this.counters.openings += 1;
        events.push(Object.freeze({
          type: "activity-opening",
          tick: nextTick,
          activityId: destination.id,
          activityType: type.id,
          parcelId: parcel.id,
          landId: access.landId,
          roadLandId: access.roadLandId,
        }));
      }
    }

    this.lastEvents = freezeArray(events);
    this.revision += 1;
    this.#refreshDestinations();
    return this.frame();
  }

  recordArrival(destinationId) {
    const id = String(destinationId ?? "");
    const entry = [...this.activeByParcel.entries()]
      .find(([, active]) => active.destination.id === id);
    if (!entry) return false;
    const [parcelId, active] = entry;
    this.visitsByDestination.set(id, (this.visitsByDestination.get(id) ?? 0) + 1);
    this.tripsByType.set(active.typeId, (this.tripsByType.get(active.typeId) ?? 0) + 1);
    this.counters.trips += 1;
    this.activeByParcel.set(parcelId, Object.freeze({
      ...active,
      destination: Object.freeze({
        ...active.destination,
        visits: this.visitsByDestination.get(id),
      }),
    }));
    this.revision += 1;
    this.#refreshDestinations();
    return true;
  }

  get destinations() {
    return this.destinationCache;
  }

  metrics() {
    return Object.freeze({
      activeActivities: this.activeByParcel.size,
      activityTrips: this.counters.trips,
      activityOpenings: this.counters.openings,
      activityClosures: this.counters.closures,
    });
  }

  frame() {
    const byType = this.config.types.map((type) => Object.freeze({
      id: type.id,
      label: type.label,
      count: this.destinationCache.filter((destination) => destination.activityType === type.id).length,
      trips: this.tripsByType.get(type.id) ?? 0,
    }));
    return Object.freeze({
      enabled: true,
      tick: Math.max(0, this.tick),
      revision: this.revision,
      config: this.config,
      destinations: this.destinationCache,
      events: this.lastEvents,
      byType: freezeArray(byType),
      metrics: this.metrics(),
    });
  }

  checksumState() {
    return Object.freeze({
      tick: this.tick,
      revision: this.revision,
      ageByParcel: freezeArray([...this.ageByParcel.entries()].sort(([first], [second]) => compareIds(first, second))),
      typeByParcel: freezeArray([...this.typeByParcel.entries()].sort(([first], [second]) => compareIds(first, second))),
      frontageLossByParcel: freezeArray(
        [...this.frontageLossByParcel.entries()].sort(([first], [second]) => compareIds(first, second)),
      ),
      destinations: this.destinationCache,
      visitsByDestination: freezeArray(
        [...this.visitsByDestination.entries()].sort(([first], [second]) => compareIds(first, second)),
      ),
      tripsByType: freezeArray([...this.tripsByType.entries()].sort(([first], [second]) => compareIds(first, second))),
      counters: Object.freeze(copyCounters(this.counters)),
      events: this.lastEvents,
    });
  }
}
