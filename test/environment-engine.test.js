import assert from "node:assert/strict";
import test from "node:test";

import { SimulationEngine } from "../src/simulation/engine.js";
import { ScalarField } from "../src/simulation/scalar-field.js";

const zeroBehavior = () => ({ acceleration: { x: 0, y: 0 } });
const environment = {
  destinations: [
    { id: "west", label: "West", x: 80, y: 160, radius: 24 },
    { id: "east", label: "East", x: 520, y: 160, radius: 24 },
  ],
  obstacles: [{ id: "block", x: 270, y: 100, width: 60, height: 120 }],
  journeys: { enabled: true, spawnAtDestinations: true, arrivalRadius: 25 },
  field: { enabled: true, cellSize: 20, deposit: 1, decay: 0.01, diffusion: 0.04 },
};

function createEnvironmentEngine(overrides = {}) {
  return new SimulationEngine({
    behavior: zeroBehavior,
    ruleKey: "zero",
    seed: 303,
    population: 12,
    width: 600,
    height: 320,
    params: { fieldPersistence: 0.99 },
    relationMode: "none",
    environment,
    ...overrides,
  });
}

function createGateEngine(destinations, overrides = {}) {
  return new SimulationEngine({
    behavior: zeroBehavior,
    ruleKey: "weighted-gates",
    seed: 8128,
    population: 300,
    width: 600,
    height: 320,
    params: {},
    relationMode: "none",
    environment: {
      destinations,
      journeys: { enabled: true, spawnAtDestinations: true, arrivalRadius: 30 },
    },
    ...overrides,
  });
}

function sendEveryAgentTo(engine, destinationId) {
  const destination = engine.environment.destinations.find(({ id }) => id === destinationId);
  assert.ok(destination, `Missing test destination ${destinationId}`);
  for (const agent of engine.agents) {
    agent.destinationId = destinationId;
    agent.x = destination.x;
    agent.y = destination.y;
    agent.vx = 0;
    agent.vy = 0;
  }
}

function routesByAgent(engine) {
  return engine.agents
    .map(({ id, destinationId, arrivalCount }) => ({ id, destinationId, arrivalCount }))
    .sort((first, second) => first.id - second.id);
}

test("environment journeys and scalar field reset deterministically", () => {
  const engine = createEnvironmentEngine();
  engine.step(45);
  const expected = engine.frame().checksum;
  assert.ok(engine.metrics().totalFootfall > 0);

  engine.reset();
  assert.equal(engine.tick, 0);
  assert.equal(engine.metrics().totalFootfall, 0);
  engine.step(45);
  assert.equal(engine.frame().checksum, expected);
});

test("arriving at a destination advances the goal and counts the trip", () => {
  const engine = createEnvironmentEngine();
  const agent = engine.agents[0];
  assert.equal(agent.destinationId, "east");
  agent.x = 520;
  agent.y = 160;
  agent.vx = 0;
  agent.vy = 0;

  assert.equal(engine.step().ok, true);
  assert.equal(engine.agents[0].destinationId, "west");
  assert.equal(engine.agents[0].arrivalCount, 1);
  assert.equal(engine.metrics().trips, 1);
});

test("destination weights are normalized into canonical environment data", () => {
  const engine = createGateEngine([
    { id: "default", x: 80, y: 80 },
    { id: "numeric-string", x: 300, y: 80, weight: "2.5" },
    { id: "negative", x: 520, y: 80, weight: -7 },
    { id: "invalid", x: 300, y: 240, weight: "many" },
    { id: "null", x: 80, y: 240, weight: null },
  ], { population: 12 });

  assert.deepEqual(
    engine.frame().environment.destinations.map(({ id, weight }) => [id, weight]),
    [["default", 1], ["numeric-string", 2.5], ["negative", 0], ["invalid", 1], ["null", 1]],
  );
  assert.ok(Object.isFrozen(engine.environment.destinations[0]));
});

test("weighted journey routing excludes the current gate and zero-weight alternatives", () => {
  const engine = createGateEngine([
    { id: "origin", x: 80, y: 160, weight: 1 },
    { id: "quiet", x: 260, y: 80, weight: 0 },
    { id: "rare", x: 520, y: 80, weight: 1 },
    { id: "busy", x: 520, y: 240, weight: 9 },
  ]);
  sendEveryAgentTo(engine, "origin");

  assert.equal(engine.step().ok, true);
  const counts = Object.fromEntries(engine.environment.destinations.map(({ id }) => [id, 0]));
  for (const agent of engine.agents) counts[agent.destinationId] += 1;

  assert.equal(counts.origin, 0);
  assert.equal(counts.quiet, 0);
  assert.ok(counts.rare > 0);
  assert.ok(counts.busy > counts.rare * 4, JSON.stringify(counts));
  assert.ok(engine.agents.every((agent) => agent.arrivalCount === 1));
  assert.equal(engine.metrics().trips, engine.population);
});

test("all-zero alternatives use a deterministic uniform fallback", () => {
  const destinations = [
    { id: "origin", x: 80, y: 160, weight: 4 },
    { id: "north", x: 300, y: 60, weight: 0 },
    { id: "east", x: 520, y: 160, weight: 0 },
    { id: "south", x: 300, y: 260, weight: 0 },
  ];
  const first = createGateEngine(destinations, { population: 180 });
  const second = createGateEngine(destinations, { population: 180 });
  sendEveryAgentTo(first, "origin");
  sendEveryAgentTo(second, "origin");

  first.step();
  second.agents.reverse();
  second.step();

  assert.deepEqual(routesByAgent(first), routesByAgent(second));
  assert.deepEqual(new Set(first.agents.map(({ destinationId }) => destinationId)), new Set(["east", "north", "south"]));
  assert.equal(first.frame().checksum, second.frame().checksum);
});

