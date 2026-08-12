import assert from "node:assert/strict";
import test from "node:test";

import { compileBehavior } from "../src/simulation/compiler.js";
import { SimulationEngine } from "../src/simulation/engine.js";
import { getScenario, scenarios } from "../src/scenarios.js";

function createEngine(scenarioId, overrides = {}) {
  const scenario = getScenario(scenarioId);
  return new SimulationEngine({
    behavior: compileBehavior(scenario.source),
    seed: 2026,
    population: 72,
    params: scenario.params,
    relationMode: scenario.relationMode,
    ...overrides,
  });
}

test("all bundled behavior examples compile", () => {
  for (const scenario of scenarios) {
    assert.equal(typeof compileBehavior(scenario.source), "function", scenario.id);
  }
});

test("agent references are stable, distinct, and never self-references", () => {
  const engine = createEngine("between", { population: 80, seed: 14 });
  const firstReferences = engine.agents.map((agent) => [...agent.chosen]);

  for (const agent of engine.agents) {
    assert.notEqual(agent.chosen[0], agent.id);
    assert.notEqual(agent.chosen[1], agent.id);
    assert.notEqual(agent.chosen[0], agent.chosen[1]);
  }

  engine.step(40);
  assert.deepEqual(
    engine.agents.map((agent) => agent.chosen),
    firstReferences,
  );
  engine.reset();
  assert.deepEqual(
    engine.agents.map((agent) => agent.chosen),
    firstReferences,
  );
});

test("same seed and behavior produce the same state checksum", () => {
  const first = createEngine("between", { seed: 9981 });
  const second = createEngine("between", { seed: 9981 });

  assert.equal(first.frame().checksum, second.frame().checksum);
  first.step(240);
  second.step(240);
  assert.equal(first.frame().checksum, second.frame().checksum);
  assert.deepEqual(first.frame().metrics, second.frame().metrics);
});

test("the midpoint rule visibly contracts the group", () => {
  const engine = createEngine("between");
  const initial = engine.metrics();
  const result = engine.step(300);
  const final = engine.metrics();

  assert.equal(result.ok, true);
  assert.ok(final.spread < initial.spread * 0.45, `${initial.spread} -> ${final.spread}`);
  assert.ok(final.match > initial.match + 40, `${initial.match} -> ${final.match}`);
});

test("the shielding rule expands the group under the same seed", () => {
  const engine = createEngine("shield");
  const initial = engine.metrics();
  const result = engine.step(300);
  const final = engine.metrics();

  assert.equal(result.ok, true);
  assert.ok(final.spread > initial.spread * 1.2, `${initial.spread} -> ${final.spread}`);
  assert.ok(final.match > initial.match, `${initial.match} -> ${final.match}`);
});

test("invalid intents stop before corrupting canonical state", () => {
  const engine = new SimulationEngine({
    behavior: () => ({ acceleration: { x: Number.NaN, y: 0 } }),
    population: 12,
  });
  const checksum = engine.frame().checksum;
  const result = engine.step();

  assert.equal(result.ok, false);
  assert.match(result.error.message, /finite numbers/);
  assert.equal(engine.tick, 0);
  assert.equal(engine.frame().checksum, checksum);
});

test("extreme valid acceleration is clamped and remains inside the room", () => {
  const engine = new SimulationEngine({
    behavior: () => ({ acceleration: { x: 1e12, y: -1e12 } }),
    population: 24,
    params: { maxSpeed: 120 },
  });
  assert.equal(engine.step(500).ok, true);

  for (const agent of engine.agents) {
    assert.ok(Number.isFinite(agent.x) && Number.isFinite(agent.y));
    assert.ok(agent.x >= agent.radius && agent.x <= engine.width - agent.radius);
    assert.ok(agent.y >= agent.radius && agent.y <= engine.height - agent.radius);
    assert.ok(Math.hypot(agent.vx, agent.vy) <= 120.000_001);
  }
});

test("the compiler rejects unsupported modules and missing behave functions", () => {
  assert.throws(() => compileBehavior("import x from 'elsewhere';"), /Imports and exports/);
  assert.throws(() => compileBehavior("const answer = 42;"), /Define a function named behave/);
});
