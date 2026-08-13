import { keyedRandom, randomInteger, stateChecksum } from "./prng.js";
import { clampWorldPoint, equilateralApex, nearestEquilateralApex } from "./geometry.js";
import { ScalarField } from "./scalar-field.js";

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
      persistence: fieldInput.persistence === undefined
        ? null
        : clamp(finiteOr(Number(fieldInput.persistence), 1), 0, 1),
      diffusion: clamp(finiteOr(Number(fieldInput.diffusion), 0), 0, 1),
    })
    : null;

  return Object.freeze({ destinations, obstacles, journeys, field });
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
    return this.environment?.destinations.find((destination) => destination.id === agent.destinationId) || null;
  }

  #switchArrivedJourneys(agents) {
    const destinations = this.environment?.destinations || [];
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
      const arrivalCount = agent.arrivalCount + 1;
      const nextDestination = chooseNextDestination(
        this.seed,
        agent.id,
        arrivalCount,
        destinations,
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
    const destinations = this.environment?.destinations || Object.freeze([]);
    const obstacles = this.environment?.obstacles || Object.freeze([]);
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
    const neighborCache = new WeakMap();
    const observationCache = new WeakMap();

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

      for (const obstacle of obstacles) {
        const collision = resolveCircleAgainstRectangle({ x, y }, velocity, radius, obstacle);
        x = collision.position.x;
        y = collision.position.y;
        velocity = collision.velocity;
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

    this.agents = this.#switchArrivedJourneys(nextAgents);
    if (this.field) {
      this.field.evolve(this.agents, {
        deposit: this.environment.field.deposit,
        persistence: this.#fieldPersistence(),
        diffusion: this.environment.field.diffusion,
      });
    }
    this.tick += 1;
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
    for (const obstacle of this.environment?.obstacles || []) {
      const collision = resolveCircleAgainstRectangle(target, targetVelocity, agent.radius, obstacle);
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

  metrics() {
    const count = this.agents.length;
    if (count === 0) {
      return {
        spread: 0,
        nearest: 0,
        match: 0,
        meanSpeed: 0,
        trailConcentration: 0,
        totalFootfall: 0,
        trips: this.trips,
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

  frame() {
    const configuredDelayTicks = clamp(
      Math.round(finiteOr(Number(this.params.delayTicks), 0)),
      0,
      MAX_DELAY_TICKS,
    );
    const delayedObservation = this.#observationAt(configuredDelayTicks);
    const observationAge = this.tick - delayedObservation.tick;
    const fieldFrame = this.field?.frame() || null;
    const environmentFrame = this.environment ? {
      destinations: this.environment.destinations,
      obstacles: this.environment.obstacles,
      journeys: this.environment.journeys,
      field: fieldFrame,
    } : null;
    return {
      tick: this.tick,
      seed: this.seed,
      width: this.width,
      height: this.height,
      checksum: stateChecksum(this.agents, this.tick, {
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
      }),
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
      metrics: this.metrics(),
      environment: environmentFrame,
      field: fieldFrame,
      agents: this.agents.map((agent) => ({
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
      })),
    };
  }
}
