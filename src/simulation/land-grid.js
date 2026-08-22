import { keyedRandom } from "./prng.js";

const DEFAULT_WORLD_WIDTH = 1_000;
const DEFAULT_WORLD_HEIGHT = 650;
const DEFAULT_CELL_SIZE = 28;
const MAX_AXIS_CELLS = 256;
const MAX_CELL_COUNT = 16_384;
const MAX_TICKS = 1_000_000;
const MAX_BID = 1_000_000_000;
const EMPTY = -1;
const EDGE_ORDER = Object.freeze(["north", "east", "south", "west"]);
const EDGE_ALIASES = Object.freeze({
  top: "north",
  right: "east",
  bottom: "south",
  left: "west",
});
const transitionStates = new WeakMap();

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finiteOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const integerIn = (value, fallback, minimum, maximum) => clamp(
  Math.round(finiteOr(value, fallback)),
  minimum,
  maximum,
);

function freezeArray(values) {
  return Object.freeze(values);
}

function normalizeSources(input, worldWidth, worldHeight) {
  return freezeArray((Array.isArray(input) ? input : [])
    .map((source) => {
      const x = Number(source?.x ?? source?.position?.x);
      const y = Number(source?.y ?? source?.position?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return Object.freeze({
        x: clamp(x, 0, worldWidth),
        y: clamp(y, 0, worldHeight),
        strength: Math.max(0, finiteOr(source?.strength, 1)),
      });
    })
    .filter(Boolean)
    .sort((first, second) => first.x - second.x || first.y - second.y || first.strength - second.strength));
}

function normalizeProximity(input, worldWidth, worldHeight) {
  const source = input && typeof input === "object" ? input : {};
  return Object.freeze({
    sources: normalizeSources(source.sources, worldWidth, worldHeight),
    falloff: clamp(finiteOr(source.falloff, 180), 1, Math.max(worldWidth, worldHeight) * 4),
  });
}

function normalizeFrontageEdges(input) {
  const requested = new Set((Array.isArray(input) ? input : [])
    .map((edge) => String(edge).toLowerCase())
    .map((edge) => EDGE_ALIASES[edge] ?? edge)
    .filter((edge) => EDGE_ORDER.includes(edge)));
  return freezeArray(EDGE_ORDER.filter((edge) => requested.has(edge)));
}

function proximityAt(point, definition) {
  let score = 0;
  for (const source of definition.sources) {
    const distance = Math.hypot(point.x - source.x, point.y - source.y);
    score += source.strength * Math.exp(-distance / definition.falloff);
  }
  return clamp(score, 0, 1);
}

function landCellId(row, column) {
  return `land-${row}-${column}`;
}

function cellNeighborIds(row, column, rows, columns) {
  const neighbors = [];
  if (row > 0) neighbors.push(landCellId(row - 1, column));
  if (column + 1 < columns) neighbors.push(landCellId(row, column + 1));
  if (row + 1 < rows) neighbors.push(landCellId(row + 1, column));
  if (column > 0) neighbors.push(landCellId(row, column - 1));
  return freezeArray(neighbors);
}

function cellFrontageEdges(row, column, rows, columns, configuredEdges) {
  const matches = [];
  if (row === 0 && configuredEdges.includes("north")) matches.push("north");
  if (column === columns - 1 && configuredEdges.includes("east")) matches.push("east");
  if (row === rows - 1 && configuredEdges.includes("south")) matches.push("south");
  if (column === 0 && configuredEdges.includes("west")) matches.push("west");
  return freezeArray(matches);
}

/**
 * Normalize the authoring schema into immutable, bounded row-major geometry.
 * Passing the normalized result through this function again produces the same
 * public value, which lets SimulationEngine reset an already-normalized world.
 */
export function normalizeLandConfig(input, worldWidth, worldHeight) {
  if (!input || typeof input !== "object") return null;

  const boundedWorldWidth = Math.max(1, finiteOr(worldWidth, input.geometry?.worldWidth ?? DEFAULT_WORLD_WIDTH));
  const boundedWorldHeight = Math.max(1, finiteOr(worldHeight, input.geometry?.worldHeight ?? DEFAULT_WORLD_HEIGHT));
  const geometryInput = input.geometry && typeof input.geometry === "object" ? input.geometry : input;
  const originInput = input.origin ?? geometryInput.origin ?? {};
  const cellSize = clamp(
    finiteOr(input.cellSize ?? geometryInput.cellSize, DEFAULT_CELL_SIZE),
    2,
    Math.min(boundedWorldWidth, boundedWorldHeight),
  );
  const gap = clamp(finiteOr(input.gap ?? geometryInput.gap, 0), 0, cellSize * 2);
  const pitch = cellSize + gap;
  const x = clamp(
    finiteOr(originInput.x ?? geometryInput.x, 0),
    0,
    Math.max(0, boundedWorldWidth - cellSize),
  );
  const y = clamp(
    finiteOr(originInput.y ?? geometryInput.y, 0),
    0,
    Math.max(0, boundedWorldHeight - cellSize),
  );
  const maximumColumns = Math.max(1, Math.min(
    MAX_AXIS_CELLS,
    Math.floor((boundedWorldWidth - x + gap) / pitch),
  ));
  const requestedColumns = integerIn(input.columns ?? geometryInput.columns, 12, 1, maximumColumns);
  const maximumRowsByCount = Math.max(1, Math.floor(MAX_CELL_COUNT / requestedColumns));
  const maximumRows = Math.max(1, Math.min(
    MAX_AXIS_CELLS,
    maximumRowsByCount,
    Math.floor((boundedWorldHeight - y + gap) / pitch),
  ));
  const columns = requestedColumns;
  const rows = integerIn(input.rows ?? geometryInput.rows, 8, 1, maximumRows);
  const width = columns * cellSize + Math.max(0, columns - 1) * gap;
  const height = rows * cellSize + Math.max(0, rows - 1) * gap;

  const attributesInput = input.attributes && typeof input.attributes === "object" ? input.attributes : {};
  const access = normalizeProximity(attributesInput.access, boundedWorldWidth, boundedWorldHeight);
  const amenity = normalizeProximity(attributesInput.amenity, boundedWorldWidth, boundedWorldHeight);
  const terrainInput = attributesInput.terrain && typeof attributesInput.terrain === "object"
    ? attributesInput.terrain
    : {};
  const terrain = Object.freeze({
    seed: Number(terrainInput.seed ?? 0) >>> 0,
    variation: clamp(finiteOr(terrainInput.variation, 0), 0, 1),
  });
  const costInput = attributesInput.cost && typeof attributesInput.cost === "object"
    ? attributesInput.cost
    : {};
  const cost = Object.freeze({
    base: Math.max(0, finiteOr(costInput.base, 1)),
    accessMultiplier: finiteOr(costInput.accessMultiplier, 0),
    amenityMultiplier: finiteOr(costInput.amenityMultiplier, 0),
  });
  const frontageInput = attributesInput.frontage && typeof attributesInput.frontage === "object"
    ? attributesInput.frontage
    : {};
  const frontage = Object.freeze({ edges: normalizeFrontageEdges(frontageInput.edges) });
  const attributes = Object.freeze({ access, amenity, terrain, cost, frontage });

  const policyInput = input.policy && typeof input.policy === "object" ? input.policy : {};
  const reservationTicks = integerIn(policyInput.reservationTicks, 15, 0, MAX_TICKS);
  const expiryTicks = integerIn(
    policyInput.expiryTicks ?? policyInput.reservationExpiryTicks,
    Math.max(60, reservationTicks + 1),
    reservationTicks + 1,
    MAX_TICKS + 1,
  );
  const policy = Object.freeze({
    reservationTicks,
    expiryTicks,
    requireContiguous: policyInput.requireContiguous !== false,
    // The first slice intentionally guarantees a single active reservation.
    maxReservationsPerOwner: 1,
  });

  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const cellX = x + column * pitch;
      const cellY = y + row * pitch;
      const center = Object.freeze({ x: cellX + cellSize / 2, y: cellY + cellSize / 2 });
      const accessValue = proximityAt(center, access);
      const amenityValue = proximityAt(center, amenity);
      const terrainValue = clamp(
        0.5 + (keyedRandom(terrain.seed, row, column, "land-terrain") - 0.5) * terrain.variation,
        0,
        1,
      );
      const frontageEdges = cellFrontageEdges(row, column, rows, columns, frontage.edges);
      cells.push(Object.freeze({
        id: landCellId(row, column),
        index,
        row,
        column,
        x: cellX,
        y: cellY,
        width: cellSize,
        height: cellSize,
        center,
        neighborIds: cellNeighborIds(row, column, rows, columns),
        access: accessValue,
        amenity: amenityValue,
        terrain: terrainValue,
        cost: Math.max(0, cost.base + accessValue * cost.accessMultiplier + amenityValue * cost.amenityMultiplier),
        frontage: frontageEdges.length * cellSize,
        frontageEdges,
      }));
    }
  }

  const geometry = Object.freeze({
    type: "grid",
    x,
    y,
    origin: Object.freeze({ x, y }),
    cellSize,
    gap,
    pitch,
    columns,
    rows,
    width,
    height,
    worldWidth: boundedWorldWidth,
    worldHeight: boundedWorldHeight,
  });

  return Object.freeze({
    enabled: input.enabled !== false,
    geometry,
    attributes,
    policy,
    cells: freezeArray(cells),
  });
}

