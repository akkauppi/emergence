import { keyedRandom } from "./prng.js";

const EPSILON = 1e-9;
const MAX_USE = 1_000_000_000;
const OPEN = 0;
const ROAD_RESERVED = 1;
const ROAD = 2;
const EMPTY_OWNER = -1;
const SIDE_ORDER = Object.freeze(["north", "east", "south", "west"]);
const ROLE_NAMES = Object.freeze(["open", "road-reserved", "road"]);
const transitionStates = new WeakMap();
const FLOW_MINIMUM_USE = 0.04;
const MAX_FLOW_FEATURES = 4_096;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finiteOr = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const freezeArray = (values) => Object.freeze(values);
const freezePoint = (x, y) => Object.freeze({ x, y });

function integerIn(value, fallback, minimum, maximum) {
  return clamp(Math.round(finiteOr(value, fallback)), minimum, maximum);
}

function compareIds(first, second) {
  return String(first).localeCompare(String(second));
}

function pointOf(value) {
  const source = value?.position && typeof value.position === "object" ? value.position : value;
  const x = Number(source?.x);
  const y = Number(source?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function normalizedSide(value) {
  const side = String(value ?? "").toLowerCase();
  if (side === "top") return "north";
  if (side === "right") return "east";
  if (side === "bottom") return "south";
  if (side === "left") return "west";
  return SIDE_ORDER.includes(side) ? side : null;
}

function frozenUnreachable(landId) {
  return Object.freeze({
    reachable: false,
    fronted: false,
    arrived: false,
    target: Object.freeze({ layer: "land", id: String(landId ?? "") }),
    access: null,
    waypoint: null,
    distance: null,
    remainingDistance: null,
    cost: null,
    cellIds: freezeArray([]),
    nodeIds: freezeArray([]),
  });
}

/** Normalize the authored policy for an emergent, cell-based public network. */
export function normalizeCirculationConfig(input) {
  if (!input || typeof input !== "object" || input.enabled === false) return null;
  const requestedSides = new Set((Array.isArray(input.entrySides) ? input.entrySides : ["west", "east"])
    .map(normalizedSide)
    .filter(Boolean));
  const reserveThreshold = clamp(finiteOr(input.reserveThreshold, 2.5), 0.001, 1_000_000);
  const flowPathThreshold = clamp(
    finiteOr(input.flowPathThreshold, reserveThreshold * 1.4),
    0.01,
    1_000_000,
  );
  return Object.freeze({
    enabled: true,
    sourceLayer: String(input.sourceLayer ?? input.source?.layer ?? "land"),
    entrySides: freezeArray(SIDE_ORDER.filter((side) => requestedSides.has(side))),
    usePersistence: clamp(finiteOr(input.usePersistence, 0.94), 0, 1),
    reserveThreshold,
    formationTicks: integerIn(input.formationTicks, 1, 1, 1_000_000),
    releaseThreshold: clamp(finiteOr(input.releaseThreshold, reserveThreshold * 0.5), 0, reserveThreshold),
    maturityTicks: integerIn(input.maturityTicks, 12, 0, 1_000_000),
    releaseTicks: integerIn(input.releaseTicks, 24, 1, 1_000_000),
    maxNewPerTick: integerIn(input.maxNewPerTick, 2, 0, 256),
    roadPreference: clamp(finiteOr(input.roadPreference, 0.45), 0, 0.95),
    trailPreference: clamp(finiteOr(input.trailPreference, 0.5), 0, 0.95),
    arrivalRadius: clamp(finiteOr(input.arrivalRadius, 10), 0.5, 500),
    flowResolution: clamp(finiteOr(input.flowResolution, 18), 6, 80),
    flowAngleBins: integerIn(input.flowAngleBins, 16, 4, 64),
    flowPersistence: clamp(finiteOr(input.flowPersistence, 0.965), 0, 1),
    flowTraceThreshold: clamp(finiteOr(input.flowTraceThreshold, 0.35), 0.01, 1_000_000),
    flowPathThreshold,
    flowFormationTicks: integerIn(input.flowFormationTicks, 1, 1, 1_000_000),
    flowReleaseThreshold: clamp(
      finiteOr(input.flowReleaseThreshold, flowPathThreshold * 0.5),
      0,
      flowPathThreshold,
    ),
    flowReleaseTicks: integerIn(input.flowReleaseTicks, 60, 1, 1_000_000),
    pressurePersistence: clamp(finiteOr(input.pressurePersistence, 0.975), 0, 1),
    pressureDetourRatio: clamp(finiteOr(input.pressureDetourRatio, 1.15), 1, 10),
    pressureDetourDistance: clamp(finiteOr(input.pressureDetourDistance, 40), 0, 10_000),
    easementPressureThreshold: clamp(finiteOr(input.easementPressureThreshold, 18), 0.1, 1_000_000),
    easementWidth: clamp(finiteOr(input.easementWidth, 13), 2, 100),
    pressureContribution: clamp(finiteOr(input.pressureContribution, 0.2), 0.001, 100),
    easementUsePersistence: clamp(finiteOr(input.easementUsePersistence, 0.97), 0, 1),
    easementAcquisitionThreshold: clamp(
      finiteOr(input.easementAcquisitionThreshold, 20),
      0.1,
      1_000_000,
    ),
    easementAcquisitionTicks: integerIn(input.easementAcquisitionTicks, 15, 1, 1_000_000),
  });
}

function segmentIntervalInRectangle(from, to, rectangle) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let minimum = 0;
  let maximum = 1;
  for (const [origin, delta, low, high] of [
    [from.x, dx, rectangle.x, rectangle.x + rectangle.width],
    [from.y, dy, rectangle.y, rectangle.y + rectangle.height],
  ]) {
    if (Math.abs(delta) <= EPSILON) {
      if (origin < low - EPSILON || origin > high + EPSILON) return null;
      continue;
    }
    const first = (low - origin) / delta;
    const second = (high - origin) / delta;
    minimum = Math.max(minimum, Math.min(first, second));
    maximum = Math.min(maximum, Math.max(first, second));
    if (maximum < minimum + EPSILON) return null;
  }
  return maximum - minimum > EPSILON ? { minimum, maximum } : null;
}

function routeHeapPush(heap, item) {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    const parent = heap[parentIndex];
    if (parent.cost < item.cost - EPSILON
      || (Math.abs(parent.cost - item.cost) <= EPSILON && parent.rank <= item.rank)) break;
    heap[index] = parent;
    index = parentIndex;
  }
  heap[index] = item;
}

function routeHeapPop(heap) {
  if (heap.length === 1) return heap.pop();
  const first = heap[0];
  const last = heap.pop();
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    let child = left;
    if (right < heap.length) {
      const a = heap[left];
      const b = heap[right];
      if (b.cost < a.cost - EPSILON
        || (Math.abs(b.cost - a.cost) <= EPSILON && b.rank < a.rank)) child = right;
    }
    const candidate = heap[child];
    if (last.cost < candidate.cost - EPSILON
      || (Math.abs(last.cost - candidate.cost) <= EPSILON && last.rank <= candidate.rank)) break;
    heap[index] = candidate;
    index = child;
  }
  heap[index] = last;
  return first;
}

function sideBetween(target, neighbor) {
  if (neighbor.row < target.row) return "north";
  if (neighbor.column > target.column) return "east";
  if (neighbor.row > target.row) return "south";
  return "west";
}

