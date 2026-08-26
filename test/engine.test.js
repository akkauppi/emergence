import assert from "node:assert/strict";
import test from "node:test";

import { compileBehavior } from "../src/simulation/compiler.js";
import { SimulationEngine } from "../src/simulation/engine.js";
import { equilateralApex, nearestEquilateralApex } from "../src/simulation/geometry.js";
import { getScenario, scenarios } from "../src/scenarios.js";

function createEngine(scenarioId, overrides = {}) {
  const scenario = getScenario(scenarioId);
  return new SimulationEngine({
    behavior: compileBehavior(scenario.source),
    ruleKey: scenario.source,
    seed: 2026,
    population: 72,
    params: scenario.params,
    relationMode: scenario.relationMode,
    ...overrides,
  });
}

test("all bundled behavior examples compile", () => {
  for (const scenario of scenarios.filter((candidate) => candidate.kind !== "life")) {
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

test("live frames can skip checksum work without changing visible state", () => {
  const engine = createEngine("between");
  engine.step(12);
  const exact = engine.frame();
  const live = engine.frame({ includeChecksum: false });

  assert.equal(live.checksum, null);
  assert.deepEqual({ ...live, checksum: exact.checksum }, exact);
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
  assert.throws(() => compileBehavior("function behave(){ Math.random(); }"), /provided random/);
  assert.throws(() => compileBehavior("function behave(){ Math['random'](); }"), /provided random/);
  assert.throws(() => compileBehavior("function behave(){ globalThis.answer = 42; }"), /globalThis/);
});

test("equilateral apexes preserve side length and reflect across the base", () => {
  const a = { x: 17, y: 31 };
  const b = { x: 93, y: 62 };
  const clockwise = equilateralApex(a, b, 1);
  const counterclockwise = equilateralApex(a, b, -1);
  const side = Math.hypot(b.x - a.x, b.y - a.y);

  assert.ok(Math.abs(Math.hypot(clockwise.x - a.x, clockwise.y - a.y) - side) < 1e-9);
  assert.ok(Math.abs(Math.hypot(clockwise.x - b.x, clockwise.y - b.y) - side) < 1e-9);
  assert.ok(Math.abs(Math.hypot(counterclockwise.x - a.x, counterclockwise.y - a.y) - side) < 1e-9);
  assert.equal(clockwise.x + counterclockwise.x, a.x + b.x);
  assert.equal(clockwise.y + counterclockwise.y, a.y + b.y);

  const cross = (b.x - a.x) * (clockwise.y - a.y) - (b.y - a.y) * (clockwise.x - a.x);
  assert.ok(cross > 0, "+1 should be clockwise in screen coordinates");
  assert.deepEqual(equilateralApex(a, a, 1), a);
  assert.deepEqual(nearestEquilateralApex(clockwise, a, b), clockwise);
});

test("delayed sensing uses immutable historical snapshots", () => {
  const observedTicks = [];
  let firstHistoricalPosition;
  const behavior = ({ self, sense }) => {
    if (self.id === 0) {
      const observation = sense(3);
      observedTicks.push(observation.tick);
      firstHistoricalPosition ??= observation.chosen[0].position;
      assert.ok(Object.isFrozen(observation));
      assert.ok(Object.isFrozen(observation.chosen));
      assert.ok(Object.isFrozen(observation.chosen[0].position));
    }
    return { acceleration: { x: 8, y: -3 } };
  };
  const engine = new SimulationEngine({ behavior, population: 12, seed: 71 });
  assert.equal(engine.step().ok, true);
  const original = { ...firstHistoricalPosition };
  assert.equal(engine.step(4).ok, true);
  assert.deepEqual(observedTicks, [0, 0, 0, 0, 1]);
  assert.deepEqual(firstHistoricalPosition, original);
});

test("sensing caches observations and exposes neighbors lazily", () => {
  let probed = false;
  const engine = new SimulationEngine({
    population: 12,
    behavior: (context) => {
      if (context.self.id === 0) {
        const first = context.sense(3);
        const second = context.sense(3);
        assert.equal(first, second);
        assert.equal(typeof Object.getOwnPropertyDescriptor(context, "neighbors").get, "function");
        assert.equal(typeof Object.getOwnPropertyDescriptor(first, "neighbors").get, "function");
        assert.equal(context.neighbors, context.neighbors);
        assert.equal(first.neighbors, first.neighbors);
        probed = true;
      }
      return { acceleration: { x: 0, y: 0 } };
    },
  });

  assert.equal(engine.step().ok, true);
  assert.equal(probed, true);
});

test("frame distinguishes configured delay from startup observation age", () => {
  const engine = createEngine("between", {
    params: { ...getScenario("between").params, delayTicks: 7 },
  });

  assert.equal(engine.frame().configuredDelayTicks, 7);
  assert.equal(engine.frame().observationAge, 0);
  engine.step(3);
  assert.equal(engine.frame().configuredDelayTicks, 7);
  assert.equal(engine.frame().observationAge, 3);
  assert.equal(engine.frame().delayTicks, 3);
});

test("rule match scores current agents against their delayed references", () => {
  const engine = new SimulationEngine({
    population: 12,
    seed: 91,
    relationMode: "midpoint",
    params: { delayTicks: 1 },
    behavior: () => ({ acceleration: { x: 0, y: 0 } }),
  });
  engine.step(3);
  const delayedViews = engine.observationHistory.at(-2).views;
  const movedId = engine.agents[0].chosen[0];
  const moved = engine.agents[movedId];
  engine.perturbAgent(movedId, {
    x: moved.x < engine.width / 2 ? engine.width : 0,
    y: moved.y < engine.height / 2 ? engine.height : 0,
  });

  const midpointScore = (references) => {
    const byId = new Map(references.map((reference) => [reference.id, reference.position || reference]));
    let error = 0;
    for (const self of engine.agents) {
      const first = byId.get(self.chosen[0]);
      const second = byId.get(self.chosen[1]);
      error += Math.hypot(self.x - (first.x + second.x) / 2, self.y - (first.y + second.y) / 2);
    }
    return Math.max(0, Math.min(100, Math.exp(-(error / engine.agents.length) / 82) * 100));
  };

  const actual = engine.metrics().match;
  const delayed = midpointScore(delayedViews);
  const current = midpointScore(engine.agents);
  assert.ok(Math.abs(actual - delayed) < 1e-12, `${actual} != ${delayed}`);
  assert.ok(Math.abs(actual - current) > 1e-6, `${actual} unexpectedly matched ${current}`);
});

test("failed steps do not append delayed observation history", () => {
  let fail = false;
  const engine = new SimulationEngine({
    population: 12,
    behavior: () => {
      if (fail) throw new Error("stop");
      return { acceleration: { x: 0, y: 0 } };
    },
  });
  engine.step(3);
  const length = engine.observationHistory.length;
  fail = true;
  assert.equal(engine.step().ok, false);
  assert.equal(engine.observationHistory.length, length);
  assert.equal(engine.tick, 3);
});

test("perturbation is atomic, bounded, and replayable", () => {
  const first = createEngine("between", { seed: 404 });
  const second = createEngine("between", { seed: 404 });
  first.step(30);
  second.step(30);
  const references = [...first.agents[4].chosen];
  const tick = first.tick;

  const intervention = first.perturbAgent(4, { x: -200, y: 900 }, { sequence: 1 });
  second.perturbAgent(4, { x: -200, y: 900 }, { sequence: 1 });

  assert.equal(intervention.ok, true);
  assert.equal(first.tick, tick);
  assert.equal(first.agents[4].x, first.agents[4].radius);
  assert.equal(first.agents[4].y, first.height - first.agents[4].radius);
  assert.equal(first.agents[4].vx, 0);
  assert.equal(first.agents[4].vy, 0);
  assert.deepEqual(first.agents[4].chosen, references);
  assert.equal(first.frame().checksum, second.frame().checksum);

  first.step(50);
  second.step(50);
  assert.equal(first.frame().checksum, second.frame().checksum);
});

test("current sensing sees a perturbation while delayed sensing keeps the prior tick", () => {
  let probe = false;
  let captured;
  const behavior = ({ self, sense }) => {
    if (probe && self.id === 0) {
      captured = {
        current: { ...sense(0).chosen[0].position },
        delayed: { ...sense(1).chosen[0].position },
      };
    }
    return { acceleration: { x: 0, y: 0 } };
  };
  const engine = new SimulationEngine({ behavior, population: 12, seed: 123 });
  engine.step(5);
  const chosenId = engine.agents[0].chosen[0];
  const previous = { ...engine.observationHistory.at(-2).views[chosenId].position };
  engine.perturbAgent(chosenId, { x: 500, y: 320 });
  const moved = engine.agents.find((agent) => agent.id === chosenId);
  probe = true;
  engine.step();

  assert.deepEqual(captured.current, { x: moved.x, y: moved.y });
  assert.deepEqual(captured.delayed, previous);
});

test("delay configuration contributes to the replay checksum", () => {
  const noDelay = createEngine("between");
  const delayed = createEngine("between", {
    params: { ...getScenario("between").params, delayTicks: 12 },
  });

  assert.notEqual(noDelay.frame().checksum, delayed.frame().checksum);
});

test("dynamics configuration and behavior identity contribute to the checksum", () => {
  const scenario = getScenario("triangle-chiral");
  const clockwise = createEngine("triangle-chiral");
  const counterclockwise = createEngine("triangle-chiral", {
    params: { ...scenario.params, chirality: -1 },
  });
  const otherRule = createEngine("triangle-chiral", { ruleKey: `${scenario.source}\n// variant` });

  assert.notEqual(clockwise.frame().checksum, counterclockwise.frame().checksum);
  assert.notEqual(clockwise.frame().checksum, otherRule.frame().checksum);
});

test("recompiling a stateful program before reset restores a fresh deterministic run", () => {
  const source = `let calls = 0;
function behave() {
  calls += 1;
  return { acceleration: { x: calls % 11, y: -(calls % 7) } };
}`;
  const engine = new SimulationEngine({
    behavior: compileBehavior(source),
    seed: 55,
    population: 12,
  });
  engine.step(24);
  const expected = engine.frame().checksum;

  engine.setBehavior(compileBehavior(source));
  engine.reset();
  engine.step(24);
  assert.equal(engine.frame().checksum, expected);
});

test("invalid perturbations leave state unchanged", () => {
  const engine = createEngine("between");
  const checksum = engine.frame().checksum;
  assert.equal(engine.perturbAgent(999, { x: 2, y: 3 }).ok, false);
  assert.equal(engine.perturbAgent(0, { x: Number.NaN, y: 3 }).ok, false);
  assert.equal(engine.frame().checksum, checksum);
});

test("storage order and step chunking do not alter a run", () => {
  const oneChunk = createEngine("triangle-chiral", { seed: 83 });
  const manyChunks = createEngine("triangle-chiral", { seed: 83 });
  manyChunks.agents.reverse();

  oneChunk.step(90);
  for (let index = 0; index < 90; index += 1) manyChunks.step();
  assert.equal(oneChunk.frame().checksum, manyChunks.frame().checksum);
});

test("all triangle examples stay finite and bounded", () => {
  for (const scenarioId of ["triangle-nearest", "triangle-chiral"]) {
    const engine = createEngine(scenarioId, { population: 48 });
    assert.equal(engine.step(360).ok, true, scenarioId);
    for (const agent of engine.agents) {
      assert.ok(Number.isFinite(agent.x) && Number.isFinite(agent.y), scenarioId);
      assert.ok(agent.x >= agent.radius && agent.x <= engine.width - agent.radius, scenarioId);
      assert.ok(agent.y >= agent.radius && agent.y <= engine.height - agent.radius, scenarioId);
    }
  }
});