function intentError(message) {
  return Object.freeze({ ok: false, intent: null, error: message });
}

/** Parse only the optional land part of a behavior decision. */
export function parseLandIntent(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return intentError("behave() must return an object before land intents can be read.");
  }
  const hasReserve = decision.reserveLand !== undefined && decision.reserveLand !== null;
  const hasClaim = decision.claimLand !== undefined && decision.claimLand !== null;
  if (!hasReserve && !hasClaim) return Object.freeze({ ok: true, intent: null, error: null });
  if (hasReserve && hasClaim) {
    return intentError("behave() may return reserveLand or claimLand, but not both in one tick.");
  }

  const proposed = hasReserve ? decision.reserveLand : decision.claimLand;
  if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) {
    return intentError(`${hasReserve ? "reserveLand" : "claimLand"} must be an object.`);
  }
  if (typeof proposed.landId !== "string" || proposed.landId.trim().length === 0) {
    return intentError(`${hasReserve ? "reserveLand" : "claimLand"}.landId must be a non-empty string.`);
  }

  if (hasClaim) {
    return Object.freeze({
      ok: true,
      intent: Object.freeze({ type: "claim", landId: proposed.landId }),
      error: null,
    });
  }

  const bid = proposed.bid === undefined ? 0 : Number(proposed.bid);
  if (!Number.isFinite(bid) || bid < 0 || bid > MAX_BID) {
    return intentError(`reserveLand.bid must be a finite number from 0 to ${MAX_BID}.`);
  }
  return Object.freeze({
    ok: true,
    intent: Object.freeze({ type: "reserve", landId: proposed.landId, bid }),
    error: null,
  });
}