function accessPoint(target, side) {
  if (side === "north") return freezePoint(target.center.x, target.y);
  if (side === "east") return freezePoint(target.x + target.width, target.center.y);
  if (side === "south") return freezePoint(target.center.x, target.y + target.height);
  return freezePoint(target.x, target.center.y);
}

/**
 * Canonical circulation state. Movement reinforces preferred cells; only
 * threshold-crossing cells connected to the previous public snapshot may be
 * offered to the land arbitrator as new public reservations.
 */
export class PublicCirculation {
  #indexById;
  #cellById;
  #viewCache;

  constructor(config, { land, seed = 0, worldWidth = 1_000, worldHeight = 650 } = {}) {
    this.config = normalizeCirculationConfig(config);
    if (!this.config) throw new TypeError("PublicCirculation requires an enabled circulation configuration.");
    if (!land?.config || !Array.isArray(land.config.cells)) {
      throw new TypeError("PublicCirculation requires a LandGridState instance.");
    }
    this.land = land;
    this.landConfig = land.config;
    this.cells = this.landConfig.cells;
    this.geometry = this.landConfig.geometry;
    this.seed = Number(seed) >>> 0;
    this.worldWidth = Math.max(1, finiteOr(worldWidth, this.geometry.worldWidth ?? 1_000));
    this.worldHeight = Math.max(1, finiteOr(worldHeight, this.geometry.worldHeight ?? 650));
    this.#indexById = new Map(this.cells.map((cell) => [cell.id, cell.index]));
    this.#cellById = new Map(this.cells.map((cell) => [cell.id, cell]));
    this.reset();
  }

