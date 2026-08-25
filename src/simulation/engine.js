import { keyedRandom, randomInteger, stateChecksum } from "./prng.js";
import { clampWorldPoint, equilateralApex, nearestEquilateralApex } from "./geometry.js";
import { ScalarField } from "./scalar-field.js";
import { LandGridState, normalizeLandConfig, parseLandIntent } from "./land-grid.js";
import { PublicCirculation, normalizeCirculationConfig } from "./public-circulation.js";
import { ParcelActivityDemand, normalizeParcelActivityConfig } from "./parcel-activity.js";

const DEFAULT_WIDTH = 1_000;
const DEFAULT_HEIGHT = 650;
const DEFAULT_STEP = 1 / 30;
const DEFAULT_MAX_ACCELERATION = 240;
const MAX_DELAY_TICKS = 120;
const EPSILON = 1e-8;

const finiteOr = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function magnitude(vector) {
  return Math.hypot(vector.x, vector.y);
}

function limitVector(vector, maximum) {
  const length = magnitude(vector);
  if (length <= maximum || length < EPSILON) return vector;
  const scale = maximum / length;
  return { x: vector.x * scale, y: vector.y * scale };
}

function frozenVector(x, y) {
  return Object.freeze({ x, y });
}

function normalizeEnvironment(environment, worldWidth, worldHeight) {
  if (!environment || typeof environment !== "object") return null;

  const destinations = Object.freeze((Array.isArray(environment.destinations) ? environment.destinations : [])
    .map((destination, index) => {
      const x = Number(destination?.x ?? destination?.position?.x);
      const y = Number(destination?.y ?? destination?.position?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return Object.freeze({
        id: String(destination.id ?? `destination-${index}`),
        label: String(destination.label ?? destination.name ?? destination.id ?? `Destination ${index + 1}`),
        x: clamp(x, 0, worldWidth),
        y: clamp(y, 0, worldHeight),
        radius: clamp(finiteOr(Number(destination.radius ?? destination.r), 18), 1, 200),
        weight: Math.max(0, finiteOr(Number(destination.weight ?? 1), 1)),
      });
    })
    .filter(Boolean));

  const obstacles = Object.freeze((Array.isArray(environment.obstacles) ? environment.obstacles : [])
    .map((obstacle, index) => {
      let x = Number(obstacle?.x ?? obstacle?.position?.x);
      let y = Number(obstacle?.y ?? obstacle?.position?.y);
      const width = Number(obstacle?.width ?? obstacle?.w ?? obstacle?.size?.width);
      const height = Number(obstacle?.height ?? obstacle?.h ?? obstacle?.size?.height);
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
      const right = clamp(x + width, 0, worldWidth);
      const bottom = clamp(y + height, 0, worldHeight);
      x = clamp(x, 0, worldWidth);
      y = clamp(y, 0, worldHeight);
      if (right <= x || bottom <= y) return null;
      return Object.freeze({
        id: String(obstacle.id ?? `obstacle-${index}`),
        label: String(obstacle.label ?? obstacle.name ?? obstacle.id ?? ""),
        x,
        y,
        width: right - x,
        height: bottom - y,
      });
    })
    .filter(Boolean));

  const journeyInput = environment.journeys ?? environment.journey ?? {};
  const journeys = Object.freeze({
    enabled: Boolean(journeyInput.enabled) && destinations.length > 1,
    spawnAtDestinations: Boolean(journeyInput.spawnAtDestinations),
    arrivalRadius: clamp(finiteOr(Number(journeyInput.arrivalRadius), 24), 1, 300),
  });
  const fieldInput = environment.field && typeof environment.field === "object"
    ? environment.field
    : null;
  const field = fieldInput && fieldInput.enabled !== false
    ? Object.freeze({
      enabled: true,
      cellSize: clamp(finiteOr(Number(fieldInput.cellSize), 16), 2, Math.max(worldWidth, worldHeight)),
      deposit: clamp(finiteOr(Number(fieldInput.deposit), 1), 0, 1_000),
      decay: clamp(finiteOr(Number(fieldInput.decay), 0), 0, 1),
      persistence: fieldInput.persistence === undefined || fieldInput.persistence === null
        ? null
        : clamp(finiteOr(Number(fieldInput.persistence), 1), 0, 1),
      diffusion: clamp(finiteOr(Number(fieldInput.diffusion), 0), 0, 1),
    })
    : null;

  const land = normalizeLandConfig(environment.land, worldWidth, worldHeight);
  const circulation = normalizeCirculationConfig(environment.circulation);
  const activity = normalizeParcelActivityConfig(environment.activity ?? environment.activities);

  return Object.freeze({ destinations, obstacles, journeys, field, land, circulation, activity });
}

function resolveCircleAgainstRectangle(position, velocity, radius, rectangle) {
  const right = rectangle.x + rectangle.width;
  const bottom = rectangle.y + rectangle.height;
  const nearestX = clamp(position.x, rectangle.x, right);
  const nearestY = clamp(position.y, rectangle.y, bottom);
  let dx = position.x - nearestX;
  let dy = position.y - nearestY;
  const distanceSquared = dx * dx + dy * dy;
  if (distanceSquared >= radius * radius) return { position, velocity, collided: false };

  let normalX;
  let normalY;
  let penetration;
  if (distanceSquared > EPSILON) {
    const distance = Math.sqrt(distanceSquared);
    normalX = dx / distance;
    normalY = dy / distance;
    penetration = radius - distance;
  } else {
    const candidates = [
      { distance: position.x - rectangle.x, x: -1, y: 0 },
      { distance: right - position.x, x: 1, y: 0 },
      { distance: position.y - rectangle.y, x: 0, y: -1 },
      { distance: bottom - position.y, x: 0, y: 1 },
    ].sort((a, b) => a.distance - b.distance);
    normalX = candidates[0].x;
    normalY = candidates[0].y;
    penetration = radius + candidates[0].distance;
  }

  const resolvedPosition = {
    x: position.x + normalX * penetration,
    y: position.y + normalY * penetration,
  };
  const normalSpeed = velocity.x * normalX + velocity.y * normalY;
  if (normalSpeed >= 0) return { position: resolvedPosition, velocity, collided: true };
  return {
    position: resolvedPosition,
    velocity: {
      x: velocity.x - normalX * normalSpeed * 1.3,
      y: velocity.y - normalY * normalSpeed * 1.3,
    },
    collided: true,
  };
}

function easementProjection(point, easement, extension = 0) {
  const dx = finiteOr(easement?.x2) - finiteOr(easement?.x1);
  const dy = finiteOr(easement?.y2) - finiteOr(easement?.y1);
  const length = Math.hypot(dx, dy);
  if (length <= EPSILON) {
    const x = finiteOr(easement?.x1);
    const y = finiteOr(easement?.y1);
    return { x, y, distance: Math.hypot(point.x - x, point.y - y), unitX: 1, unitY: 0 };
  }
  const unitX = dx / length;
  const unitY = dy / length;
  const startX = finiteOr(easement.x1) - unitX * extension;
  const startY = finiteOr(easement.y1) - unitY * extension;
  const extendedLength = length + extension * 2;
  const distanceAlong = clamp(
    (point.x - startX) * unitX + (point.y - startY) * unitY,
    0,
    extendedLength,
  );
  const x = startX + unitX * distanceAlong;
  const y = startY + unitY * distanceAlong;
  return {
    x,
    y,
    distance: Math.hypot(point.x - x, point.y - y),
    unitX,
    unitY,
  };
}

function resolveCircleAgainstPrivateObstacle(previous, position, velocity, radius, rectangle) {
  if (!rectangle.easement) {
    return resolveCircleAgainstRectangle(position, velocity, radius, rectangle);
  }
  const solidCollision = resolveCircleAgainstRectangle(position, velocity, radius, rectangle);
  if (!solidCollision.collided) return solidCollision;

  // Easement width is the legal centreline envelope for walkers. Extending
  // the surveyed segment by one body radius lets a circle enter cleanly at a
  // parcel boundary without making the rest of that boundary permeable.
  const halfWidth = Math.max(1, finiteOr(rectangle.easement.width, 1) / 2);
  const extension = radius + halfWidth + 1;
  const currentProjection = easementProjection(position, rectangle.easement, extension);
  if (currentProjection.distance <= halfWidth + EPSILON) {
    return { position, velocity, collided: false };
  }

  const previousProjection = easementProjection(previous, rectangle.easement, extension);
  if (previousProjection.distance > halfWidth + EPSILON) return solidCollision;

  // A walker already inside the right-of-way meets the corridor edge rather
  // than being expelled to the parcel's outer face when steering drifts.
  let normalX = position.x - currentProjection.x;
  let normalY = position.y - currentProjection.y;
  const normalLength = Math.hypot(normalX, normalY);
  if (normalLength <= EPSILON) {
    normalX = -currentProjection.unitY;
    normalY = currentProjection.unitX;
  } else {
    normalX /= normalLength;
    normalY /= normalLength;
  }
  const resolvedPosition = {
    x: currentProjection.x + normalX * halfWidth,
    y: currentProjection.y + normalY * halfWidth,
  };
  const normalSpeed = velocity.x * normalX + velocity.y * normalY;
  return {
    position: resolvedPosition,
    velocity: normalSpeed <= 0
      ? velocity
      : {
        x: velocity.x - normalX * normalSpeed * 1.3,
        y: velocity.y - normalY * normalSpeed * 1.3,
      },
    collided: true,
  };
}

function chooseOther(seed, agentId, population, key, excluded = new Set()) {
  if (population <= excluded.size) return agentId;
  let candidate = randomInteger(seed, 0, population, agentId, key);
  for (let attempts = 0; attempts < population; attempts += 1) {
    if (!excluded.has(candidate)) return candidate;
    candidate = (candidate + 1) % population;
  }
  return agentId;
}

function compareDestinationIds(first, second) {
  if (first.id < second.id) return -1;
  if (first.id > second.id) return 1;
  return 0;
}

function chooseNextDestination(seed, agentId, arrivalCount, destinations, currentDestinationId) {
  const candidates = destinations
    .filter((destination) => destination.id !== currentDestinationId)
    .sort(compareDestinationIds);
  if (candidates.length === 0) return null;

  // Scaling by the largest weight keeps the sum finite even for unusually
  // large (but otherwise valid) weights without changing their proportions.
  const largestWeight = candidates.reduce(
    (maximum, destination) => Math.max(maximum, destination.weight),
    0,
  );
  const random = keyedRandom(seed, agentId, arrivalCount, "journey-destination");
  if (largestWeight <= 0) {
    return candidates[Math.floor(random * candidates.length)];
  }

  const total = candidates.reduce(
    (sum, destination) => sum + destination.weight / largestWeight,
    0,
  );
  let cursor = random * total;
  for (const destination of candidates) {
    if (destination.weight <= 0) continue;
    cursor -= destination.weight / largestWeight;
    if (cursor < 0) return destination;
  }

  // Floating point rounding can only reach here at the upper edge. Choose the
  // final positive candidate, never a zero-weight one.
  return candidates.findLast((destination) => destination.weight > 0);
}

export class SimulationEngine {
  constructor({
    behavior,
    seed = 2026,
    population = 72,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    dt = DEFAULT_STEP,
    params = {},
    relationMode = "midpoint",
    ruleKey = "",
    environment = null,
  }) {
    if (typeof behavior !== "function") throw new TypeError("A behavior function is required.");

    this.behavior = behavior;
    this.seed = Number(seed) >>> 0;
    this.population = clamp(Math.round(population), 3, 2_000);
    this.width = Math.max(100, finiteOr(width, DEFAULT_WIDTH));
    this.height = Math.max(100, finiteOr(height, DEFAULT_HEIGHT));
    this.dt = clamp(finiteOr(dt, DEFAULT_STEP), 1 / 240, 1);
    this.params = { ...params };
    this.relationMode = relationMode;
    this.ruleKey = String(ruleKey);
    this.environment = normalizeEnvironment(environment, this.width, this.height);
    this.field = this.environment?.field ? new ScalarField(this.width, this.height, this.environment.field) : null;
    this.land = this.environment?.land
      ? new LandGridState(this.environment.land, { seed: this.seed, worldWidth: this.width, worldHeight: this.height })
      : null;
    this.circulation = this.environment?.circulation && this.land
      ? new PublicCirculation(this.environment.circulation, {
        land: this.land,
        seed: this.seed,
        worldWidth: this.width,
        worldHeight: this.height,
      })
      : null;
    this.activity = this.environment?.activity && this.land && this.circulation
      ? new ParcelActivityDemand(this.environment.activity, {
        land: this.land,
        circulation: this.circulation,
        seed: this.seed,
        worldWidth: this.width,
        worldHeight: this.height,
      })
      : null;
    this.journeyDestinations = Object.freeze([]);
    this.destinationById = new Map();
    this.trips = 0;
    this.tick = 0;
    this.lastError = null;
    this.agents = [];
    this.observationHistory = [];
    this.interventions = [];
    this.eventCursor = 0;
    this.reset();
  }

  reset({
    seed = this.seed,
    population = this.population,
    params = this.params,
    environment = this.environment,
  } = {}) {
    this.seed = Number(seed) >>> 0;
    this.population = clamp(Math.round(population), 3, 2_000);
    this.params = { ...params };
    this.environment = normalizeEnvironment(environment, this.width, this.height);
    this.field = this.environment?.field ? new ScalarField(this.width, this.height, this.environment.field) : null;
    this.land = this.environment?.land
      ? new LandGridState(this.environment.land, { seed: this.seed, worldWidth: this.width, worldHeight: this.height })
      : null;
    this.circulation = this.environment?.circulation && this.land
      ? new PublicCirculation(this.environment.circulation, {
        land: this.land,
        seed: this.seed,
        worldWidth: this.width,
        worldHeight: this.height,
      })
      : null;
    this.activity = this.environment?.activity && this.land && this.circulation
      ? new ParcelActivityDemand(this.environment.activity, {
        land: this.land,
        circulation: this.circulation,
        seed: this.seed,
        worldWidth: this.width,
        worldHeight: this.height,
      })
      : null;
    this.#refreshJourneyDestinations();
    this.trips = 0;
    this.tick = 0;
    this.lastError = null;
    this.agents = this.#createAgents();
    this.observationHistory = [];
    this.interventions = [];
    this.eventCursor = 0;
    this.#recordObservation();
    return this.frame();
  }

  setBehavior(behavior, ruleKey = this.ruleKey) {
    if (typeof behavior !== "function") throw new TypeError("A behavior function is required.");
    this.behavior = behavior;
    this.ruleKey = String(ruleKey);
  }

  setRelationMode(relationMode) {
    this.relationMode = relationMode;
  }

  #createAgents() {
    const margin = 55;
    const usableWidth = Math.max(1, this.width - margin * 2);
    const usableHeight = Math.max(1, this.height - margin * 2);
    const radius = clamp(9 - Math.sqrt(this.population) * 0.16, 5.5, 7.8);

    return Array.from({ length: this.population }, (_, id) => {
      const journeys = this.environment?.journeys;
      const destinations = this.environment?.destinations || [];
      const spawnIndex = destinations.length > 0 ? id % destinations.length : -1;
      const spawn = journeys?.enabled && journeys.spawnAtDestinations ? destinations[spawnIndex] : null;
      const spawnAngle = keyedRandom(this.seed, id, "spawn-angle") * Math.PI * 2;
      const spawnRadius = spawn
        ? Math.sqrt(keyedRandom(this.seed, id, "spawn-radius")) * Math.max(1, spawn.radius * 0.55)
        : 0;
      const x = spawn
        ? clamp(spawn.x + Math.cos(spawnAngle) * spawnRadius, radius, this.width - radius)
        : margin + keyedRandom(this.seed, id, "initial-x") * usableWidth;
      const y = spawn
        ? clamp(spawn.y + Math.sin(spawnAngle) * spawnRadius, radius, this.height - radius)
        : margin + keyedRandom(this.seed, id, "initial-y") * usableHeight;
      const angle = keyedRandom(this.seed, id, "initial-angle") * Math.PI * 2;
      const initialSpeed = 5 + keyedRandom(this.seed, id, "initial-speed") * 8;
      const first = chooseOther(this.seed, id, this.population, "chosen-a", new Set([id]));
      const second = chooseOther(this.seed, id, this.population, "chosen-b", new Set([id, first]));
      const initialDestination = journeys?.enabled
        ? chooseNextDestination(this.seed, id, 0, destinations, destinations[spawnIndex]?.id)
        : null;

      return {
        id,
        x,
        y,
        vx: Math.cos(angle) * initialSpeed,
        vy: Math.sin(angle) * initialSpeed,
        angle,
        radius,
        chosen: [first, second],
        destinationId: initialDestination?.id ?? null,
        arrivalCount: 0,
      };
    });
  }

  #refreshJourneyDestinations() {
    const authored = this.environment?.destinations || [];
    const generated = this.activity?.destinations || [];
    this.journeyDestinations = Object.freeze([...authored, ...generated]);
    this.destinationById = new Map(
      this.journeyDestinations.map((destination) => [destination.id, destination]),
    );
  }

  #repairJourneyDestinations(agents) {
    if (!this.environment?.journeys.enabled || this.journeyDestinations.length < 2) return agents;
    return agents.map((agent) => {
      if (this.destinationById.has(agent.destinationId)) return agent;
      const destination = chooseNextDestination(
        this.seed,
        agent.id,
        agent.arrivalCount,
        this.journeyDestinations,
        null,
      );
      return { ...agent, destinationId: destination?.id ?? null };
    });
  }

  #createViews() {
    return this.agents.map((agent) =>
      Object.freeze({
        id: agent.id,
        position: frozenVector(agent.x, agent.y),
        velocity: frozenVector(agent.vx, agent.vy),
        radius: agent.radius,
        destinationId: agent.destinationId,
        arrivalCount: agent.arrivalCount,
      }),
    );
  }

  #canonicalizeAgents() {
    for (let index = 0; index < this.agents.length; index += 1) {
      if (this.agents[index].id !== index) {
        this.agents = [...this.agents].sort((a, b) => a.id - b.id);
        return;
      }
    }
  }

  #movementObstacles() {
    const authored = this.environment?.obstacles || [];
    if (!this.land) return authored;
    const landObstacles = this.land.config.cells
      .filter((cell) => this.land.ownerByCell[cell.index] !== -1)
      .map((cell) => Object.freeze({
        id: `private:${cell.id}`,
        label: "Claimed private land",
        x: cell.x,
        y: cell.y,
        width: cell.width,
        height: cell.height,
        landId: cell.id,
        easement: this.circulation?.easement(cell.id) ?? null,
      }));
    return Object.freeze([...authored, ...landObstacles]);
  }

  #occupiedLandIds(agents) {
    if (!this.land || !Array.isArray(agents)) return Object.freeze([]);
    const { geometry, cells, policy } = this.land.config;
    const pitch = Math.max(EPSILON, finiteOr(geometry.pitch, geometry.cellSize + geometry.gap));
    const clearance = Math.max(0, finiteOr(policy.occupancyClearance, 0));
    const occupied = new Set();
    for (const agent of agents) {
      const radius = Math.max(0, finiteOr(agent.radius, 0)) + clearance;
      let minimumColumn = Math.floor((agent.x - radius - geometry.x) / pitch);
      let maximumColumn = Math.floor((agent.x + radius - geometry.x) / pitch);
      let minimumRow = Math.floor((agent.y - radius - geometry.y) / pitch);
      let maximumRow = Math.floor((agent.y + radius - geometry.y) / pitch);
      if (maximumColumn < 0 || minimumColumn >= geometry.columns
        || maximumRow < 0 || minimumRow >= geometry.rows) continue;
      minimumColumn = clamp(minimumColumn, 0, geometry.columns - 1);
      maximumColumn = clamp(maximumColumn, 0, geometry.columns - 1);
      minimumRow = clamp(minimumRow, 0, geometry.rows - 1);
      maximumRow = clamp(maximumRow, 0, geometry.rows - 1);
      for (let row = minimumRow; row <= maximumRow; row += 1) {
        for (let column = minimumColumn; column <= maximumColumn; column += 1) {
          const cell = cells[row * geometry.columns + column];
          if (!cell) continue;
          const nearestX = clamp(agent.x, cell.x, cell.x + cell.width);
          const nearestY = clamp(agent.y, cell.y, cell.y + cell.height);
          if ((agent.x - nearestX) ** 2 + (agent.y - nearestY) ** 2 <= radius ** 2 + EPSILON) {
            occupied.add(cell.id);
          }
        }
      }
    }
    return Object.freeze([...occupied].sort());
  }

  #recordObservation({ replace = false } = {}) {
    this.#canonicalizeAgents();
    const views = Object.freeze(this.#createViews());
    const snapshot = Object.freeze({
      tick: this.tick,
      views,
      fingerprint: stateChecksum(views, this.tick),
    });
    const last = this.observationHistory.at(-1);
    if (replace && last?.tick === this.tick) this.observationHistory[this.observationHistory.length - 1] = snapshot;
    else this.observationHistory.push(snapshot);
    if (this.observationHistory.length > MAX_DELAY_TICKS + 1) this.observationHistory.shift();
  }

  #observationAt(ticksAgo = 0) {
    const delay = clamp(Math.round(finiteOr(Number(ticksAgo), 0)), 0, MAX_DELAY_TICKS);
    const targetTick = Math.max(0, this.tick - delay);
    const oldest = this.observationHistory[0];
    const index = clamp(targetTick - oldest.tick, 0, this.observationHistory.length - 1);
    return this.observationHistory[index];
  }

  #createVectorApi(maxSpeed) {
    const unit = (vector) => {
      const length = magnitude(vector);
      if (length < EPSILON) return { x: 0, y: 0 };
      return { x: vector.x / length, y: vector.y / length };
    };

    return Object.freeze({
      add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
      subtract: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
      scale: (vector, scalar) => ({ x: vector.x * scalar, y: vector.y * scalar }),
      midpoint: (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
      equilateral: equilateralApex,
      nearestEquilateral: nearestEquilateralApex,
      dot: (a, b) => a.x * b.x + a.y * b.y,
      length: magnitude,
      distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
      unit,
      limit: limitVector,
      seek: (self, target, strength = 1) => {
        const difference = { x: target.x - self.position.x, y: target.y - self.position.y };
        const distance = magnitude(difference);
        if (distance < EPSILON) {
          return { x: -self.velocity.x * strength, y: -self.velocity.y * strength };
        }
        const desiredSpeed = Math.min(maxSpeed, distance * 2.1);
        const desired = {
          x: (difference.x / distance) * desiredSpeed,
          y: (difference.y / distance) * desiredSpeed,
        };
        return {
          x: (desired.x - self.velocity.x) * strength,
          y: (desired.y - self.velocity.y) * strength,
        };
      },
    });
  }

  #nearestViews(selfIndex, views, maximum = 16) {
    const self = views[selfIndex];
    return views
      .filter((view) => view.id !== self.id)
      .map((view) => ({ view, distance: Math.hypot(view.position.x - self.position.x, view.position.y - self.position.y) }))
      .sort((a, b) => a.distance - b.distance || a.view.id - b.view.id)
      .slice(0, maximum)
      .map(({ view }) => view);
  }

  #lazyNeighbors(target, selfIndex, views, neighborCache) {
    Object.defineProperty(target, "neighbors", {
      enumerable: true,
      get: () => {
        let cachedByAgent = neighborCache.get(views);
        if (!cachedByAgent) {
          cachedByAgent = new Map();
          neighborCache.set(views, cachedByAgent);
        }
        if (!cachedByAgent.has(selfIndex)) {
          cachedByAgent.set(selfIndex, Object.freeze(this.#nearestViews(selfIndex, views)));
        }
        return cachedByAgent.get(selfIndex);
      },
    });
    return Object.freeze(target);
  }

  #separationAcceleration(index, views) {
    const self = views[index];
    const personalSpace = clamp(finiteOr(this.params.personalSpace, 5), 0, 100);
    let x = 0;
    let y = 0;

    for (let otherIndex = 0; otherIndex < views.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const other = views[otherIndex];
      const minimumDistance = self.radius + other.radius + personalSpace;
      let dx = self.position.x - other.position.x;
      let dy = self.position.y - other.position.y;
      let distance = Math.hypot(dx, dy);
      if (distance >= minimumDistance) continue;

      if (distance < EPSILON) {
        const angle = keyedRandom(this.seed, this.tick, self.id, other.id, "overlap") * Math.PI * 2;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distance = 1;
      }

      const force = ((minimumDistance - distance) / minimumDistance) * DEFAULT_MAX_ACCELERATION * 1.3;
      x += (dx / distance) * force;
      y += (dy / distance) * force;
    }

    return { x, y };
  }

  #currentDestination(agent) {
    if (!agent.destinationId) return null;
    return this.destinationById.get(agent.destinationId) || null;
  }

  #switchArrivedJourneys(agents) {
    const destinations = this.journeyDestinations;
    if (!this.environment?.journeys.enabled || destinations.length < 2) return agents;
    const arrivalRadius = this.environment.journeys.arrivalRadius;

    return agents.map((agent) => {
      const currentIndex = destinations.findIndex((destination) => destination.id === agent.destinationId);
      if (currentIndex < 0) {
        const destination = chooseNextDestination(
          this.seed,
          agent.id,
          agent.arrivalCount,
          destinations,
          null,
        );
        return { ...agent, destinationId: destination?.id ?? null };
      }
      const destination = destinations[currentIndex];
      const threshold = Math.max(arrivalRadius, destination.radius);
      if (Math.hypot(agent.x - destination.x, agent.y - destination.y) > threshold) return agent;
      this.trips += 1;
      this.activity?.recordArrival(destination.id);
      const arrivalCount = agent.arrivalCount + 1;
      // A generated local stop is followed by one of the authored regional
      // anchors. This prevents an unconstrained chain of parcel-to-parcel
      // trips from overwhelming the movement pattern that created frontage
      // in the first place, while still letting every gate trip generate
      // fresh local demand.
      const nextDestinations = destination.kind === "parcel-activity"
        ? this.environment.destinations
        : destinations;
      const nextDestination = chooseNextDestination(
        this.seed,
        agent.id,
        arrivalCount,
        nextDestinations,
        destination.id,
      );
      return {
        ...agent,
        destinationId: nextDestination?.id ?? null,
        arrivalCount,
      };
    });
  }

  #fieldPersistence() {
    if (!this.field || !this.environment?.field) return 1;
    if (Number.isFinite(Number(this.params.fieldPersistence))) {
      return clamp(Number(this.params.fieldPersistence), 0, 1);
    }
    if (this.environment.field.persistence !== null) return this.environment.field.persistence;
    return 1 - this.environment.field.decay;
  }

  step(count = 1) {
    const steps = clamp(Math.round(count), 1, 10_000);
    let result = { ok: true, error: null };

    for (let stepIndex = 0; stepIndex < steps; stepIndex += 1) {
      result = this.#stepOnce();
      if (!result.ok) break;
    }

    return result;
  }

  #stepOnce() {
    // Canonicalize storage before every decision so insertion order cannot affect a tick.
    this.#canonicalizeAgents();
    const views = this.#createViews();
    const maxSpeed = clamp(finiteOr(this.params.maxSpeed, 88), 1, 500);
    const maxAcceleration = clamp(
      finiteOr(this.params.maxAcceleration, DEFAULT_MAX_ACCELERATION),
      1,
      2_000,
    );
    const vec = this.#createVectorApi(maxSpeed);
    const world = Object.freeze({
      width: this.width,
      height: this.height,
      maxSpeed,
      dt: this.dt,
    });
    const readonlyParams = Object.freeze({ ...this.params });
    const destinations = this.journeyDestinations;
    // Claimed cells close to through-movement on the following tick. Private
    // reservations stay traversable, preserving the road-versus-plot conflict
    // until either use actually wins public status or tenure becomes a claim.
    const collisionObstacles = this.#movementObstacles();
    const obstacles = collisionObstacles;
    const fieldApi = this.field?.api || Object.freeze({
      enabled: false,
      cols: 0,
      columns: 0,
      rows: 0,
      cellSize: 0,
      sample: () => 0,
      gradient: () => frozenVector(0, 0),
    });
    const intents = [];
    const landIntents = [];
    const neighborCache = new WeakMap();
    const observationCache = new WeakMap();
    const occupiedLandIds = this.#occupiedLandIds(this.agents);

    for (let index = 0; index < this.agents.length; index += 1) {
      const agent = this.agents[index];
      const observation = (ticksAgo = 0) => {
        const snapshot = this.#observationAt(ticksAgo);
        let cachedByAgent = observationCache.get(snapshot);
        if (!cachedByAgent) {
          cachedByAgent = new Map();
          observationCache.set(snapshot, cachedByAgent);
        }
        if (cachedByAgent.has(agent.id)) return cachedByAgent.get(agent.id);

        const result = this.#lazyNeighbors({
          tick: snapshot.tick,
          age: this.tick - snapshot.tick,
          self: snapshot.views[agent.id],
          chosen: Object.freeze(agent.chosen.map((chosenId) => snapshot.views[chosenId])),
        }, agent.id, snapshot.views, neighborCache);
        cachedByAgent.set(agent.id, result);
        return result;
      };
      const context = this.#lazyNeighbors({
        self: views[index],
        chosen: Object.freeze(agent.chosen.map((chosenId) => views[chosenId])),
        params: readonlyParams,
        vec,
        world,
        destination: this.#currentDestination(agent),
        destinations,
        obstacles,
        field: fieldApi,
        land: this.land?.viewFor(agent.id, this.tick, { occupiedLandIds }) || null,
        circulation: this.circulation?.viewFor(views[index], this.tick) || null,
        tick: this.tick,
        sense: observation,
        random: (key = "default") => keyedRandom(this.seed, this.tick, agent.id, key),
      }, index, views, neighborCache);

      let decision;
      try {
        decision = this.behavior(context);
      } catch (error) {
        this.lastError = {
          tick: this.tick,
          agentId: agent.id,
          message: error instanceof Error ? error.message : String(error),
        };
        return { ok: false, error: this.lastError };
      }

      const proposed = decision?.acceleration;
      if (
        !proposed ||
        typeof proposed !== "object" ||
        !Number.isFinite(proposed.x) ||
        !Number.isFinite(proposed.y)
      ) {
        this.lastError = {
          tick: this.tick,
          agentId: agent.id,
          message: "behave() must return { acceleration: { x, y } } with finite numbers.",
        };
        return { ok: false, error: this.lastError };
      }

      const parsedLandIntent = parseLandIntent(decision);
      if (!parsedLandIntent.ok) {
        this.lastError = {
          tick: this.tick,
          agentId: agent.id,
          message: parsedLandIntent.error,
        };
        return { ok: false, error: this.lastError };
      }
      if (parsedLandIntent.intent) {
        landIntents.push(Object.freeze({ agentId: agent.id, ...parsedLandIntent.intent }));
      }

      const separation = this.#separationAcceleration(index, views);
      intents.push(
        limitVector(
          {
            x: proposed.x + separation.x,
            y: proposed.y + separation.y,
          },
          maxAcceleration,
        ),
      );
    }

    const damping = Math.exp(-0.18 * this.dt);
    const attemptedPositions = new Array(this.agents.length);
    const blockedLandIds = new Array(this.agents.length).fill(null);
    const nextAgents = this.agents.map((agent, index) => {
      const acceleration = intents[index];
      let velocity = limitVector(
        {
          x: (agent.vx + acceleration.x * this.dt) * damping,
          y: (agent.vy + acceleration.y * this.dt) * damping,
        },
        maxSpeed,
      );
      let x = agent.x + velocity.x * this.dt;
      let y = agent.y + velocity.y * this.dt;
      const radius = agent.radius;

      if (x < radius) {
        x = radius;
        velocity = { ...velocity, x: Math.abs(velocity.x) * 0.58 };
      } else if (x > this.width - radius) {
        x = this.width - radius;
        velocity = { ...velocity, x: -Math.abs(velocity.x) * 0.58 };
      }

      if (y < radius) {
        y = radius;
        velocity = { ...velocity, y: Math.abs(velocity.y) * 0.58 };
      } else if (y > this.height - radius) {
        y = this.height - radius;
        velocity = { ...velocity, y: -Math.abs(velocity.y) * 0.58 };
      }

      attemptedPositions[index] = frozenVector(x, y);

      let strongestLandCorrection = 0;
      for (const obstacle of collisionObstacles) {
        const beforeX = x;
        const beforeY = y;
        const collision = resolveCircleAgainstPrivateObstacle(
          { x: agent.x, y: agent.y },
          { x, y },
          velocity,
          radius,
          obstacle,
        );
        x = collision.position.x;
        y = collision.position.y;
        velocity = collision.velocity;
        if (collision.collided && obstacle.landId) {
          const correction = Math.hypot(x - beforeX, y - beforeY);
          const currentLandId = blockedLandIds[index];
          if (correction > strongestLandCorrection + EPSILON
            || (Math.abs(correction - strongestLandCorrection) <= EPSILON
              && (currentLandId === null || String(obstacle.landId).localeCompare(currentLandId) < 0))) {
            strongestLandCorrection = correction;
            blockedLandIds[index] = String(obstacle.landId);
          }
        }
      }

      x = clamp(x, radius, this.width - radius);
      y = clamp(y, radius, this.height - radius);

      const speed = Math.hypot(velocity.x, velocity.y);
      const angle = speed > 0.05 ? Math.atan2(velocity.y, velocity.x) : agent.angle;

      return {
        ...agent,
        x: finiteOr(x, agent.x),
        y: finiteOr(y, agent.y),
        vx: finiteOr(velocity.x),
        vy: finiteOr(velocity.y),
        angle,
      };
    });

    const circulationTransition = this.circulation?.stage(
      this.agents.map((agent, index) => Object.freeze({
        agentId: agent.id,
        from: frozenVector(agent.x, agent.y),
        to: frozenVector(nextAgents[index].x, nextAgents[index].y),
        attemptedTo: attemptedPositions[index],
        blockedLandId: blockedLandIds[index],
        pressureTo: this.#currentDestination(agent),
      })),
      this.tick,
    ) || null;
    if (circulationTransition && !circulationTransition.ok) {
      this.lastError = {
        tick: this.tick,
        message: circulationTransition.error || "Circulation use could not be resolved.",
      };
      return { ok: false, error: this.lastError };
    }

    const landTransition = this.land?.stage(landIntents, this.tick, {
      publicCells: this.circulation?.publicLandIds?.() || [],
      publicCandidates: circulationTransition?.publicCandidates || [],
      publicAcquisitions: circulationTransition?.publicAcquisitions || [],
      occupiedLandIds: this.#occupiedLandIds(nextAgents),
    }) || null;
    if (landTransition && !landTransition.ok) {
      this.lastError = {
        tick: this.tick,
        message: landTransition.error || "Land intents could not be resolved.",
      };
      return { ok: false, error: this.lastError };
    }

    this.agents = this.#switchArrivedJourneys(nextAgents);
    if (this.field) {
      this.field.evolve(this.agents, {
        deposit: this.environment.field.deposit,
        persistence: this.#fieldPersistence(),
        diffusion: this.environment.field.diffusion,
      });
    }
    if (circulationTransition) {
      this.circulation.commit(circulationTransition, {
        acceptedLandIds: landTransition?.acceptedPublicLandIds || [],
        acceptedAcquisitionLandIds: landTransition?.acceptedPublicAcquisitionLandIds || [],
        returnFrame: false,
      });
    }
    if (landTransition) this.land.commit(landTransition, { returnFrame: false });
    this.tick += 1;
    this.activity?.advance(this.tick);
    this.#refreshJourneyDestinations();
    this.agents = this.#repairJourneyDestinations(this.agents);
    this.#recordObservation();
    this.lastError = null;
    return { ok: true, error: null };
  }

  perturbAgent(agentId, position, { sequence = this.eventCursor + 1, zeroVelocity = true } = {}) {
    const id = Number(agentId);
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (!Number.isInteger(id) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, error: "A perturbation requires a valid agent ID and finite coordinates." };
    }
    const index = this.agents.findIndex((agent) => agent.id === id);
    if (index < 0) return { ok: false, error: `Agent ${id} does not exist.` };

    const agent = this.agents[index];
    let target = clampWorldPoint({ x, y }, agent.radius, this.width, this.height);
    let targetVelocity = { x: agent.vx, y: agent.vy };
    for (const obstacle of this.#movementObstacles()) {
      const collision = resolveCircleAgainstPrivateObstacle(
        { x: agent.x, y: agent.y },
        target,
        targetVelocity,
        agent.radius,
        obstacle,
      );
      target = collision.position;
      targetVelocity = collision.velocity;
    }
    const intervention = Object.freeze({
      sequence: Math.max(this.eventCursor + 1, Math.round(finiteOr(sequence, this.eventCursor + 1))),
      tick: this.tick,
      agentId: id,
      from: frozenVector(agent.x, agent.y),
      to: frozenVector(target.x, target.y),
      distance: Math.hypot(target.x - agent.x, target.y - agent.y),
    });
    this.agents[index] = {
      ...agent,
      x: target.x,
      y: target.y,
      vx: zeroVelocity ? 0 : targetVelocity.x,
      vy: zeroVelocity ? 0 : targetVelocity.y,
    };
    this.eventCursor = intervention.sequence;
    this.interventions.push(intervention);
    this.#recordObservation({ replace: true });
    return { ok: true, intervention };
  }

  metrics({
    circulationMetrics = this.circulation?.metrics(),
    landMetrics = this.land?.metrics(),
    activityMetrics = this.activity?.metrics(),
  } = {}) {
    const count = this.agents.length;
    circulationMetrics ||= {
      roadCells: 0,
      roadReservedCells: 0,
      activeRouteCells: 0,
      roadShare: 0,
      roadLandConflicts: 0,
      roadPreemptions: 0,
      networkComponents: 0,
      meanRoadUse: 0,
    };
    landMetrics ||= {
      claimedCells: 0,
      reservedCells: 0,
      claimedShare: 0,
      landConflicts: 0,
      landOwners: 0,
      parcelCount: 0,
      meanParcelArea: 0,
      meanParcelCompactness: 0,
      ownershipConcentration: 0,
      roadLandConflicts: 0,
      roadPreemptions: 0,
    };
    activityMetrics ||= {
      activeActivities: 0,
      activityTrips: 0,
      activityOpenings: 0,
      activityClosures: 0,
    };
    if (count === 0) {
      return {
        spread: 0,
        nearest: 0,
        match: 0,
        meanSpeed: 0,
        trailConcentration: 0,
        totalFootfall: 0,
        trips: this.trips,
        ...circulationMetrics,
        ...landMetrics,
        ...activityMetrics,
      };
    }

    const centroid = this.agents.reduce(
      (sum, agent) => ({ x: sum.x + agent.x / count, y: sum.y + agent.y / count }),
      { x: 0, y: 0 },
    );
    let squaredRadius = 0;
    let nearestTotal = 0;
    let speedTotal = 0;

    for (const agent of this.agents) {
      squaredRadius += (agent.x - centroid.x) ** 2 + (agent.y - centroid.y) ** 2;
      speedTotal += Math.hypot(agent.vx, agent.vy);
      let nearest = Infinity;
      for (const other of this.agents) {
        if (other.id === agent.id) continue;
        nearest = Math.min(nearest, Math.hypot(agent.x - other.x, agent.y - other.y));
      }
      nearestTotal += Number.isFinite(nearest) ? nearest : 0;
    }

    const fieldMetrics = this.field?.metrics() || { total: 0, concentration: 0 };
    return {
      spread: Math.sqrt(squaredRadius / count),
      nearest: nearestTotal / count,
      match: this.#relationshipMatch(),
      meanSpeed: speedTotal / count,
      trailConcentration: fieldMetrics.concentration,
      totalFootfall: fieldMetrics.total,
      trips: this.trips,
      ...circulationMetrics,
      ...landMetrics,
      ...activityMetrics,
    };
  }

  #relationshipMatch() {
    if (this.relationMode === "none") return null;
    let errorTotal = 0;
    let scoreTotal = 0;
    const observedViews = this.#observationAt(this.params.delayTicks).views;
    const observedById = new Map(observedViews.map((view) => [view.id, view]));

    for (const self of this.agents) {
      const first = observedById.get(self.chosen[0]);
      const second = observedById.get(self.chosen[1]);
      if (!first || !second) continue;
      const firstPosition = first.position;
      const secondPosition = second.position;

      if (this.relationMode === "midpoint") {
        const targetX = (firstPosition.x + secondPosition.x) / 2;
        const targetY = (firstPosition.y + secondPosition.y) / 2;
        errorTotal += Math.hypot(self.x - targetX, self.y - targetY);
      } else if (this.relationMode === "shield") {
        const personToSelfX = self.x - firstPosition.x;
        const personToSelfY = self.y - firstPosition.y;
        const personToShieldX = secondPosition.x - firstPosition.x;
        const personToShieldY = secondPosition.y - firstPosition.y;
        const lengthSquared = personToSelfX ** 2 + personToSelfY ** 2;
        if (lengthSquared > EPSILON) {
          const projection =
            (personToShieldX * personToSelfX + personToShieldY * personToSelfY) / lengthSquared;
          if (projection > 0 && projection < 1) {
            const projectedX = firstPosition.x + personToSelfX * projection;
            const projectedY = firstPosition.y + personToSelfY * projection;
            const crossTrackError = Math.hypot(
              secondPosition.x - projectedX,
              secondPosition.y - projectedY,
            );
            scoreTotal += Math.exp(-crossTrackError / 50);
          }
        }
      } else if (this.relationMode === "bisector") {
        const firstDistance = Math.hypot(self.x - firstPosition.x, self.y - firstPosition.y);
        const secondDistance = Math.hypot(self.x - secondPosition.x, self.y - secondPosition.y);
        errorTotal += Math.abs(firstDistance - secondDistance);
      } else if (this.relationMode === "equilateral" || this.relationMode === "equilateral-nearest") {
        const selfPosition = { x: self.x, y: self.y };
        const target = this.relationMode === "equilateral-nearest"
          ? nearestEquilateralApex(selfPosition, firstPosition, secondPosition, self.id % 2 === 0 ? 1 : -1)
          : equilateralApex(firstPosition, secondPosition, this.params.chirality);
        errorTotal += Math.hypot(self.x - target.x, self.y - target.y);
      }
    }

    if (this.relationMode === "shield") {
      return clamp((scoreTotal / this.agents.length) * 100, 0, 100);
    }

    const meanError = errorTotal / this.agents.length;
    return clamp(Math.exp(-meanError / 82) * 100, 0, 100);
  }

  frame({ includeChecksum = true } = {}) {
    const configuredDelayTicks = clamp(
      Math.round(finiteOr(Number(this.params.delayTicks), 0)),
      0,
      MAX_DELAY_TICKS,
    );
    const delayedObservation = this.#observationAt(configuredDelayTicks);
    const observationAge = this.tick - delayedObservation.tick;
    const fieldFrame = this.field?.frame() || null;
    const landFrame = this.land?.frame(this.tick) || null;
    const circulationFrame = this.circulation?.frame() || null;
    const activityFrame = this.activity?.frame() || null;
    const landCellById = this.land
      ? new Map(this.land.config.cells.map((cell) => [cell.id, cell]))
      : null;
    const frameAgents = this.agents.map((agent) => {
      let circulationRoute = null;
      if (this.circulation && this.land) {
        const reservationIndex = this.land.reservedByCell.indexOf(agent.id);
        if (reservationIndex >= 0) {
          const landId = this.land.config.cells[reservationIndex].id;
          const self = Object.freeze({
            id: agent.id,
            position: frozenVector(agent.x, agent.y),
            velocity: frozenVector(agent.vx, agent.vy),
            radius: agent.radius,
          });
          const route = this.circulation.viewFor(self, this.tick).route(landId);
          if (route.reachable) {
            const points = [
              { x: agent.x, y: agent.y },
              ...route.cellIds.map((id) => landCellById.get(id)?.center).filter(Boolean),
            ].filter((point, index, values) => (
              index === 0
              || Math.hypot(point.x - values[index - 1].x, point.y - values[index - 1].y) > EPSILON
            ));
            if (points.length >= 2) {
              circulationRoute = {
                landId,
                status: route.arrived ? "arrived" : route.fronted ? "fronted" : "forming",
                cellIds: [...route.cellIds],
                points,
              };
            }
          }
        }
      }
      return {
        id: agent.id,
        x: agent.x,
        y: agent.y,
        vx: agent.vx,
        vy: agent.vy,
        angle: agent.angle,
        radius: agent.radius,
        chosen: [...agent.chosen],
        destinationId: agent.destinationId,
        arrivalCount: agent.arrivalCount,
        ...(circulationRoute ? { circulationRoute } : {}),
      };
    });
    const environmentFrame = this.environment ? {
      destinations: this.environment.destinations,
      activities: activityFrame?.destinations || Object.freeze([]),
      journeyDestinations: this.journeyDestinations,
      obstacles: this.environment.obstacles,
      journeys: this.environment.journeys,
      field: fieldFrame,
    } : null;
    return {
      tick: this.tick,
      seed: this.seed,
      width: this.width,
      height: this.height,
      checksum: includeChecksum
        ? stateChecksum(this.agents, this.tick, {
          delayTicks: this.params.delayTicks,
          eventCursor: this.eventCursor,
          history: this.observationHistory,
          configuration: {
            seed: this.seed,
            population: this.population,
            width: this.width,
            height: this.height,
            dt: this.dt,
            params: this.params,
            relationMode: this.relationMode,
            ruleKey: this.ruleKey,
            ...(this.environment ? { environment: this.environment } : {}),
          },
          journey: this.environment?.journeys.enabled ? {
            trips: this.trips,
            destinationIds: this.agents.map((agent) => agent.destinationId),
            arrivalCounts: this.agents.map((agent) => agent.arrivalCount),
          } : undefined,
          field: this.field?.values,
          land: this.land?.checksumState(),
          circulation: this.circulation?.checksumState(),
          activity: this.activity?.checksumState(),
        })
        : null,
      eventCursor: this.eventCursor,
      lastIntervention: this.interventions.at(-1) || null,
      configuredDelayTicks,
      observationAge,
      delayTicks: observationAge,
      observedTick: delayedObservation.tick,
      observedAgents: delayedObservation.views.map((view) => ({
        id: view.id,
        x: view.position.x,
        y: view.position.y,
      })),
      metrics: this.metrics({
        circulationMetrics: circulationFrame?.metrics,
        landMetrics: landFrame?.metrics,
        activityMetrics: activityFrame?.metrics,
      }),
      environment: environmentFrame,
      field: fieldFrame,
      land: landFrame,
      circulation: circulationFrame,
      activity: activityFrame,
      agents: frameAgents,
    };
  }
}