function frozenEvent(event) {
  return Object.freeze(event);
}

function copyCounters(counters) {
  return {
    reservations: counters.reservations,
    claims: counters.claims,
    conflicts: counters.conflicts,
    expiries: counters.expiries,
    rejected: counters.rejected,
    roadLandConflicts: counters.roadLandConflicts ?? 0,
    roadPreemptions: counters.roadPreemptions ?? 0,
  };
}

function rejection(events, counters, tick, ownerId, landId, action, reason) {
  counters.rejected += 1;
  events.push(frozenEvent({ type: "rejection", tick, ownerId, landId, action, reason }));
}

export class LandGridState {
  #indexById;
  #dynamicCache;
  #parcelCache;

  constructor(config, { seed = 0, worldWidth, worldHeight } = {}) {
    this.config = normalizeLandConfig(config, worldWidth, worldHeight);
    if (!this.config) throw new TypeError("LandGridState requires a land configuration object.");
    this.seed = Number(seed) >>> 0;
    this.#indexById = new Map(this.config.cells.map((cell) => [cell.id, cell.index]));
    this.reset();
  }

  reset() {
    const length = this.config.cells.length;
    this.ownerByCell = new Int32Array(length).fill(EMPTY);
    this.reservedByCell = new Int32Array(length).fill(EMPTY);
    this.reservedAtByCell = new Int32Array(length).fill(EMPTY);
    this.claimableAtByCell = new Int32Array(length).fill(EMPTY);
    this.expiresAtByCell = new Int32Array(length).fill(EMPTY);
    this.reservationBidByCell = new Float64Array(length);
    this.counters = {
      reservations: 0,
      claims: 0,
      conflicts: 0,
      expiries: 0,
      rejected: 0,
      roadLandConflicts: 0,
      roadPreemptions: 0,
    };
    this.lastEvents = freezeArray([]);
    this.revision = 0;
    this.#dynamicCache = null;
    this.#parcelCache = null;
    return this.frame(0);
  }

