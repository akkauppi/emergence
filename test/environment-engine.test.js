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
  assert.equal(engine.metrics().trips, 1);
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
  second.field.values[0] = Number.EPSILON;
  second.field.maximumDirty = true;
  assert.notEqual(first.frame().checksum, second.frame().checksum);
});
