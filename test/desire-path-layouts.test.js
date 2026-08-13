import assert from "node:assert/strict";
import test from "node:test";

import { getScenario, copyParameters } from "../src/scenarios.js";
import { createBlockGrid } from "../src/layout-tools.js";
import { compileBehavior } from "../src/simulation/compiler.js";
import { SimulationEngine } from "../src/simulation/engine.js";

const scenario = getScenario("desire-paths");
const layouts = {
  "central block": scenario.environment.obstacles,
  "two-row street grid": Array.from({ length: 6 }, (_, index) => ({
    id: `street-${index}`,
    x: 350 + (index % 3) * 115,
    y: 205 + Math.floor(index / 3) * 135,
    width: 82,
    height: 100,
  })),
  "staggered block grid": [
    { id: "stagger-a", x: 300, y: 200, width: 90, height: 240 },
    { id: "stagger-b", x: 445, y: 255, width: 90, height: 240 },
    { id: "stagger-c", x: 590, y: 155, width: 90, height: 240 },
  ],
};

function runLayout(obstacles, trailInfluence = 1) {
  const engine = new SimulationEngine({
    behavior: compileBehavior(scenario.source),
    ruleKey: scenario.source,
    seed: 2026,
    population: 20,
    width: 1_000,
    height: 650,
    params: { ...copyParameters(scenario), trailInfluence },
    relationMode: scenario.relationMode,
    environment: { ...scenario.environment, obstacles },
  });

  for (let tick = 0; tick < 1_800; tick += 1) {
    assert.equal(engine.step().ok, true);
    assertSafeAgents(engine, obstacles, tick);
  }
  return engine.metrics();
}

function assertSafeAgents(engine, obstacles, tick) {
  for (const agent of engine.agents) {
    assert.ok([agent.x, agent.y, agent.vx, agent.vy].every(Number.isFinite));
    assert.ok(agent.x >= agent.radius && agent.x <= engine.width - agent.radius);
    assert.ok(agent.y >= agent.radius && agent.y <= engine.height - agent.radius);
    for (const block of obstacles) {
      const nearestX = Math.max(block.x, Math.min(block.x + block.width, agent.x));
      const nearestY = Math.max(block.y, Math.min(block.y + block.height, agent.y));
      assert.ok(
        Math.hypot(agent.x - nearestX, agent.y - nearestY) >= agent.radius - 1e-7,
        `agent ${agent.id} penetrated ${block.id} at tick ${tick}`,
      );
    }
  }
}

function behaviorTarget({
  position,
  goal,
  obstacle,
  radius = 7,
  id = 0,
  fieldSample = () => 0,
  trailInfluence = 0,
}) {
  const behavior = compileBehavior(scenario.source);
  let target = null;
  const vec = {
    subtract: (first, second) => ({ x: first.x - second.x, y: first.y - second.y }),
    unit: (vector) => {
      const length = Math.hypot(vector.x, vector.y) || 1;
      return { x: vector.x / length, y: vector.y / length };
    },
    dot: (first, second) => first.x * second.x + first.y * second.y,
    distance: (first, second) => Math.hypot(first.x - second.x, first.y - second.y),
    midpoint: (first, second) => ({
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    }),
    seek: (_self, nextTarget) => {
      target = nextTarget;
      return { x: 0, y: 0 };
    },
  };
  behavior({
    self: { id, position, velocity: { x: 0, y: 0 }, radius },
    destination: { id: "goal", ...goal },
    obstacles: [obstacle],
    field: { sample: fieldSample },
    params: { ...copyParameters(scenario), trailInfluence },
    vec,
    world: { width: 1_000, height: 650 },
  });
  return target;
}

test("desire-path rule completes safe journeys through editable block layouts", () => {
  assert.equal(scenario.editableLayout, true);
  for (const [name, obstacles] of Object.entries(layouts)) {
    const metrics = runLayout(obstacles);
    assert.ok(metrics.trips >= 10, `${name} completed only ${metrics.trips} trips`);
  }
});

test("trail influence remains an observable control comparison", () => {
  const control = runLayout(layouts["central block"], 0);
  const feedback = runLayout(layouts["central block"], 1);
  assert.ok(feedback.trailConcentration > control.trailConcentration + 0.05);
});