  #dynamicCells() {
    if (this.#dynamicCache?.revision === this.revision) return this.#dynamicCache.cells;
    const contested = new Set(this.lastEvents
      .filter((event) => event.type === "conflict")
      .map((event) => event.landId));
    const cells = freezeArray(this.config.cells.map((cell) => {
      const ownerId = this.ownerByCell[cell.index];
      const reservedBy = this.reservedByCell[cell.index];
      return Object.freeze({
        ...cell,
        state: ownerId !== EMPTY ? "claimed" : reservedBy !== EMPTY ? "reserved" : "unclaimed",
        ownerId: ownerId === EMPTY ? null : ownerId,
        parcelId: ownerId === EMPTY ? null : `parcel-${ownerId}`,
        reservedBy: reservedBy === EMPTY ? null : reservedBy,
        reservedAt: this.reservedAtByCell[cell.index] === EMPTY ? null : this.reservedAtByCell[cell.index],
        claimableAt: this.claimableAtByCell[cell.index] === EMPTY ? null : this.claimableAtByCell[cell.index],
        expiresAt: this.expiresAtByCell[cell.index] === EMPTY ? null : this.expiresAtByCell[cell.index],
        reservationBid: reservedBy === EMPTY ? null : this.reservationBidByCell[cell.index],
        contested: contested.has(cell.id),
      });
    }));
    this.#dynamicCache = { revision: this.revision, cells };
    return cells;
  }

  viewFor(ownerId, tick = 0) {
    const id = Number(ownerId);
    if (!Number.isSafeInteger(id) || id < 0) throw new TypeError("A land view requires a non-negative integer owner ID.");
    const currentTick = Math.max(0, Math.round(finiteOr(tick, 0)));
    const cells = freezeArray(this.#dynamicCells());
    const byId = new Map(cells.map((cell) => [cell.id, cell]));
    const mine = freezeArray(cells.filter((cell) => cell.ownerId === id).map((cell) => cell.id));
    const reserved = cells.find((cell) => cell.reservedBy === id) ?? null;
    const reservation = reserved ? Object.freeze({
      landId: reserved.id,
      reservedAt: reserved.reservedAt,
      claimableAt: reserved.claimableAt,
      expiresAt: reserved.expiresAt,
      claimable: currentTick >= reserved.claimableAt && currentTick < reserved.expiresAt,
    }) : null;
    return Object.freeze({
      enabled: this.config.enabled,
      cells,
      mine,
      reservation,
      policy: this.config.policy,
      cell: (landId) => byId.get(String(landId)) ?? null,
      neighbors: (landId) => {
        const cell = byId.get(String(landId));
        if (!cell) return freezeArray([]);
        return freezeArray(cell.neighborIds.map((neighborId) => byId.get(neighborId)));
      },
    });
  }

  #hasOwnedCell(ownerId, owners = this.ownerByCell) {
    return owners.includes(ownerId);
  }

