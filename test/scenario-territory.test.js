import assert from "node:assert/strict";
import test from "node:test";

import { getScenario, scenarios } from "../src/scenarios.js";
import { compileBehavior } from "../src/simulation/compiler.js";

const scenario = getScenario("territory-growth");

function cell(id, x, y, attributes = {}, tenure = {}) {
  return {
    id,
    x,
    y,
    width: 36,
    height: 36,
    center: { x: x + 18, y: y + 18 },
    access: 0,
    amenity: 0,
    terrain: 0,
    cost: 0,
    ownerId: null,
    reservedBy: null,
    ...attributes,
    ...tenure,
  };
}

function runBehavior({ cells, mine = [], reservation = null, neighborIds = {}, tick = 0 }) {
  const behavior = compileBehavior(scenario.source);
  const byId = new Map(cells.map((entry) => [entry.id, entry]));
  return behavior({
    self: {
      id: 7,
      position: { x: 50, y: 50 },
      velocity: { x: 0, y: 0 },
      radius: 7,
    },
    params: { ...scenario.params },
    vec: {
      seek: (_self, target, strength) => ({ x: target.x * strength, y: target.y * strength }),
    },
    world: { width: 1_000, height: 650 },
    tick,
    land: {
      enabled: true,
      cells,
      mine,
      reservation,
      cell: (id) => byId.get(String(id)) || null,
      neighbors: (id) => (neighborIds[String(id)] || []).map((neighborId) => byId.get(neighborId)),
    },
  });
}

test("territory scenario follows Stage 03's authored grid and metric contract", () => {
  const desirePathIndex = scenarios.findIndex(({ id }) => id === "desire-paths");
  assert.equal(scenarios[desirePathIndex + 1], scenario);
  assert.deepEqual(scenario.stage, { number: "03", label: "Territory laboratory / 03" });
  assert.deepEqual(
    scenario.summaryMetrics.map(({ key }) => key),
    ["claimedShare", "landConflicts"],
  );
  assert.equal(scenario.metric.key, "meanParcelCompactness");
  assert.equal(scenario.trend.key, "claimedShare");
  assert.equal(typeof compileBehavior(scenario.source), "function");

  const land = scenario.environment.land;
  assert.equal(land.enabled, true);
  assert.ok(land.columns * land.rows >= 72);
  assert.ok(
    land.origin.x + land.columns * land.cellSize + (land.columns - 1) * land.gap <= 1_000,
  );
  assert.ok(
    land.origin.y + land.rows * land.cellSize + (land.rows - 1) * land.gap <= 650,
  );
  assert.deepEqual(land.attributes.frontage.edges, ["west", "east"]);
  assert.deepEqual(land.policy, {
    reservationTicks: 18,
    expiryTicks: 90,
    requireContiguous: true,
    maxReservationsPerOwner: 1,
  });
});

test("territory rule reserves the best deterministic eligible site", () => {
  const accessible = cell("land-0-0", 40, 40, {
    access: 1,
    amenity: 1,
    terrain: 0,
    cost: 0.1,
  });
  const remote = cell("land-0-1", 850, 550, {
    access: 0,
    amenity: 0,
    terrain: 1,
    cost: 2,
  });

  const decision = runBehavior({ cells: [remote, accessible] });
  assert.equal(decision.reserveLand.landId, accessible.id);
  assert.ok(Number.isFinite(decision.reserveLand.bid));
  assert.ok(decision.reserveLand.bid > 0);
  assert.equal(decision.claimLand, undefined);
  assert.ok([decision.acceleration.x, decision.acceleration.y].every(Number.isFinite));
});

test("territory rule grows only through cardinal parcel neighbours", () => {
  const owned = cell("land-1-1", 100, 100, {}, { ownerId: 7 });
  const adjacent = cell("land-1-2", 138, 100, {
    access: 0.1,
    amenity: 0,
    cost: 1,
  });
  const disconnected = cell("land-8-8", 800, 500, {
    access: 1,
    amenity: 1,
    cost: 0,
  });
  const decision = runBehavior({
    cells: [owned, disconnected, adjacent],
    mine: [owned.id],
    neighborIds: {
      [owned.id]: [adjacent.id],
      [adjacent.id]: [owned.id],
    },
  });

  assert.deepEqual(decision.reserveLand.landId, adjacent.id);
});

test("territory rule waits for its reservation then emits exactly one claim intent", () => {
  const reserved = cell("land-2-3", 200, 160, {}, { reservedBy: 7 });
  const waiting = runBehavior({
    cells: [reserved],
    reservation: { landId: reserved.id, claimable: false, claimableAt: 12 },
    tick: 11,
  });
  assert.equal(waiting.reserveLand, undefined);
  assert.equal(waiting.claimLand, undefined);

  const claiming = runBehavior({
    cells: [reserved],
    reservation: { landId: reserved.id, claimable: true, claimableAt: 12 },
    tick: 12,
  });
  assert.equal(claiming.reserveLand, undefined);
  assert.deepEqual(claiming.claimLand, { landId: reserved.id });
  assert.ok([claiming.acceleration.x, claiming.acceleration.y].every(Number.isFinite));
});

test("territory rule remains a valid movement rule when land is unavailable", () => {
  const behavior = compileBehavior(scenario.source);
  const decision = behavior({
    self: { id: 0, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } },
    params: scenario.params,
    vec: {},
    world: { width: 1_000, height: 650 },
    tick: 0,
    land: null,
  });
  assert.deepEqual(decision, { acceleration: { x: 0, y: 0 } });
});
