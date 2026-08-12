import { keyedRandom, randomInteger, stateChecksum } from "./prng.js";

const DEFAULT_WIDTH = 1_000;
const DEFAULT_HEIGHT = 650;
const DEFAULT_STEP = 1 / 30;
const DEFAULT_MAX_ACCELERATION = 240;
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

function chooseOther(seed, agentId, population, key, excluded = new Set()) {
  if (population <= excluded.size) return agentId;
  let candidate = randomInteger(seed, 0, population, agentId, key);
  for (let attempts = 0; attempts < population; attempts += 1) {
    if (!excluded.has(candidate)) return candidate;
    candidate = (candidate + 1) % population;
  }
  return agentId;
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
    this.tick = 0;
    this.lastError = null;
    this.agents = [];
    this.reset();
  }

  reset({ seed = this.seed, population = this.population, params = this.params } = {}) {
    this.seed = Number(seed) >>> 0;
    this.population = clamp(Math.round(population), 3, 2_000);
    this.params = { ...params };
    this.tick = 0;
    this.lastError = null;
    this.agents = this.#createAgents();
    return this.frame();
  }

  setBehavior(behavior) {
    if (typeof behavior !== "function") throw new TypeError("A behavior function is required.");
    this.behavior = behavior;
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
      const x = margin + keyedRandom(this.seed, id, "initial-x") * usableWidth;
      const y = margin + keyedRandom(this.seed, id, "initial-y") * usableHeight;
      const angle = keyedRandom(this.seed, id, "initial-angle") * Math.PI * 2;
      const initialSpeed = 5 + keyedRandom(this.seed, id, "initial-speed") * 8;
      const first = chooseOther(this.seed, id, this.population, "chosen-a", new Set([id]));
      const second = chooseOther(this.seed, id, this.population, "chosen-b", new Set([id, first]));

      return {
        id,
        x,
        y,
        vx: Math.cos(angle) * initialSpeed,
        vy: Math.sin(angle) * initialSpeed,
        angle,
        radius,
        chosen: [first, second],
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
      }),
    );
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
    const intents = [];

    for (let index = 0; index < this.agents.length; index += 1) {
      const agent = this.agents[index];
      const context = Object.freeze({
        self: views[index],
        chosen: Object.freeze(agent.chosen.map((chosenId) => views[chosenId])),
        neighbors: Object.freeze(this.#nearestViews(index, views)),
        params: readonlyParams,
        vec,
        world,
        tick: this.tick,
        random: (key = "default") => keyedRandom(this.seed, this.tick, agent.id, key),
      });

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

    this.agents = nextAgents;
    this.tick += 1;
    this.lastError = null;
    return { ok: true, error: null };
  }

  metrics() {
    const count = this.agents.length;
    if (count === 0) {
      return { spread: 0, nearest: 0, match: 0, meanSpeed: 0 };
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

    return {
      spread: Math.sqrt(squaredRadius / count),
      nearest: nearestTotal / count,
      match: this.#relationshipMatch(),
      meanSpeed: speedTotal / count,
    };
  }

  #relationshipMatch() {
    if (this.relationMode === "none") return null;
    let errorTotal = 0;
    let scoreTotal = 0;

    for (const self of this.agents) {
      const first = this.agents[self.chosen[0]];
      const second = this.agents[self.chosen[1]];
      if (!first || !second) continue;

      if (this.relationMode === "midpoint") {
        const targetX = (first.x + second.x) / 2;
        const targetY = (first.y + second.y) / 2;
        errorTotal += Math.hypot(self.x - targetX, self.y - targetY);
      } else if (this.relationMode === "shield") {
        const personToSelfX = self.x - first.x;
        const personToSelfY = self.y - first.y;
        const personToShieldX = second.x - first.x;
        const personToShieldY = second.y - first.y;
        const lengthSquared = personToSelfX ** 2 + personToSelfY ** 2;
        if (lengthSquared > EPSILON) {
          const projection =
            (personToShieldX * personToSelfX + personToShieldY * personToSelfY) / lengthSquared;
          if (projection > 0 && projection < 1) {
            const projectedX = first.x + personToSelfX * projection;
            const projectedY = first.y + personToSelfY * projection;
            const crossTrackError = Math.hypot(second.x - projectedX, second.y - projectedY);
            scoreTotal += Math.exp(-crossTrackError / 50);
          }
        }
      } else if (this.relationMode === "bisector") {
        const firstDistance = Math.hypot(self.x - first.x, self.y - first.y);
        const secondDistance = Math.hypot(self.x - second.x, self.y - second.y);
        errorTotal += Math.abs(firstDistance - secondDistance);
      }
    }

    if (this.relationMode === "shield") {
      return clamp((scoreTotal / this.agents.length) * 100, 0, 100);
    }

    const meanError = errorTotal / this.agents.length;
    return clamp(Math.exp(-meanError / 82) * 100, 0, 100);
  }

  frame() {
    return {
      tick: this.tick,
      seed: this.seed,
      width: this.width,
      height: this.height,
      checksum: stateChecksum(this.agents, this.tick),
      metrics: this.metrics(),
      agents: this.agents.map((agent) => ({
        id: agent.id,
        x: agent.x,
        y: agent.y,
        vx: agent.vx,
        vy: agent.vy,
        angle: agent.angle,
        radius: agent.radius,
        chosen: [...agent.chosen],
      })),
    };
  }
}