  #hasReservation(ownerId, reservations = this.reservedByCell) {
    return reservations.includes(ownerId);
  }

  #isContiguousAddition(ownerId, index, owners = this.ownerByCell) {
    if (!this.config.policy.requireContiguous || !this.#hasOwnedCell(ownerId, owners)) return true;
    const cell = this.config.cells[index];
    return cell.neighborIds.some((neighborId) => owners[this.#indexById.get(neighborId)] === ownerId);
  }

  /**
   * Produce a complete next tenure state without mutating this store. Intents
   * must be parsed first and have shape `{ agentId, type, landId, bid? }`.
   */
  stage(intents, tick = 0, coordination = {}) {
    if (!Array.isArray(intents)) {
      return Object.freeze({ ok: false, error: "Land intents must be supplied as an array.", events: freezeArray([]) });
    }
    const currentTick = Math.max(0, Math.round(finiteOr(tick, 0)));
    const nextTick = currentTick + 1;
    const submissions = [];
    const seenOwners = new Set();
    for (const submitted of intents) {
      const agentId = Number(submitted?.agentId ?? submitted?.ownerId);
      const type = submitted?.type;
      if (!Number.isSafeInteger(agentId) || agentId < 0) {
        return Object.freeze({ ok: false, error: "Every land intent requires a non-negative integer agentId.", events: freezeArray([]) });
      }
      if (seenOwners.has(agentId)) {
        return Object.freeze({ ok: false, error: `Agent ${agentId} submitted more than one land intent.`, events: freezeArray([]) });
      }
      if ((type !== "reserve" && type !== "claim") || typeof submitted.landId !== "string") {
        return Object.freeze({ ok: false, error: `Agent ${agentId} submitted a malformed land intent.`, events: freezeArray([]) });
      }
      const bid = type === "reserve" ? Number(submitted.bid ?? 0) : 0;
      if (!Number.isFinite(bid) || bid < 0 || bid > MAX_BID) {
        return Object.freeze({ ok: false, error: `Agent ${agentId} submitted an invalid land bid.`, events: freezeArray([]) });
      }
      seenOwners.add(agentId);
      submissions.push({ agentId, type, landId: submitted.landId, bid });
    }

    if (!coordination || typeof coordination !== "object") {
      return Object.freeze({ ok: false, error: "Land coordination must be an object.", events: freezeArray([]) });
    }
    const publicCellsInput = Array.isArray(coordination.publicCells) ? coordination.publicCells : [];
    const publicCells = new Set(publicCellsInput.map((landId) => String(landId)));
    const publicCandidates = new Map();
    for (const submitted of Array.isArray(coordination.publicCandidates)
      ? coordination.publicCandidates
      : []) {
      const landId = typeof submitted?.landId === "string" ? submitted.landId : "";
      const bid = Number(submitted?.bid ?? submitted?.use ?? 0);
      if (!landId || !Number.isFinite(bid) || bid < 0 || bid > MAX_BID) {
        return Object.freeze({ ok: false, error: "Public-way candidates require a landId and a finite non-negative bid.", events: freezeArray([]) });
      }
      if (publicCandidates.has(landId)) {
        return Object.freeze({ ok: false, error: `Public way ${landId} was submitted more than once.`, events: freezeArray([]) });
      }
      publicCandidates.set(landId, Object.freeze({ ...submitted, landId, bid }));
    }

    const owners = this.ownerByCell.slice();
    const reservations = this.reservedByCell.slice();
    const reservedAt = this.reservedAtByCell.slice();
    const claimableAt = this.claimableAtByCell.slice();
    const expiresAt = this.expiresAtByCell.slice();
    const reservationBids = this.reservationBidByCell.slice();
    const counters = copyCounters(this.counters);
    const events = [];
    const acceptedPublic = new Set();
    const rejectedPublic = new Set();

    if (this.config.enabled) {
      // A movement-derived public reservation and private tenure share one
      // arbitration boundary. Claimed land is never expropriated. An existing
      // private reservation remains contestable until it becomes a claim.
      for (const landId of [...publicCandidates.keys()].sort()) {
        const candidate = publicCandidates.get(landId);
        const index = this.#indexById.get(landId);
        if (index === undefined || owners[index] !== EMPTY || publicCells.has(landId)) {
          rejectedPublic.add(landId);
          continue;
        }
        const privateOwner = reservations[index];
        if (privateOwner === EMPTY) continue;
        const privateBid = reservationBids[index];
        const publicRank = keyedRandom(this.seed, currentTick, landId, "public-way", "road-land-tie");
        const privateRank = keyedRandom(this.seed, currentTick, landId, privateOwner, "road-land-tie");
        const publicWins = candidate.bid > privateBid
          || (candidate.bid === privateBid && (publicRank > privateRank
            || (publicRank === privateRank && String("public-way").localeCompare(String(privateOwner)) < 0)));
        counters.roadLandConflicts += 1;
        events.push(frozenEvent({
          type: "road-land-conflict",
          tick: nextTick,
          landId,
          publicBid: candidate.bid,
          privateBid,
          privateOwner,
          winner: publicWins ? "public" : "private",
        }));
        if (!publicWins) {
          rejectedPublic.add(landId);
          continue;
        }
        reservations[index] = EMPTY;
        reservedAt[index] = EMPTY;
        claimableAt[index] = EMPTY;
        expiresAt[index] = EMPTY;
        reservationBids[index] = 0;
        acceptedPublic.add(landId);
        counters.roadPreemptions += 1;
        events.push(frozenEvent({
          type: "road-preemption",
          tick: nextTick,
          landId,
          ownerId: privateOwner,
        }));
      }

      const claims = submissions.filter((intent) => intent.type === "claim")
        .sort((first, second) => first.agentId - second.agentId || first.landId.localeCompare(second.landId));
      for (const intent of claims) {
        const index = this.#indexById.get(intent.landId);
        let reason = null;
        if (index === undefined) reason = "unknown-land";
        else if (publicCells.has(intent.landId) || acceptedPublic.has(intent.landId)) reason = "public-way";
        else if (owners[index] !== EMPTY) reason = "already-claimed";
        else if (reservations[index] !== intent.agentId) reason = "not-reservation-owner";
        else if (currentTick < claimableAt[index]) reason = "not-mature";
        else if (currentTick >= expiresAt[index]) reason = "expired";
        else if (!this.#isContiguousAddition(intent.agentId, index)) reason = "not-contiguous";
        if (reason) {
          rejection(events, counters, nextTick, intent.agentId, intent.landId, "claim", reason);
          continue;
        }
        owners[index] = intent.agentId;
        reservations[index] = EMPTY;
        reservedAt[index] = EMPTY;
        claimableAt[index] = EMPTY;
        expiresAt[index] = EMPTY;
        reservationBids[index] = 0;
        counters.claims += 1;
        events.push(frozenEvent({ type: "claim", tick: nextTick, ownerId: intent.agentId, landId: intent.landId }));
      }

      const reserveGroups = new Map();
      const reserves = submissions.filter((intent) => intent.type === "reserve")
        .sort((first, second) => first.landId.localeCompare(second.landId) || first.agentId - second.agentId);
      for (const intent of reserves) {
        const index = this.#indexById.get(intent.landId);
        let reason = null;
        if (index === undefined) reason = "unknown-land";
        else if (publicCells.has(intent.landId) || acceptedPublic.has(intent.landId)) reason = "public-way";
        else if (owners[index] !== EMPTY) reason = "already-claimed";
        else if (reservations[index] !== EMPTY) reason = "already-reserved";
        else if (this.#hasReservation(intent.agentId, reservations)) reason = "owner-already-reserved";
        else if (!this.#isContiguousAddition(intent.agentId, index)) reason = "not-contiguous";
        if (reason) {
          rejection(events, counters, nextTick, intent.agentId, intent.landId, "reserve", reason);
          continue;
        }
        if (!reserveGroups.has(intent.landId)) reserveGroups.set(intent.landId, []);
        reserveGroups.get(intent.landId).push(intent);
      }

      const contestedTargets = new Set([
        ...reserveGroups.keys(),
        ...[...publicCandidates.keys()].filter((landId) => !rejectedPublic.has(landId)),
      ]);
      for (const landId of [...contestedTargets].sort()) {
        const candidates = (reserveGroups.get(landId) || []).sort((first, second) => {
          if (first.bid !== second.bid) return second.bid - first.bid;
          const firstRank = keyedRandom(this.seed, currentTick, landId, first.agentId, "land-reservation-tie");
          const secondRank = keyedRandom(this.seed, currentTick, landId, second.agentId, "land-reservation-tie");
          return secondRank - firstRank || first.agentId - second.agentId;
        });
        const index = this.#indexById.get(landId);
        const publicCandidate = publicCandidates.get(landId);
        const publicEligible = publicCandidate
          && !rejectedPublic.has(landId)
          && !acceptedPublic.has(landId)
          && index !== undefined
          && owners[index] === EMPTY
          && reservations[index] === EMPTY
          && !publicCells.has(landId);
        const privateWinner = candidates[0] || null;

        let publicWins = Boolean(publicEligible && !privateWinner);
        if (publicEligible && privateWinner) {
          const publicRank = keyedRandom(this.seed, currentTick, landId, "public-way", "road-land-tie");
          const privateRank = keyedRandom(this.seed, currentTick, landId, privateWinner.agentId, "road-land-tie");
          publicWins = publicCandidate.bid > privateWinner.bid
            || (publicCandidate.bid === privateWinner.bid && (publicRank > privateRank
              || (publicRank === privateRank && String("public-way").localeCompare(String(privateWinner.agentId)) < 0)));
          counters.roadLandConflicts += 1;
          events.push(frozenEvent({
            type: "road-land-conflict",
            tick: nextTick,
            landId,
            publicBid: publicCandidate.bid,
            privateBid: privateWinner.bid,
            privateOwner: privateWinner.agentId,
            winner: publicWins ? "public" : "private",
          }));
        }

        if (publicWins) {
          acceptedPublic.add(landId);
          events.push(frozenEvent({
            type: "road-reservation",
            tick: nextTick,
            landId,
            bid: publicCandidate.bid,
          }));
          for (const contender of candidates) {
            rejection(events, counters, nextTick, contender.agentId, landId, "reserve", "lost-public-conflict");
          }
          continue;
        }
        if (!privateWinner) continue;

        const winner = privateWinner;
        if (candidates.length > 1) {
          counters.conflicts += 1;
          events.push(frozenEvent({
            type: "conflict",
            tick: nextTick,
            landId,
            ownerId: winner.agentId,
            contenders: freezeArray(candidates.map((candidate) => candidate.agentId).sort((a, b) => a - b)),
          }));
        }
        reservations[index] = winner.agentId;
        reservedAt[index] = nextTick;
        claimableAt[index] = nextTick + this.config.policy.reservationTicks;
        expiresAt[index] = nextTick + this.config.policy.expiryTicks;
        reservationBids[index] = winner.bid;
        counters.reservations += 1;
        events.push(frozenEvent({
          type: "reservation",
          tick: nextTick,
          ownerId: winner.agentId,
          landId,
          bid: winner.bid,
          claimableAt: claimableAt[index],
          expiresAt: expiresAt[index],
        }));
        for (const loser of candidates.slice(1)) {
          rejection(events, counters, nextTick, loser.agentId, landId, "reserve", "lost-conflict");
        }
      }

      for (let index = 0; index < reservations.length; index += 1) {
        if (reservations[index] === EMPTY || expiresAt[index] > nextTick) continue;
        const ownerId = reservations[index];
        reservations[index] = EMPTY;
        reservedAt[index] = EMPTY;
        claimableAt[index] = EMPTY;
        expiresAt[index] = EMPTY;
        reservationBids[index] = 0;
        counters.expiries += 1;
        events.push(frozenEvent({
          type: "expiry",
          tick: nextTick,
          ownerId,
          landId: this.config.cells[index].id,
        }));
      }
    }

    const frozenEvents = freezeArray(events);
    const acceptedPublicLandIds = freezeArray([...acceptedPublic].sort());
    const transition = Object.freeze({
      ok: true,
      error: null,
      events: frozenEvents,
      tick: nextTick,
      acceptedPublicLandIds,
    });
    transitionStates.set(transition, {
      source: this,
      baseRevision: this.revision,
      owners,
      reservations,
      reservedAt,
      claimableAt,
      expiresAt,
      reservationBids,
      counters,
      events: frozenEvents,
    });
    return transition;
  }

  commit(transition) {
    const next = transitionStates.get(transition);
    if (!next || next.source !== this) throw new TypeError("The land transition was not staged by this store.");
    if (next.baseRevision !== this.revision) throw new Error("The land transition is stale and cannot be committed.");
    this.ownerByCell = next.owners;
    this.reservedByCell = next.reservations;
    this.reservedAtByCell = next.reservedAt;
    this.claimableAtByCell = next.claimableAt;
    this.expiresAtByCell = next.expiresAt;
    this.reservationBidByCell = next.reservationBids;
    this.counters = next.counters;
    this.lastEvents = next.events;
    this.revision += 1;
    this.#dynamicCache = null;
    this.#parcelCache = null;
    transitionStates.delete(transition);
    return this.frame(transition.tick);
  }

  #parcels() {
    if (this.#parcelCache?.revision === this.revision) return this.#parcelCache.parcels;
    const cellsByOwner = new Map();
    for (const cell of this.config.cells) {
      const ownerId = this.ownerByCell[cell.index];
      if (ownerId === EMPTY) continue;
      if (!cellsByOwner.has(ownerId)) cellsByOwner.set(ownerId, []);
      cellsByOwner.get(ownerId).push(cell);
    }
    const parcels = freezeArray([...cellsByOwner.entries()]
      .sort(([first], [second]) => first - second)
      .map(([ownerId, cells]) => {
        let area = 0;
        let perimeter = 0;
        let frontage = 0;
        for (const cell of cells) {
          area += cell.width * cell.height;
          frontage += cell.frontage;
          for (const neighborId of cell.neighborIds) {
            const neighborIndex = this.#indexById.get(neighborId);
            if (this.ownerByCell[neighborIndex] !== ownerId) perimeter += cell.width;
          }
          perimeter += (4 - cell.neighborIds.length) * cell.width;
        }
        const compactness = perimeter > 0 ? clamp((4 * Math.PI * area) / (perimeter * perimeter), 0, 1) : 0;
        return Object.freeze({
          id: `parcel-${ownerId}`,
          ownerId,
          cellIds: freezeArray(cells.map((cell) => cell.id)),
          area,
          perimeter,
          compactness,
          frontage,
          landlocked: frontage <= 0,
        });
      }));
    this.#parcelCache = { revision: this.revision, parcels };
    return parcels;
  }

  metrics() {
    const parcels = this.#parcels();
    const claimedCells = this.ownerByCell.reduce((count, ownerId) => count + (ownerId !== EMPTY ? 1 : 0), 0);
    const reservedCells = this.reservedByCell.reduce((count, ownerId) => count + (ownerId !== EMPTY ? 1 : 0), 0);
    const meanParcelArea = parcels.length === 0
      ? 0
      : parcels.reduce((sum, parcel) => sum + parcel.area, 0) / parcels.length;
    const meanParcelCompactness = parcels.length === 0
      ? 0
      : parcels.reduce((sum, parcel) => sum + parcel.compactness, 0) / parcels.length;
    const ownershipConcentration = claimedCells === 0
      ? 0
      : parcels.reduce((sum, parcel) => sum + (parcel.cellIds.length / claimedCells) ** 2, 0);
    return Object.freeze({
      claimedCells,
      claimedShare: this.config.cells.length > 0 ? claimedCells / this.config.cells.length : 0,
      reservedCells,
      landOwners: parcels.length,
      parcelCount: parcels.length,
      meanParcelArea,
      meanParcelCompactness,
      ownershipConcentration,
      landReservations: this.counters.reservations,
      landClaims: this.counters.claims,
      landConflicts: this.counters.conflicts,
      landExpiries: this.counters.expiries,
      landRejectedActions: this.counters.rejected,
      roadLandConflicts: this.counters.roadLandConflicts,
      roadPreemptions: this.counters.roadPreemptions,
    });
  }

  frame(tick = 0) {
    return Object.freeze({
      geometry: this.config.geometry,
      enabled: this.config.enabled,
      cells: this.#dynamicCells(),
      parcels: this.#parcels(),
      policy: this.config.policy,
      events: this.lastEvents,
      metrics: this.metrics(),
      tick: Math.max(0, Math.round(finiteOr(tick, 0))),
    });
  }

  checksumState() {
    return Object.freeze({
      ownerByCell: this.ownerByCell.slice(),
      reservedByCell: this.reservedByCell.slice(),
      reservedAtByCell: this.reservedAtByCell.slice(),
      claimableAtByCell: this.claimableAtByCell.slice(),
      expiresAtByCell: this.expiresAtByCell.slice(),
      reservationBidByCell: this.reservationBidByCell.slice(),
      counters: Object.freeze(copyCounters(this.counters)),
      events: this.lastEvents,
    });
  }
}