test("a walker touching any perpendicular face receives an outward route", () => {
  const obstacle = { id: "block", x: 380, y: 240, width: 160, height: 120 };
  const radius = 7;
  const cases = [
    { position: { x: obstacle.x - radius, y: 300 }, goal: { x: 800, y: 300 }, normal: { x: -1, y: 0 } },
    { position: { x: obstacle.x + obstacle.width + radius, y: 300 }, goal: { x: 200, y: 300 }, normal: { x: 1, y: 0 } },
    { position: { x: 460, y: obstacle.y - radius }, goal: { x: 460, y: 540 }, normal: { x: 0, y: -1 } },
    { position: { x: 460, y: obstacle.y + obstacle.height + radius }, goal: { x: 460, y: 80 }, normal: { x: 0, y: 1 } },
  ];

  for (const offset of [0, 1, 2.9]) {
    for (const sample of cases) {
      const position = {
        x: sample.position.x + sample.normal.x * offset,
        y: sample.position.y + sample.normal.y * offset,
      };
      const farSideTrace = (point) => {
        const outwardDistance =
          (point.x - position.x) * sample.normal.x +
          (point.y - position.y) * sample.normal.y;
        return outwardDistance < -20 ? 1 : 0;
      };
      for (const condition of [
        { fieldSample: () => 0, trailInfluence: 0 },
        { fieldSample: farSideTrace, trailInfluence: 2 },
      ]) {
        const target = behaviorTarget({
          position,
          goal: sample.goal,
          obstacle,
          radius,
          ...condition,
        });
        const outwardProgress =
          (target.x - position.x) * sample.normal.x +
          (target.y - position.y) * sample.normal.y;
        assert.ok(outwardProgress >= -1e-9, JSON.stringify({ position, target, sample, condition }));
        assert.notDeepEqual(target, sample.goal);
      }
    }
  }
});

test("orthogonal grids remain traversable at narrow and classroom street widths", () => {
  const cases = [
    { gap: 24, population: 3, ticks: 900, bounds: { x: 320, y: 190, width: 360, height: 270 } },
    { gap: 36, population: 36, ticks: 1_200, bounds: { x: 300, y: 175, width: 400, height: 300 } },
  ];

  for (const definition of cases) {
    const obstacles = createBlockGrid(definition.bounds, {
      rows: 3,
      columns: 4,
      gap: definition.gap,
      idPrefix: `grid-${definition.gap}`,
    });
    const engine = new SimulationEngine({
      behavior: compileBehavior(scenario.source),
      ruleKey: scenario.source,
      seed: 2026,
      population: definition.population,
      width: 1_000,
      height: 650,
      params: { ...copyParameters(scenario), trailInfluence: 0 },
      relationMode: scenario.relationMode,
      environment: { ...scenario.environment, obstacles },
    });

    for (let tick = 0; tick < definition.ticks; tick += 1) {
      assert.equal(engine.step().ok, true);
      assertSafeAgents(engine, obstacles, tick);
    }
    assert.ok(
      engine.agents.every((agent) => agent.arrivalCount >= 1),
      `${definition.gap}-unit grid left ${engine.agents.filter((agent) => agent.arrivalCount < 1).length} walkers pinned`,
    );
  }
});

test("desire paths complete vertical and diagonal trips among weighted gates", () => {
  const destinations = [
    { id: "north", label: "North gate", x: 500, y: 70, radius: 30, weight: 4 },
    { id: "southwest", label: "Southwest gate", x: 100, y: 555, radius: 30, weight: 2 },
    { id: "east", label: "East gate", x: 905, y: 315, radius: 30, weight: 3 },
    { id: "south", label: "South gate", x: 520, y: 580, radius: 30, weight: 1 },
  ];
  const obstacles = [
    { id: "centre", x: 410, y: 220, width: 180, height: 190 },
    { id: "northwest", x: 245, y: 145, width: 105, height: 135 },
    { id: "southeast", x: 650, y: 390, width: 105, height: 115 },
  ];
  const engine = new SimulationEngine({
    behavior: compileBehavior(scenario.source),
    ruleKey: scenario.source,
    seed: 2026,
    population: 24,
    width: 1_000,
    height: 650,
    params: copyParameters(scenario),
    relationMode: scenario.relationMode,
    environment: { ...scenario.environment, destinations, obstacles },
  });
  const gateById = new Map(destinations.map((destination) => [destination.id, destination]));
  const legOrigins = new Map(
    engine.agents.map((agent) => [agent.id, destinations[agent.id % destinations.length].id]),
  );
  const previousTargets = new Map(engine.agents.map((agent) => [agent.id, agent.destinationId]));
  const completedLegs = [];

  for (let tick = 0; tick < 1_800; tick += 1) {
    assert.equal(engine.step().ok, true);
    assertSafeAgents(engine, obstacles, tick);
    for (const agent of engine.agents) {
      const previousTarget = previousTargets.get(agent.id);
      if (agent.destinationId === previousTarget) continue;
      completedLegs.push({ from: legOrigins.get(agent.id), to: previousTarget });
      legOrigins.set(agent.id, previousTarget);
      previousTargets.set(agent.id, agent.destinationId);
    }
  }

  assert.ok(engine.metrics().trips >= 100, `completed only ${engine.metrics().trips} trips`);
  assert.deepEqual(
    new Set(completedLegs.flatMap((leg) => [leg.from, leg.to])),
    new Set(destinations.map((destination) => destination.id)),
  );
  assert.ok(completedLegs.some((leg) => {
    const from = gateById.get(leg.from);
    const to = gateById.get(leg.to);
    return Math.abs(from.x - to.x) < 50 && Math.abs(from.y - to.y) > 300;
  }), "no north–south trip completed");
  assert.ok(completedLegs.some((leg) => {
    const from = gateById.get(leg.from);
    const to = gateById.get(leg.to);
    return Math.abs(from.x - to.x) > 250 && Math.abs(from.y - to.y) > 200;
  }), "no diagonal trip completed");
});