  #entryCell(side) {
    const row = Math.floor((this.geometry.rows - 1) / 2);
    const column = Math.floor((this.geometry.columns - 1) / 2);
    if (side === "north") return this.cells[column] ?? null;
    if (side === "east") return this.cells[row * this.geometry.columns + this.geometry.columns - 1] ?? null;
    if (side === "south") return this.cells[(this.geometry.rows - 1) * this.geometry.columns + column] ?? null;
    return this.cells[row * this.geometry.columns] ?? null;
  }

  reset() {
    const count = this.cells.length;
    this.roleByCell = new Uint8Array(count);
    this.useByCell = new Float64Array(count);
    this.loadByCell = new Float64Array(count);
    this.reservedAtByCell = new Int32Array(count).fill(-1);
    this.formingByCell = new Int32Array(count);
    this.belowThresholdByCell = new Int32Array(count);
    this.pressureByCell = new Float64Array(count);
    this.pressureAxisXByCell = new Float64Array(count);
    this.pressureAxisYByCell = new Float64Array(count);
    this.pressurePointXByCell = new Float64Array(count);
    this.pressurePointYByCell = new Float64Array(count);
    this.easementByCell = new Uint8Array(count);
    this.easementUseByCell = new Float64Array(count);
    this.easementFormationByCell = new Int32Array(count);
    this.acquiredByCell = new Uint8Array(count);
    this.flowSegments = new Map();
    this.journeyByAgent = new Map();
    this.counters = {
      reservations: 0,
      promotions: 0,
      releases: 0,
      degenerations: 0,
      flowPromotions: 0,
      flowDegenerations: 0,
      easementAcquisitions: 0,
    };
    this.revision = 0;
    this.lastEvents = freezeArray([]);

    const seen = new Set();
    this.entries = freezeArray(this.config.entrySides.flatMap((side) => {
      const cell = this.#entryCell(side);
      if (!cell || seen.has(cell.id)) return [];
      seen.add(cell.id);
      this.roleByCell[cell.index] = ROAD;
      return [Object.freeze({
        id: `road-entry:${side}`,
        side,
        landId: cell.id,
        nodeId: `road-node:${cell.id}`,
        x: cell.center.x,
        y: cell.center.y,
      })];
    }));
    this.#viewCache = null;
    return this.frame();
  }

  #isClaimed(index) {
    return Number(this.land.ownerByCell?.[index] ?? EMPTY_OWNER) !== EMPTY_OWNER;
  }

  #isPublicIndex(index) {
    return Boolean(index !== undefined
      && (this.roleByCell[index] !== OPEN || this.acquiredByCell[index])
      && !this.#isClaimed(index));
  }

  isPublic(landId) {
    return this.#isPublicIndex(this.#indexById.get(String(landId ?? "")));
  }

  publicLandIds() {
    return freezeArray(this.cells
      .filter((cell) => this.#isPublicIndex(cell.index))
      .map((cell) => cell.id)
      .sort(compareIds));
  }

  usage(landId) {
    const index = this.#indexById.get(String(landId ?? ""));
    return index === undefined ? null : this.useByCell[index];
  }

  cell(landId) {
    const index = this.#indexById.get(String(landId ?? ""));
    return index === undefined ? null : this.#observedCells()[index];
  }

  #observedCells() {
    const landRevision = Number(this.land.revision ?? 0);
    if (this.#viewCache?.revision === this.revision && this.#viewCache.landRevision === landRevision) {
      return this.#viewCache.cells;
    }
    const observed = freezeArray(this.cells.map((cell) => Object.freeze({
      id: cell.id,
      index: cell.index,
      row: cell.row,
      column: cell.column,
      center: cell.center,
      role: this.#isClaimed(cell.index)
        ? "open"
        : this.acquiredByCell[cell.index]
          ? "right-of-way"
          : ROLE_NAMES[this.roleByCell[cell.index]],
      isPublic: this.#isPublicIndex(cell.index),
      use: this.useByCell[cell.index],
      load: this.loadByCell[cell.index],
      formation: this.formingByCell[cell.index],
      claimed: this.#isClaimed(cell.index),
      pressure: this.pressureByCell[cell.index],
      easement: Boolean(this.easementByCell[cell.index]),
      easementUse: this.easementUseByCell[cell.index],
      acquired: Boolean(this.acquiredByCell[cell.index]),
    })));
    this.#viewCache = { revision: this.revision, landRevision, cells: observed };
    return observed;
  }

  #nearestTraversableCell(position, excludedIndex = -1) {
    const point = pointOf(position);
    if (!point) return null;
    const pitch = finiteOr(this.geometry.pitch, this.geometry.cellSize + this.geometry.gap);
    const guessedColumn = clamp(
      Math.round((point.x - this.geometry.x - this.geometry.cellSize / 2) / Math.max(EPSILON, pitch)),
      0,
      this.geometry.columns - 1,
    );
    const guessedRow = clamp(
      Math.round((point.y - this.geometry.y - this.geometry.cellSize / 2) / Math.max(EPSILON, pitch)),
      0,
      this.geometry.rows - 1,
    );
    const guessed = this.cells[guessedRow * this.geometry.columns + guessedColumn];
    if (guessed && guessed.index !== excludedIndex && !this.#isClaimed(guessed.index)) return guessed;
    return this.cells
      .filter((cell) => cell.index !== excludedIndex && !this.#isClaimed(cell.index))
      .map((cell) => ({ cell, distance: Math.hypot(point.x - cell.center.x, point.y - cell.center.y) }))
      .sort((first, second) => first.distance - second.distance || compareIds(first.cell.id, second.cell.id))[0]?.cell ?? null;
  }

  #route(position, agentId, landId) {
    const id = String(landId ?? "");
    const target = this.#cellById.get(id);
    if (!target) return frozenUnreachable(id);
    const start = this.#nearestTraversableCell(position, target.index);
    if (!start) return frozenUnreachable(id);

    const neighboring = target.neighborIds
      .map((neighborId) => this.#cellById.get(neighborId))
      .filter((cell) => cell && !this.#isClaimed(cell.index));
    if (neighboring.length === 0) return frozenUnreachable(id);
    const publicNeighbors = neighboring.filter((cell) => this.#isPublicIndex(cell.index));
    const goals = publicNeighbors.length > 0 ? publicNeighbors : neighboring;
    const goalIndexes = new Set(goals.map((cell) => cell.index));
    const maximumUse = Math.max(this.config.reserveThreshold, ...this.useByCell);
    const distances = new Float64Array(this.cells.length).fill(Infinity);
    const physicalDistances = new Float64Array(this.cells.length).fill(Infinity);
    const previous = new Int32Array(this.cells.length).fill(-1);
    const closed = new Uint8Array(this.cells.length);
    const heap = [];
    const rank = (index) => keyedRandom(this.seed, Number(agentId) || 0, id, this.cells[index].id, "route-tie");
    distances[start.index] = 0;
    physicalDistances[start.index] = Math.hypot(
      finiteOr(pointOf(position)?.x, start.center.x) - start.center.x,
      finiteOr(pointOf(position)?.y, start.center.y) - start.center.y,
    );
    routeHeapPush(heap, { index: start.index, cost: 0, rank: rank(start.index) });

    let goal = null;
    while (heap.length > 0) {
      const current = routeHeapPop(heap);
      if (closed[current.index]) continue;
      if (current.cost > distances[current.index] + EPSILON) continue;
      closed[current.index] = 1;
      if (goalIndexes.has(current.index)) {
        goal = this.cells[current.index];
        break;
      }
      const cell = this.cells[current.index];
      for (const neighborId of cell.neighborIds) {
        const neighbor = this.#cellById.get(neighborId);
        if (!neighbor || neighbor.index === target.index || this.#isClaimed(neighbor.index)) continue;
        const length = Math.hypot(neighbor.center.x - cell.center.x, neighbor.center.y - cell.center.y);
        const publicDiscount = this.#isPublicIndex(neighbor.index) ? this.config.roadPreference : 0;
        const traceDiscount = this.config.trailPreference * clamp(this.useByCell[neighbor.index] / maximumUse, 0, 1);
        const multiplier = Math.max(0.05, 1 - publicDiscount - traceDiscount);
        const candidate = distances[current.index] + length * multiplier;
        const known = distances[neighbor.index];
        const prior = previous[neighbor.index];
        const tie = rank(current.index);
        const priorTie = prior < 0 ? Infinity : rank(prior);
        if (candidate < known - EPSILON
          || (Math.abs(candidate - known) <= EPSILON && tie < priorTie)) {
          distances[neighbor.index] = candidate;
          physicalDistances[neighbor.index] = physicalDistances[current.index] + length;
          previous[neighbor.index] = current.index;
          routeHeapPush(heap, { index: neighbor.index, cost: candidate, rank: rank(neighbor.index) });
        }
      }
    }
    if (!goal) return frozenUnreachable(id);

    const reverse = [goal.index];
    const seen = new Set(reverse);
    while (reverse.at(-1) !== start.index) {
      const prior = previous[reverse.at(-1)];
      if (prior < 0 || seen.has(prior)) return frozenUnreachable(id);
      reverse.push(prior);
      seen.add(prior);
    }
    const indexes = reverse.reverse();
    const cellIds = freezeArray(indexes.map((index) => this.cells[index].id));
    const waypointCell = this.cells[indexes[1] ?? indexes[0]];
    const currentPoint = pointOf(position) ?? start.center;
    const arrived = goal.index === start.index
      && Math.hypot(currentPoint.x - goal.center.x, currentPoint.y - goal.center.y) <= this.config.arrivalRadius;
    const side = sideBetween(target, goal);
    const point = accessPoint(target, side);
    const access = Object.freeze({
      id: `road-access:${target.id}:${side}`,
      landId: target.id,
      target: Object.freeze({ layer: "land", id: target.id }),
      nodeId: `road-node:${goal.id}`,
      roadLandId: goal.id,
      side,
      x: point.x,
      y: point.y,
    });
    return Object.freeze({
      reachable: true,
      fronted: publicNeighbors.some((cell) => cell.index === goal.index),
      arrived,
      target: Object.freeze({ layer: "land", id }),
      access,
      waypoint: waypointCell.center,
      distance: physicalDistances[goal.index],
      remainingDistance: physicalDistances[goal.index],
      cost: distances[goal.index],
      cellIds,
      nodeIds: cellIds,
    });
  }

  route(position, _radius, agentId, landId) {
    return this.#route(position, agentId, landId);
  }

  fronted(landId) {
    const cell = this.#cellById.get(String(landId ?? ""));
    return Boolean(cell?.neighborIds.some((neighborId) => this.isPublic(neighborId)));
  }

  viewFor(self, tick = 0) {
    const position = pointOf(self) ?? { x: 0, y: 0 };
    const agentId = Math.max(0, Math.round(finiteOr(self?.id, 0)));
    const routeCache = new Map();
    const route = (landId) => {
      const id = String(landId ?? "");
      if (!routeCache.has(id)) routeCache.set(id, this.#route(position, agentId, id));
      return routeCache.get(id);
    };
    const cells = this.#observedCells();
    return Object.freeze({
      enabled: true,
      tick: Math.max(0, Math.round(finiteOr(tick, 0))),
      cells,
      cell: (landId) => {
        const index = this.#indexById.get(String(landId ?? ""));
        return index === undefined ? null : cells[index];
      },
      usage: (landId) => {
        const index = this.#indexById.get(String(landId ?? ""));
        return index === undefined ? null : this.useByCell[index];
      },
      isPublic: (landId) => this.isPublic(landId),
      fronted: (landId) => this.fronted(landId),
      route,
      canReach: (landId) => route(landId).reachable,
    });
  }

  spawn(agentId, population, radius = 0) {
    const entry = this.entries[Math.max(0, Math.round(finiteOr(agentId, 0))) % this.entries.length];
    if (!entry) {
      const first = this.cells.find((cell) => !this.#isClaimed(cell.index));
      return first ? Object.freeze({ x: first.center.x, y: first.center.y, angle: 0 }) : null;
    }
    const cell = this.#cellById.get(entry.landId);
    const id = Math.max(0, Math.round(finiteOr(agentId, 0)));
    const count = Math.max(1, Math.round(finiteOr(population, 1)));
    const entryIndex = this.entries.indexOf(entry);
    const slot = Math.floor(id / this.entries.length);
    const slots = Math.max(1, Math.ceil((count - entryIndex) / this.entries.length));
    const safeRadius = Math.max(0, finiteOr(radius, 0));
    const rangeX = Math.max(0, cell.width / 2 - safeRadius - 0.5);
    const rangeY = Math.max(0, cell.height / 2 - safeRadius - 0.5);
    const offset = ((slot + 0.5) / slots - 0.5) * 2;
    const verticalSide = entry.side === "west" || entry.side === "east";
    const x = cell.center.x + (verticalSide ? 0 : offset * rangeX);
    const y = cell.center.y + (verticalSide ? offset * rangeY : 0);
    const angle = entry.side === "west" ? 0
      : entry.side === "east" ? Math.PI
        : entry.side === "north" ? Math.PI / 2 : -Math.PI / 2;
    return Object.freeze({ x, y, angle });
  }

  #segmentCells(from, to) {
    const pitch = finiteOr(this.geometry.pitch, this.geometry.cellSize + this.geometry.gap);
    const minimumColumn = clamp(
      Math.floor((Math.min(from.x, to.x) - this.geometry.x) / Math.max(EPSILON, pitch)),
      0,
      this.geometry.columns - 1,
    );
    const maximumColumn = clamp(
      Math.floor((Math.max(from.x, to.x) - this.geometry.x) / Math.max(EPSILON, pitch)),
      0,
      this.geometry.columns - 1,
    );
    const minimumRow = clamp(
      Math.floor((Math.min(from.y, to.y) - this.geometry.y) / Math.max(EPSILON, pitch)),
      0,
      this.geometry.rows - 1,
    );
    const maximumRow = clamp(
      Math.floor((Math.max(from.y, to.y) - this.geometry.y) / Math.max(EPSILON, pitch)),
      0,
      this.geometry.rows - 1,
    );
    const result = [];
    for (let row = minimumRow; row <= maximumRow; row += 1) {
      for (let column = minimumColumn; column <= maximumColumn; column += 1) {
        const cell = this.cells[row * this.geometry.columns + column];
        if (cell && segmentIntervalInRectangle(from, to, cell)) result.push(cell.index);
      }
    }
    return result;
  }

  #stageFlow(canonical, tick) {
    const persistence = this.config.flowPersistence;
    const next = new Map();
    for (const [key, segment] of this.flowSegments) {
      const use = segment.use * persistence;
      if (use < FLOW_MINIMUM_USE && !segment.street && (segment.formationTicks ?? 0) <= 0) continue;
      next.set(key, {
        key: segment.key,
        x: segment.x,
        y: segment.y,
        axisX: segment.axisX * persistence,
        axisY: segment.axisY * persistence,
        use,
        load: 0,
        street: segment.street,
        formationTicks: segment.formationTicks,
        quietTicks: segment.quietTicks,
      });
    }

    const resolution = this.config.flowResolution;
    const bins = this.config.flowAngleBins;
    for (const segment of canonical) {
      const dx = segment.to.x - segment.from.x;
      const dy = segment.to.y - segment.from.y;
      const length = Math.hypot(dx, dy);
      if (length <= EPSILON) continue;
      const midpointX = (segment.from.x + segment.to.x) / 2;
      const midpointY = (segment.from.y + segment.to.y) / 2;
      let angle = Math.atan2(dy, dx);
      if (angle < 0) angle += Math.PI;
      if (angle >= Math.PI) angle -= Math.PI;
      const angleBin = Math.min(bins - 1, Math.floor(angle / Math.PI * bins));
      const column = Math.floor(midpointX / resolution);
      const row = Math.floor(midpointY / resolution);
      const key = `${column}:${row}:${angleBin}`;
      const existing = next.get(key);
      const priorUse = existing?.use ?? 0;
      const use = priorUse + 1;
      if (existing) {
        existing.x = (existing.x * priorUse + midpointX) / use;
        existing.y = (existing.y * priorUse + midpointY) / use;
        existing.axisX += Math.cos(angle * 2);
        existing.axisY += Math.sin(angle * 2);
        existing.use = use;
        existing.load += 1;
      } else {
        next.set(key, {
          key,
          x: midpointX,
          y: midpointY,
          axisX: Math.cos(angle * 2),
          axisY: Math.sin(angle * 2),
          use,
          load: 1,
          street: false,
          formationTicks: 0,
          quietTicks: 0,
        });
      }
    }

    const events = [];
    let promotions = 0;
    let degenerations = 0;
    for (const [key, segment] of next) {
      let street = segment.street === true;
      let formationTicks = segment.formationTicks ?? 0;
      let quietTicks = segment.quietTicks ?? 0;
      if (street) {
        quietTicks = segment.use < this.config.flowReleaseThreshold ? quietTicks + 1 : 0;
        if (quietTicks >= this.config.flowReleaseTicks) {
          street = false;
          formationTicks = 0;
          quietTicks = 0;
          degenerations += 1;
          events.push(Object.freeze({
            type: "flow-degeneration",
            tick,
            flowId: key,
            use: segment.use,
          }));
        }
      } else {
        formationTicks = segment.use >= this.config.flowPathThreshold && segment.load > 0
          ? formationTicks + 1
          : Math.max(0, formationTicks - 1);
        if (formationTicks >= this.config.flowFormationTicks) {
          street = true;
          formationTicks = 0;
          quietTicks = 0;
          promotions += 1;
          events.push(Object.freeze({
            type: "flow-promotion",
            tick,
            flowId: key,
            use: segment.use,
          }));
        }
      }
      if (!street && segment.use < FLOW_MINIMUM_USE && segment.load === 0) {
        next.delete(key);
        continue;
      }
      segment.street = street;
      segment.formationTicks = formationTicks;
      segment.quietTicks = quietTicks;
    }

    const limited = next.size <= MAX_FLOW_FEATURES
      ? next
      : new Map([...next.entries()]
        .sort((first, second) => Number(second[1].street) - Number(first[1].street)
          || second[1].use - first[1].use || compareIds(first[0], second[0]))
        .slice(0, MAX_FLOW_FEATURES));
    return { segments: limited, events, promotions, degenerations };
  }

  #easementForIndex(index) {
    if (index === undefined || !this.easementByCell[index]) return null;
    const cell = this.cells[index];
    const axisX = this.pressureAxisXByCell[index];
    const axisY = this.pressureAxisYByCell[index];
    const angle = Math.abs(axisX) + Math.abs(axisY) > EPSILON
      ? Math.atan2(axisY, axisX) / 2
      : 0;
    const unitX = Math.cos(angle);
    const unitY = Math.sin(angle);
    const pressure = Math.max(EPSILON, this.pressureByCell[index]);
    const originX = clamp(this.pressurePointXByCell[index] / pressure, cell.x, cell.x + cell.width);
    const originY = clamp(this.pressurePointYByCell[index] / pressure, cell.y, cell.y + cell.height);
    const positiveX = unitX > EPSILON ? (cell.x + cell.width - originX) / unitX
      : unitX < -EPSILON ? (cell.x - originX) / unitX : Infinity;
    const positiveY = unitY > EPSILON ? (cell.y + cell.height - originY) / unitY
      : unitY < -EPSILON ? (cell.y - originY) / unitY : Infinity;
    const negativeX = unitX > EPSILON ? (originX - cell.x) / unitX
      : unitX < -EPSILON ? (originX - cell.x - cell.width) / unitX : Infinity;
    const negativeY = unitY > EPSILON ? (originY - cell.y) / unitY
      : unitY < -EPSILON ? (originY - cell.y - cell.height) / unitY : Infinity;
    const positiveReach = Math.min(positiveX, positiveY);
    const negativeReach = Math.min(negativeX, negativeY);
    return Object.freeze({
      id: `easement:${cell.id}`,
      landId: cell.id,
      x1: originX - unitX * negativeReach,
      y1: originY - unitY * negativeReach,
      x2: originX + unitX * positiveReach,
      y2: originY + unitY * positiveReach,
      width: this.config.easementWidth,
      pressure: this.pressureByCell[index],
      use: this.easementUseByCell[index],
      acquired: Boolean(this.acquiredByCell[index]),
      status: "road",
      hierarchy: "path",
    });
  }

  easement(landId) {
    return this.#easementForIndex(this.#indexById.get(String(landId ?? "")));
  }

  #reachablePublic(roles, excludedIndex = -1, acquired = this.acquiredByCell) {
    const reached = new Set();
    const pending = [
      ...this.entries
      .map((entry) => this.#indexById.get(entry.landId))
      .filter((index) => index !== undefined
        && index !== excludedIndex
        && roles[index] !== OPEN
        && !this.#isClaimed(index)),
      ...this.cells
        .filter((cell) => cell.index !== excludedIndex
          && acquired[cell.index]
          && !this.#isClaimed(cell.index))
        .map((cell) => cell.index),
    ];
    while (pending.length > 0) {
      const index = pending.pop();
      if (reached.has(index)) continue;
      reached.add(index);
      for (const neighborId of this.cells[index].neighborIds) {
        const neighborIndex = this.#indexById.get(neighborId);
        if (neighborIndex === undefined
          || neighborIndex === excludedIndex
          || reached.has(neighborIndex)
          || roles[neighborIndex] === OPEN
          || this.#isClaimed(neighborIndex)) continue;
        pending.push(neighborIndex);
      }
    }
    return reached;
  }

  #canRelease(index, roles, acquired = this.acquiredByCell) {
    const reached = this.#reachablePublic(roles, index, acquired);
    return this.cells.every((cell) => (
      cell.index === index
      || roles[cell.index] === OPEN
      || this.#isClaimed(cell.index)
      || reached.has(cell.index)
    ));
  }

  #pruneDisconnected(roles, reservedAt, belowThreshold, events, counters, tick, acquired) {
    const reached = this.#reachablePublic(roles, -1, acquired);
    for (const cell of this.cells) {
      const index = cell.index;
      if (roles[index] === OPEN || reached.has(index)) continue;
      roles[index] = OPEN;
      reservedAt[index] = -1;
      belowThreshold[index] = 0;
      counters.releases += 1;
      events.push(Object.freeze({ type: "road-disconnection-release", tick, landId: cell.id }));
    }
  }

  stage(segments, tick = 0) {
    if (!Array.isArray(segments)) {
      return Object.freeze({ ok: false, error: "Circulation movement segments must be an array.", events: freezeArray([]) });
    }
    const currentTick = Math.max(0, Math.round(finiteOr(tick, 0)));
    const nextTick = currentTick + 1;
    const canonical = [];
    for (const submitted of segments) {
      const agentId = Number(submitted?.agentId);
      const from = pointOf(submitted?.from);
      const to = pointOf(submitted?.to);
      const attemptedTo = pointOf(submitted?.attemptedTo) ?? to;
      const pressureTo = pointOf(submitted?.pressureTo);
      if (!Number.isSafeInteger(agentId) || agentId < 0 || !from || !to || !attemptedTo) {
        return Object.freeze({ ok: false, error: "Every circulation segment requires an agentId and finite from/to points.", events: freezeArray([]) });
      }
      canonical.push({ agentId, from, to, attemptedTo, pressureTo });
    }
    canonical.sort((first, second) => first.agentId - second.agentId
      || first.from.x - second.from.x || first.from.y - second.from.y
      || first.to.x - second.to.x || first.to.y - second.to.y);
    const journeys = new Map([...this.journeyByAgent.entries()]
      .map(([agentId, journey]) => [agentId, { ...journey }]));
    const continuityDistance = Math.max(24, this.config.flowResolution * 2);
    for (const segment of canonical) {
      if (!segment.pressureTo) {
        journeys.delete(segment.agentId);
        segment.detourDistance = 0;
        segment.detourRatio = 1;
        segment.stepExtraDistance = 0;
        continue;
      }
      const remainingBefore = Math.hypot(
        segment.pressureTo.x - segment.from.x,
        segment.pressureTo.y - segment.from.y,
      );
      const remainingAfter = Math.hypot(
        segment.pressureTo.x - segment.to.x,
        segment.pressureTo.y - segment.to.y,
      );
      const movement = Math.hypot(
        segment.to.x - segment.from.x,
        segment.to.y - segment.from.y,
      );
      const prior = journeys.get(segment.agentId);
      const sameTarget = prior
        && Math.hypot(prior.targetX - segment.pressureTo.x, prior.targetY - segment.pressureTo.y) <= 0.01;
      const continuous = sameTarget
        && Math.hypot(prior.lastX - segment.from.x, prior.lastY - segment.from.y) <= continuityDistance;
      const directDistance = continuous
        ? prior.directDistance
        : Math.max(EPSILON, remainingBefore);
      const traveledDistance = (continuous ? prior.traveledDistance : 0) + movement;
      const projectedDistance = traveledDistance + remainingAfter;
      segment.detourDistance = Math.max(0, projectedDistance - directDistance);
      segment.detourRatio = Math.max(1, projectedDistance / directDistance);
      segment.stepExtraDistance = Math.max(0, movement - (remainingBefore - remainingAfter));
      journeys.set(segment.agentId, {
        targetX: segment.pressureTo.x,
        targetY: segment.pressureTo.y,
        directDistance,
        traveledDistance,
        detourDistance: segment.detourDistance,
        detourRatio: segment.detourRatio,
        lastX: segment.to.x,
        lastY: segment.to.y,
      });
    }
    const flow = this.#stageFlow(canonical, nextTick);

    const loads = new Float64Array(this.cells.length);
    for (const segment of canonical) {
      if (Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y) <= EPSILON) continue;
      for (const index of this.#segmentCells(segment.from, segment.to)) loads[index] += 1;
    }
    const uses = new Float64Array(this.cells.length);
    for (let index = 0; index < uses.length; index += 1) {
      // Public-use bids share the land layer's finite bid domain. Saturating
      // here keeps arbitrarily long runs valid without changing rank order
      // among signals below the cap.
      uses[index] = Math.min(
        MAX_USE,
        this.useByCell[index] * this.config.usePersistence + loads[index],
      );
    }
    const roles = this.roleByCell.slice();
    const reservedAt = this.reservedAtByCell.slice();
    const forming = this.formingByCell.slice();
    const belowThreshold = this.belowThresholdByCell.slice();
    const counters = { ...this.counters };
    counters.flowPromotions += flow.promotions;
    counters.flowDegenerations += flow.degenerations;
    const events = [...flow.events];
    const pressures = new Float64Array(this.pressureByCell.length);
    const pressureAxisX = new Float64Array(this.pressureAxisXByCell.length);
    const pressureAxisY = new Float64Array(this.pressureAxisYByCell.length);
    const pressurePointX = new Float64Array(this.pressurePointXByCell.length);
    const pressurePointY = new Float64Array(this.pressurePointYByCell.length);
    const easements = this.easementByCell.slice();
    const easementUses = new Float64Array(this.easementUseByCell.length);
    const easementFormation = this.easementFormationByCell.slice();
    const acquired = this.acquiredByCell.slice();
    for (let index = 0; index < pressures.length; index += 1) {
      // Once acquired, preserve the surveyed crossing geometry. Pressure can
      // fade on private land, but a public right-of-way must not slowly rotate
      // or drift as its weighted samples approach floating-point zero.
      const pressurePersistence = acquired[index] ? 1 : this.config.pressurePersistence;
      pressures[index] = this.pressureByCell[index] * pressurePersistence;
      pressureAxisX[index] = this.pressureAxisXByCell[index] * pressurePersistence;
      pressureAxisY[index] = this.pressureAxisYByCell[index] * pressurePersistence;
      pressurePointX[index] = this.pressurePointXByCell[index] * pressurePersistence;
      pressurePointY[index] = this.pressurePointYByCell[index] * pressurePersistence;
      easementUses[index] = this.easementUseByCell[index] * this.config.easementUsePersistence
        + (easements[index] ? loads[index] : 0);
      if (!easements[index] || acquired[index] || !this.#isClaimed(index)) {
        easementFormation[index] = 0;
      } else {
        easementFormation[index] = easementUses[index] >= this.config.easementAcquisitionThreshold
          && loads[index] > 0
          ? Math.min(this.config.easementAcquisitionTicks, easementFormation[index] + 1)
          : Math.max(0, easementFormation[index] - 1);
      }
    }
    for (const segment of canonical) {
      if (!segment.pressureTo
        || segment.detourRatio < this.config.pressureDetourRatio
        || segment.detourDistance < this.config.pressureDetourDistance
        || segment.stepExtraDistance <= 0.05) continue;
      const pressureTarget = segment.pressureTo;
      const dx = pressureTarget.x - segment.from.x;
      const dy = pressureTarget.y - segment.from.y;
      if (Math.hypot(dx, dy) <= EPSILON) continue;
      const angle = Math.atan2(dy, dx);
      const blockedIndex = this.#segmentCells(segment.from, pressureTarget)
        .filter((index) => this.#isClaimed(index) && !easements[index])
        .sort((first, second) => (
          Math.hypot(
            segment.from.x - this.cells[first].center.x,
            segment.from.y - this.cells[first].center.y,
          ) - Math.hypot(
            segment.from.x - this.cells[second].center.x,
            segment.from.y - this.cells[second].center.y,
          ) || compareIds(this.cells[first].id, this.cells[second].id)
        ))[0];
      if (blockedIndex === undefined) continue;
      const contribution = this.config.pressureContribution * clamp(
        segment.stepExtraDistance / Math.max(1, this.config.flowResolution * 0.2),
        0.25,
        2.5,
      );
      pressures[blockedIndex] += contribution;
      pressureAxisX[blockedIndex] += Math.cos(angle * 2) * contribution;
      pressureAxisY[blockedIndex] += Math.sin(angle * 2) * contribution;
      const targetCell = this.cells[blockedIndex];
      const lengthSquared = dx * dx + dy * dy;
      const projection = clamp(
        ((targetCell.center.x - segment.from.x) * dx
          + (targetCell.center.y - segment.from.y) * dy) / lengthSquared,
        0,
        1,
      );
      pressurePointX[blockedIndex] += (segment.from.x + dx * projection) * contribution;
      pressurePointY[blockedIndex] += (segment.from.y + dy * projection) * contribution;
      if (pressures[blockedIndex] < this.config.easementPressureThreshold) continue;
      easements[blockedIndex] = 1;
      events.push(Object.freeze({
        type: "pressure-easement",
        tick: nextTick,
        landId: this.cells[blockedIndex].id,
        pressure: pressures[blockedIndex],
        detourDistance: segment.detourDistance,
        detourRatio: segment.detourRatio,
      }));
    }
    const publicAcquisitions = freezeArray(this.cells
      .filter((cell) => easements[cell.index]
        && !acquired[cell.index]
        && this.#isClaimed(cell.index)
        && easementFormation[cell.index] >= this.config.easementAcquisitionTicks)
      .map((cell) => Object.freeze({
        landId: cell.id,
        use: easementUses[cell.index],
      }))
      .sort((first, second) => second.use - first.use || compareIds(first.landId, second.landId)));
    const releaseRequests = [];
    const publicCells = this.publicLandIds();
    const entryLandIds = new Set(this.entries.map((entry) => entry.landId));

    for (const cell of this.cells) {
      const index = cell.index;
      if (this.roleByCell[index] !== OPEN || acquired[index] || this.#isClaimed(index)) {
        forming[index] = 0;
        continue;
      }
      forming[index] = uses[index] >= this.config.reserveThreshold && loads[index] > 0
        ? Math.min(this.config.formationTicks, forming[index] + 1)
        : Math.max(0, forming[index] - 1);
    }

    for (const cell of this.cells) {
      const index = cell.index;
      if (this.roleByCell[index] === OPEN) continue;
      if (this.#isClaimed(index)) {
        roles[index] = OPEN;
        reservedAt[index] = -1;
        forming[index] = 0;
        belowThreshold[index] = 0;
        counters.releases += 1;
        events.push(Object.freeze({ type: "road-private-displacement", tick: nextTick, landId: cell.id }));
        continue;
      }
      if (entryLandIds.has(cell.id)) {
        belowThreshold[index] = 0;
        continue;
      }
      belowThreshold[index] = uses[index] < this.config.releaseThreshold
        ? belowThreshold[index] + 1 : 0;
      if (this.roleByCell[index] === ROAD_RESERVED) {
        const age = nextTick - reservedAt[index];
        if (age >= this.config.maturityTicks && uses[index] >= this.config.releaseThreshold) {
          roles[index] = ROAD;
          reservedAt[index] = -1;
          belowThreshold[index] = 0;
          counters.promotions += 1;
          events.push(Object.freeze({ type: "road-promotion", tick: nextTick, landId: cell.id }));
        } else if (belowThreshold[index] >= this.config.releaseTicks) {
          // Defer this until accepted public candidates are known. A cell may
          // not disappear if it would strand an established or newly accepted
          // branch away from every entry seed.
          releaseRequests.push({ index, type: "road-release" });
        }
      } else if (belowThreshold[index] >= this.config.releaseTicks) {
        // Defer this until accepted public candidates are known. A cell may
        // not disappear if it would strand an established or newly accepted
        // branch away from every entry seed.
        releaseRequests.push({ index, type: "road-degeneration" });
      }
    }

    const candidates = this.cells.filter((cell) => {
      const index = cell.index;
      return this.roleByCell[index] === OPEN
        && !this.acquiredByCell[index]
        && !this.#isClaimed(index)
        && loads[index] > 0
        && uses[index] >= this.config.reserveThreshold
        && forming[index] >= this.config.formationTicks
        && cell.neighborIds.some((neighborId) => this.isPublic(neighborId));
    }).map((cell) => ({
      landId: cell.id,
      bid: uses[cell.index],
      use: uses[cell.index],
      load: loads[cell.index],
      tie: keyedRandom(this.seed, currentTick, cell.id, "road-reservation-tie"),
    })).sort((first, second) => second.use - first.use
      || second.load - first.load
      || second.tie - first.tie
      || compareIds(first.landId, second.landId))
      .slice(0, this.config.maxNewPerTick)
      .map(({ tie: _tie, ...candidate }) => Object.freeze(candidate));
    const publicCandidates = freezeArray(candidates);
    const frozenEvents = freezeArray(events);
    const transition = Object.freeze({
      ok: true,
      error: null,
      tick: nextTick,
      publicCells,
      publicCandidates,
      publicAcquisitions,
      events: frozenEvents,
    });
    transitionStates.set(transition, {
      source: this,
      baseRevision: this.revision,
      roles,
      uses,
      loads,
      reservedAt,
      forming,
      belowThreshold,
      counters,
      events,
      releaseRequests,
      flowSegments: flow.segments,
      journeys,
      pressures,
      pressureAxisX,
      pressureAxisY,
      pressurePointX,
      pressurePointY,
      easements,
      easementUses,
      easementFormation,
      acquired,
      publicAcquisitions: new Map(publicAcquisitions.map((candidate) => [candidate.landId, candidate])),
      candidates: new Map(candidates.map((candidate) => [candidate.landId, candidate])),
    });
    return transition;
  }

  commit(transition, {
    acceptedLandIds = [],
    acceptedAcquisitionLandIds = [],
    returnFrame = true,
  } = {}) {
    const next = transitionStates.get(transition);
    if (!next || next.source !== this) throw new TypeError("The circulation transition was not staged by this store.");
    if (next.baseRevision !== this.revision) throw new Error("The circulation transition is stale and cannot be committed.");
    const accepted = new Set(Array.from(acceptedLandIds ?? [], (landId) => String(landId)));
    const acceptedAcquisitions = new Set(Array.from(
      acceptedAcquisitionLandIds ?? [],
      (landId) => String(landId),
    ));
    const events = [...next.events];
    for (const [landId, candidate] of [...next.publicAcquisitions.entries()]
      .sort((first, second) => compareIds(first[0], second[0]))) {
      const index = this.#indexById.get(landId);
      if (index === undefined) continue;
      if (!acceptedAcquisitions.has(landId)) {
        // A rejected acquisition (for example one that would split a parcel)
        // must earn another sustained-use window before it is reconsidered.
        next.easementFormation[index] = 0;
        continue;
      }
      next.acquired[index] = 1;
      next.easements[index] = 1;
      next.easementFormation[index] = 0;
      next.counters.easementAcquisitions += 1;
      events.push(Object.freeze({
        type: "easement-acquisition",
        tick: transition.tick,
        landId,
        use: candidate.use,
      }));
    }
    for (const landId of [...accepted].sort(compareIds)) {
      const candidate = next.candidates.get(landId);
      const index = this.#indexById.get(landId);
      if (!candidate || index === undefined || next.roles[index] !== OPEN || this.#isClaimed(index)) continue;
      const immediatelyMature = this.config.maturityTicks === 0
        && next.uses[index] >= this.config.releaseThreshold;
      next.roles[index] = immediatelyMature ? ROAD : ROAD_RESERVED;
      next.reservedAt[index] = immediatelyMature ? -1 : transition.tick;
      next.forming[index] = 0;
      next.belowThreshold[index] = 0;
      next.counters.reservations += 1;
      events.push(Object.freeze({
        type: "road-reservation",
        tick: transition.tick,
        landId,
        bid: candidate.bid,
        use: candidate.use,
        load: candidate.load,
        maturesAt: transition.tick + this.config.maturityTicks,
      }));
      if (immediatelyMature) {
        next.counters.promotions += 1;
        events.push(Object.freeze({ type: "road-promotion", tick: transition.tick, landId }));
      }
    }
    for (const request of next.releaseRequests.sort((first, second) => (
      compareIds(this.cells[first.index].id, this.cells[second.index].id)
    ))) {
      const { index, type } = request;
      const expectedRole = type === "road-degeneration" ? ROAD : ROAD_RESERVED;
      if (next.roles[index] !== expectedRole
        || !this.#canRelease(index, next.roles, next.acquired)) continue;
      const wasRoad = next.roles[index] === ROAD;
      next.roles[index] = OPEN;
      next.reservedAt[index] = -1;
      next.forming[index] = 0;
      next.belowThreshold[index] = 0;
      next.counters.releases += 1;
      if (wasRoad) next.counters.degenerations += 1;
      events.push(Object.freeze({ type, tick: transition.tick, landId: this.cells[index].id }));
    }
    this.#pruneDisconnected(
      next.roles,
      next.reservedAt,
      next.belowThreshold,
      events,
      next.counters,
      transition.tick,
      next.acquired,
    );
    this.roleByCell = next.roles;
    this.useByCell = next.uses;
    this.loadByCell = next.loads;
    this.reservedAtByCell = next.reservedAt;
    this.formingByCell = next.forming;
    this.belowThresholdByCell = next.belowThreshold;
    this.flowSegments = next.flowSegments;
    this.journeyByAgent = next.journeys;
    this.pressureByCell = next.pressures;
    this.pressureAxisXByCell = next.pressureAxisX;
    this.pressureAxisYByCell = next.pressureAxisY;
    this.pressurePointXByCell = next.pressurePointX;
    this.pressurePointYByCell = next.pressurePointY;
    this.easementByCell = next.easements;
    this.easementUseByCell = next.easementUses;
    this.easementFormationByCell = next.easementFormation;
    this.acquiredByCell = next.acquired;
    this.counters = next.counters;
    this.lastEvents = freezeArray(events);
    this.revision += 1;
    this.#viewCache = null;
    transitionStates.delete(transition);
    return returnFrame ? this.frame() : null;
  }

  metrics() {
    let roadCells = 0;
    let roadReservedCells = 0;
    let activeMovementCells = 0;
    let totalPublicUse = 0;
    let publicCells = 0;
    let maxRoadUse = 0;
    let totalPublicLoad = 0;
    let maxPublicLoad = 0;
    let networkComponents = 0;
    let acquiredRightOfWays = 0;
    for (const cell of this.cells) {
      const index = cell.index;
      if (this.loadByCell[index] > 0) activeMovementCells += 1;
      if (this.#isPublicIndex(index) && this.roleByCell[index] === ROAD) roadCells += 1;
      if (this.#isPublicIndex(index) && this.roleByCell[index] === ROAD_RESERVED) roadReservedCells += 1;
      if (this.#isPublicIndex(index) && this.acquiredByCell[index]) acquiredRightOfWays += 1;
      if (this.#isPublicIndex(index)) {
        publicCells += 1;
        totalPublicUse += this.useByCell[index];
        totalPublicLoad += this.loadByCell[index];
        maxRoadUse = Math.max(maxRoadUse, this.useByCell[index]);
        maxPublicLoad = Math.max(maxPublicLoad, this.loadByCell[index]);
      }
    }
    const reached = new Set();
    for (const cell of this.cells) {
      if (!this.#isPublicIndex(cell.index) || reached.has(cell.index)) continue;
      networkComponents += 1;
      const pending = [cell.index];
      while (pending.length > 0) {
        const index = pending.pop();
        if (reached.has(index)) continue;
        reached.add(index);
        for (const neighborId of this.cells[index].neighborIds) {
          const neighborIndex = this.#indexById.get(neighborId);
          if (this.#isPublicIndex(neighborIndex) && !reached.has(neighborIndex)) pending.push(neighborIndex);
        }
      }
    }
    const capacity = Math.max(1, this.config.reserveThreshold);
    const activeFlowEdges = [...this.flowSegments.values()]
      .filter((segment) => segment.use >= this.config.flowTraceThreshold).length;
    const establishedFlowEdges = [...this.flowSegments.values()]
      .filter((segment) => segment.street).length;
    const easementCount = this.easementByCell.reduce((count, active) => count + (active ? 1 : 0), 0);
    const journeys = [...this.journeyByAgent.values()];
    const totalDetourDistance = journeys.reduce((sum, journey) => sum + journey.detourDistance, 0);
    const totalDetourRatio = journeys.reduce((sum, journey) => sum + journey.detourRatio, 0);
    return Object.freeze({
      roadCells,
      roadReservedCells,
      roadShare: this.cells.length > 0 ? roadCells / this.cells.length : 0,
      publicCellShare: this.cells.length > 0 ? publicCells / this.cells.length : 0,
      activeMovementCells,
      activeRouteCells: activeMovementCells,
      networkComponents,
      meanRoadUse: publicCells > 0 ? totalPublicUse / publicCells : 0,
      maxRoadUse,
      meanStreetCongestion: publicCells > 0 ? totalPublicLoad / publicCells / capacity : 0,
      maxStreetCongestion: maxPublicLoad / capacity,
      congestedEdgeShare: publicCells > 0
        ? this.cells.filter((cell) => this.#isPublicIndex(cell.index)
          && this.loadByCell[cell.index] >= capacity).length / publicCells : 0,
      occupiedStreetEdges: this.cells.filter((cell) => this.#isPublicIndex(cell.index)
        && this.loadByCell[cell.index] > 0).length,
      streetPopulation: totalPublicLoad,
      activeFlowEdges,
      establishedFlowEdges,
      easementCount,
      acquiredRightOfWays,
      easementAcquisitions: this.counters.easementAcquisitions,
      activeJourneys: journeys.length,
      meanJourneyDetourDistance: journeys.length > 0 ? totalDetourDistance / journeys.length : 0,
      maxJourneyDetourDistance: journeys.reduce(
        (maximum, journey) => Math.max(maximum, journey.detourDistance),
        0,
      ),
      meanJourneyDetourRatio: journeys.length > 0 ? totalDetourRatio / journeys.length : 1,
      maxJourneyDetourRatio: journeys.reduce(
        (maximum, journey) => Math.max(maximum, journey.detourRatio),
        journeys.length > 0 ? 1 : 0,
      ),
      streetDegenerations: this.counters.degenerations,
      flowPromotions: this.counters.flowPromotions,
      flowDegenerations: this.counters.flowDegenerations,
    });
  }

  frame() {
    const dynamicCells = this.#observedCells();
    const publicCells = this.cells.filter((cell) => this.#isPublicIndex(cell.index));
    const regions = freezeArray(publicCells
      // An acquired easement remains a narrow, off-grid line rather than
      // turning its whole cadastral cell into an orthogonal street block.
      .filter((cell) => !this.acquiredByCell[cell.index])
      .map((cell) => Object.freeze({
        id: `road-region:${cell.id}`,
        landId: cell.id,
        x: cell.x,
        y: cell.y,
        width: cell.width,
        height: cell.height,
        hierarchy: this.roleByCell[cell.index] === ROAD ? "secondary" : "path",
        role: ROLE_NAMES[this.roleByCell[cell.index]],
        use: this.useByCell[cell.index],
        load: this.loadByCell[cell.index],
      })));
    const nodes = freezeArray(publicCells.map((cell) => Object.freeze({
      id: `road-node:${cell.id}`,
      landId: cell.id,
      x: cell.center.x,
      y: cell.center.y,
      kind: this.entries.some((entry) => entry.landId === cell.id)
        ? "entry"
        : this.acquiredByCell[cell.index]
          ? "right-of-way"
          : "road",
    })));
    const edges = [...this.flowSegments.values()]
      .filter((segment) => segment.street || segment.use >= this.config.flowTraceThreshold)
      .map((segment) => {
        const angle = Math.atan2(segment.axisY, segment.axisX) / 2;
        const unitX = Math.cos(angle);
        const unitY = Math.sin(angle);
        const halfLength = this.config.flowResolution * 0.9;
        const established = segment.street === true;
        return Object.freeze({
          id: `flow-edge:${segment.key}`,
          from: null,
          to: null,
          x1: clamp(segment.x - unitX * halfLength, 0, this.worldWidth),
          y1: clamp(segment.y - unitY * halfLength, 0, this.worldHeight),
          x2: clamp(segment.x + unitX * halfLength, 0, this.worldWidth),
          y2: clamp(segment.y + unitY * halfLength, 0, this.worldHeight),
          length: halfLength * 2,
          width: established
            ? clamp(3.5 + Math.log1p(segment.use) * 1.35, 4, 11)
            : clamp(0.9 + Math.log1p(segment.use) * 0.5, 1.1, 2.2),
          hierarchy: established && segment.use >= this.config.flowPathThreshold * 2
            ? "secondary" : "path",
          status: established ? "road" : "trace",
          load: segment.load,
          use: segment.use,
          capacity: Math.max(1, this.config.flowPathThreshold),
          congestion: segment.load / Math.max(1, this.config.flowPathThreshold),
          flow: true,
        });
      });
    for (let index = 0; index < this.cells.length; index += 1) {
      const easement = this.#easementForIndex(index);
      if (!easement) continue;
      edges.push(Object.freeze({
        ...easement,
        from: null,
        to: null,
        load: this.loadByCell[index],
        use: easement.acquired ? this.easementUseByCell[index] : this.pressureByCell[index],
        capacity: easement.acquired
          ? this.config.easementAcquisitionThreshold
          : this.config.easementPressureThreshold,
        congestion: easement.acquired
          ? this.easementUseByCell[index] / this.config.easementAcquisitionThreshold
          : this.pressureByCell[index] / this.config.easementPressureThreshold,
        easement: true,
      }));
    }
    edges.sort((first, second) => compareIds(first.id, second.id));
    const accesses = [];
    for (const target of this.cells) {
      if (this.#isClaimed(target.index)) continue;
      for (const neighborId of target.neighborIds) {
        const neighbor = this.#cellById.get(neighborId);
        if (!neighbor || !this.#isPublicIndex(neighbor.index)) continue;
        const side = sideBetween(target, neighbor);
        const point = accessPoint(target, side);
        accesses.push(Object.freeze({
          id: `road-access:${target.id}:${side}`,
          landId: target.id,
          roadLandId: neighbor.id,
          nodeId: `road-node:${neighbor.id}`,
          side,
          x: point.x,
          y: point.y,
        }));
      }
    }
    accesses.sort((first, second) => compareIds(first.id, second.id));
    return Object.freeze({
      enabled: true,
      kind: "emergent-flow-network",
      sourceLayer: this.config.sourceLayer,
      revision: this.revision,
      cells: dynamicCells,
      regions,
      nodes,
      edges: freezeArray(edges),
      accesses: freezeArray(accesses),
      entries: this.entries,
      events: this.lastEvents,
      metrics: this.metrics(),
    });
  }

  checksumState() {
    return Object.freeze({
      revision: this.revision,
      roleByCell: this.roleByCell.slice(),
      useByCell: this.useByCell.slice(),
      loadByCell: this.loadByCell.slice(),
      reservedAtByCell: this.reservedAtByCell.slice(),
      formingByCell: this.formingByCell.slice(),
      belowThresholdByCell: this.belowThresholdByCell.slice(),
      pressureByCell: this.pressureByCell.slice(),
      pressureAxisXByCell: this.pressureAxisXByCell.slice(),
      pressureAxisYByCell: this.pressureAxisYByCell.slice(),
      pressurePointXByCell: this.pressurePointXByCell.slice(),
      pressurePointYByCell: this.pressurePointYByCell.slice(),
      easementByCell: this.easementByCell.slice(),
      easementUseByCell: this.easementUseByCell.slice(),
      easementFormationByCell: this.easementFormationByCell.slice(),
      acquiredByCell: this.acquiredByCell.slice(),
      journeys: freezeArray([...this.journeyByAgent.entries()]
        .sort((first, second) => first[0] - second[0])
        .map(([agentId, journey]) => Object.freeze({ agentId, ...journey }))),
      flowSegments: freezeArray([...this.flowSegments.values()]
        .sort((first, second) => compareIds(first.key, second.key))
        .map((segment) => Object.freeze({ ...segment }))),
      counters: Object.freeze({ ...this.counters }),
      events: this.lastEvents,
    });
  }
}