test("weighted choices do not depend on destination declaration order", () => {
  const destinations = [
    { id: "origin", x: 80, y: 160, weight: 1 },
    { id: "north", x: 300, y: 60, weight: 2 },
    { id: "east", x: 520, y: 160, weight: 8 },
    { id: "south", x: 300, y: 260, weight: 4 },
  ];
  const first = createGateEngine(destinations, { population: 120 });
  const reordered = createGateEngine([destinations[2], destinations[0], destinations[3], destinations[1]], {
    population: 120,
  });
  sendEveryAgentTo(first, "origin");
  sendEveryAgentTo(reordered, "origin");

  first.step();
  reordered.step();

  assert.deepEqual(routesByAgent(reordered), routesByAgent(first));
});

test("weighted routing replays after reset and changes with each arrival count", () => {
  const destinations = [
    { id: "west", x: 70, y: 160, weight: 1 },
    { id: "north", x: 300, y: 60, weight: 2 },
    { id: "east", x: 530, y: 160, weight: 7 },
    { id: "south", x: 300, y: 260, weight: 3 },
  ];
  const engine = createGateEngine(destinations, { population: 90, seed: 441 });
  const runArrivals = () => {
    const result = [];
    for (let arrival = 0; arrival < 4; arrival += 1) {
      for (const agent of engine.agents) {
        const destination = engine.environment.destinations.find(({ id }) => id === agent.destinationId);
        agent.x = destination.x;
        agent.y = destination.y;
        agent.vx = 0;
        agent.vy = 0;
      }
      assert.equal(engine.step().ok, true);
      result.push(routesByAgent(engine));
    }
    return result;
  };

  const firstRun = runArrivals();
  assert.ok(firstRun[0].some((route, index) => route.destinationId !== firstRun[1][index].destinationId));
  assert.ok(engine.frame().agents.every(({ arrivalCount }) => arrivalCount === 4));
  const checksum = engine.frame().checksum;

  engine.reset();
  const replay = runArrivals();
  assert.deepEqual(replay, firstRun);
  assert.equal(engine.frame().checksum, checksum);
});

test("circle agents cannot remain inside axis-aligned obstacles", () => {
  const engine = createEnvironmentEngine();
  const agent = engine.agents[0];
  agent.x = 300;
  agent.y = 160;
  agent.vx = 20;
  agent.vy = 0;

  assert.equal(engine.step().ok, true);
  const moved = engine.agents[0];
  const obstacle = environment.obstacles[0];
  const nearestX = Math.max(obstacle.x, Math.min(obstacle.x + obstacle.width, moved.x));
  const nearestY = Math.max(obstacle.y, Math.min(obstacle.y + obstacle.height, moved.y));
  assert.ok(Math.hypot(moved.x - nearestX, moved.y - nearestY) >= moved.radius - 1e-9);
});

test("behavior receives frozen environment and normalized scalar-field sampling", () => {
  let captured;
  const engine = createEnvironmentEngine({
    behavior: (context) => {
      if (context.self.id === 0) captured = context;
      return zeroBehavior();
    },
  });
  engine.step(2);

  assert.ok(Object.isFrozen(captured.destination));
  assert.ok(Object.isFrozen(captured.destinations));
  assert.ok(Object.isFrozen(captured.obstacles));
  assert.ok(Object.isFrozen(captured.field));
  const strength = captured.field.sample(engine.agents[0]);
  assert.ok(strength >= 0 && strength <= 1);
  assert.deepEqual(Object.keys(captured.field.gradient(engine.agents[0])).sort(), ["x", "y"]);

  const frame = engine.frame();
  assert.equal(frame.environment.field.cols, 30);
  assert.equal(frame.environment.field.rows, 16);
  assert.equal(frame.environment.field.values.length, 480);
  assert.ok(frame.environment.field.max > 0);
});

test("scalar field accumulates deposits and applies fractional decay", () => {
  const field = new ScalarField(100, 100, { cellSize: 10 });
  field.evolve([{ x: 25, y: 25 }], { deposit: 4, persistence: 1 });
  assert.equal(field.metrics().total, 4);
  assert.equal(field.sample({ x: 25, y: 25 }), 1);
  field.evolve([], { deposit: 0, persistence: 0.75 });
  assert.ok(Math.abs(field.metrics().total - 3) < 1e-12);
});

test("journey and exact footfall state contribute to the checksum", () => {
  const first = createEnvironmentEngine();
  const second = createEnvironmentEngine();
  assert.equal(first.frame().checksum, second.frame().checksum);

  second.agents[0].destinationId = "west";
  assert.notEqual(first.frame().checksum, second.frame().checksum);
  second.agents[0].destinationId = "east";
  second.agents[0].arrivalCount += 1;
  assert.notEqual(first.frame().checksum, second.frame().checksum);
  second.agents[0].arrivalCount -= 1;
  second.field.values[0] = Number.EPSILON;
  second.field.maximumDirty = true;
  assert.notEqual(first.frame().checksum, second.frame().checksum);
});
