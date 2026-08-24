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
    width: 40,
    height: 40,
    center: { x: x + 20, y: y + 20 },
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

function vectorApi(seekTargets) {
  return {
    subtract: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    unit: (value) => {
      const length = Math.hypot(value.x, value.y);
      return length > 0 ? { x: value.x / length, y: value.y / length } : { x: 0, y: 0 };
    },
    dot: (a, b) => a.x * b.x + a.y * b.y,
    distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
    midpoint: (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
    seek: (_self, target, strength) => {
      seekTargets.push({ ...target });
      return { x: target.x * strength, y: target.y * strength };
    },
  };
}

function runBehavior({
  cells,
  self = {},
  destination = { id: "east", x: 950, y: 325 },
  obstacles = [],
  fieldSample = () => 0,
  mine = [],
  reservation = null,
  tick = 240,
  neighborIds = {},
  circulationCells = {},
  routes = {},
  publicIds = [],
} = {}) {
  const behavior = compileBehavior(scenario.source);
  const byId = new Map((cells || []).map((entry) => [entry.id, entry]));
  const seekTargets = [];
  const routeCalls = [];
  const publicSet = new Set(publicIds);
  const decision = behavior({
    self: {
      id: 7,
      position: { x: 80, y: 325 },
      velocity: { x: 0, y: 0 },
      radius: 7,
      ...self,
    },
    destination,
    obstacles,
    field: { sample: fieldSample },
    params: { ...scenario.params },
    vec: vectorApi(seekTargets),
    world: { width: 1_000, height: 650 },
    tick,
    land: cells === undefined ? null : {
      enabled: true,
      cells,
      mine,
      reservation,
      cell: (id) => byId.get(String(id)) || null,
      neighbors: (id) => (neighborIds[String(id)] || [])
        .map((neighborId) => byId.get(neighborId))
        .filter(Boolean),
    },
    circulation: {
      enabled: true,
      cell: (id) => circulationCells[String(id)] || { role: "open", use: 0 },
      usage: (id) => circulationCells[String(id)]?.use ?? 0,
      isPublic: (id) => publicSet.has(String(id)),
      fronted: (id) => circulationCells[String(id)]?.fronted !== false,
      route: (id) => {
        const landId = String(id);
        routeCalls.push(landId);
        return routes[landId] || { reachable: false, fronted: false, arrived: false };
      },
    },
  });
  return { decision, routeCalls, seekTargets };
}

test("territory scenario couples an ordinary land grid to journeys, traces, and emergent roads", () => {
  const desirePathIndex = scenarios.findIndex(({ id }) => id === "desire-paths");
  assert.equal(scenarios[desirePathIndex + 1], scenario);
  assert.deepEqual(scenario.stage, { number: "03", label: "Territory laboratory / 03" });
  assert.deepEqual(
    scenario.summaryMetrics.map(({ key }) => key),
    ["claimedShare", "roadShare"],
  );
  assert.equal(scenario.metric.key, "meanParcelCompactness");
  assert.equal(scenario.trend.key, "claimedShare");
  assert.equal(typeof compileBehavior(scenario.source), "function");

  const { land, destinations, journeys, field, circulation } = scenario.environment;
  assert.deepEqual(
    {
      origin: land.origin,
      columns: land.columns,
      rows: land.rows,
      cellSize: land.cellSize,
      gap: land.gap,
    },
    { origin: { x: 20, y: 10 }, columns: 24, rows: 15, cellSize: 40, gap: 0 },
  );
  assert.equal(land.rightOfWay, undefined, "the preset must not author a street grid");
  assert.ok(land.origin.x + land.columns * land.cellSize <= 1_000);
  assert.ok(land.origin.y + land.rows * land.cellSize <= 650);
  assert.deepEqual(land.attributes.frontage.edges, ["north", "east", "south", "west"]);
  assert.equal(destinations.length, 4);
  assert.deepEqual(journeys, { enabled: true, spawnAtDestinations: true, arrivalRadius: 25 });
  assert.deepEqual(field, {
    enabled: true,
    cellSize: 10,
    deposit: 1,
    decay: 0.006,
    diffusion: 0.04,
  });
  assert.deepEqual(circulation, {
    enabled: true,
    sourceLayer: "land",
    entrySides: ["west", "east"],
    usePersistence: 0.94,
    reserveThreshold: 2.5,
    releaseThreshold: 1.25,
    maturityTicks: 12,
    releaseTicks: 24,
    maxNewPerTick: 2,
    roadPreference: 0.45,
    trailPreference: 0.5,
    arrivalRadius: 12,
  });
});

test("walking follows the Stage 02 preferred-route heuristic while settlement favors traffic", () => {
  const quiet = cell("land-7-2", 100, 300, { access: 0.4, amenity: 0.3 });
  const busy = cell("land-7-1", 60, 300, { access: 0.4, amenity: 0.3 });
  const blocker = { id: "claimed-centre", x: 430, y: 230, width: 140, height: 190 };
  const { decision, seekTargets } = runBehavior({
    cells: [busy, quiet],
    obstacles: [blocker],
    fieldSample: (point) => point.y < blocker.y ? 1 : 0,
    circulationCells: {
      [busy.id]: { role: "open", use: 8 },
      [quiet.id]: { role: "open", use: 3 },
    },
  });

  assert.equal(decision.reserveLand.landId, busy.id, "the busier cell should attract settlement");
  assert.ok(Number.isFinite(decision.reserveLand.bid));
  assert.equal(seekTargets.length, 1);
  assert.ok(seekTargets[0].y < blocker.y, "the reinforced upper detour should be preferred");
  assert.notDeepEqual(seekTargets[0], quiet.center, "settlement never replaces the trip target");
});

test("an actively used open cell remains reservable, but a public cell does not", () => {
  const active = cell("land-7-1", 60, 300, { access: 1, amenity: 1 });
  const contested = runBehavior({
    cells: [active],
    circulationCells: { [active.id]: { role: "open", use: 3 } },
  });
  assert.equal(contested.decision.reserveLand.landId, active.id);

  const protectedRoad = runBehavior({
    cells: [active],
    circulationCells: { [active.id]: { role: "road", use: 1 } },
  });
  assert.equal(protectedRoad.decision.reserveLand, undefined);

  const protectedByFacade = runBehavior({ cells: [active], publicIds: [active.id] });
  assert.equal(protectedByFacade.decision.reserveLand, undefined);
});

test("settlement waits for the movement warm-up before reserving traffic sites", () => {
  const active = cell("land-7-1", 60, 300, { access: 1, amenity: 1 });
  const early = runBehavior({
    cells: [active],
    tick: 0,
    circulationCells: { [active.id]: { role: "open", use: 8 } },
  });
  assert.equal(early.decision.reserveLand, undefined);

  const settled = runBehavior({
    cells: [active],
    tick: 240,
    circulationCells: { [active.id]: { role: "open", use: 8 } },
  });
  assert.equal(settled.decision.reserveLand.landId, active.id);
});

test("connected parcel growth considers only nearby cardinal neighbours", () => {
  const owned = cell("land-7-1", 60, 300, {}, { ownerId: 7 });
  const adjacent = cell("land-7-2", 100, 300, { access: 0.2 });
  const disconnected = cell("land-6-1", 60, 260, { access: 1, amenity: 1 });
  const { decision } = runBehavior({
    cells: [owned, adjacent, disconnected],
    mine: [owned.id],
    circulationCells: { [adjacent.id]: { role: "open", use: 3 } },
    neighborIds: { [owned.id]: [adjacent.id], [adjacent.id]: [owned.id] },
  });
  assert.equal(decision.reserveLand.landId, adjacent.id);
});

test("a reservation approaches public frontage and claims only when mature and arrived", () => {
  const reserved = cell("land-7-4", 180, 300, {}, { reservedBy: 7 });
  const frontageWaypoint = { x: 174, y: 320 };
  const waiting = runBehavior({
    cells: [reserved],
    reservation: { landId: reserved.id, claimable: false },
    routes: {
      [reserved.id]: {
        reachable: true,
        fronted: true,
        arrived: false,
        waypoint: frontageWaypoint,
      },
    },
  });
  assert.equal(waiting.decision.claimLand, undefined);
  assert.deepEqual(waiting.seekTargets.at(-1), frontageWaypoint);
  assert.notDeepEqual(waiting.seekTargets.at(-1), reserved.center);

  for (const route of [
    { reachable: true, fronted: false, arrived: true, waypoint: frontageWaypoint },
    { reachable: true, fronted: true, arrived: false, waypoint: frontageWaypoint },
  ]) {
    const premature = runBehavior({
      cells: [reserved],
      reservation: { landId: reserved.id, claimable: true },
      routes: { [reserved.id]: route },
    });
    assert.equal(premature.decision.claimLand, undefined);
  }

  const claiming = runBehavior({
    cells: [reserved],
    reservation: { landId: reserved.id, claimable: true },
    routes: {
      [reserved.id]: {
        reachable: true,
        fronted: true,
        arrived: true,
        waypoint: frontageWaypoint,
      },
    },
  });
  assert.deepEqual(claiming.decision.claimLand, { landId: reserved.id });
  assert.equal(claiming.decision.reserveLand, undefined);
});

test("the rule keeps walking when territory observations are unavailable", () => {
  const { decision, seekTargets } = runBehavior({ cells: undefined });
  assert.equal(decision.reserveLand, undefined);
  assert.equal(decision.claimLand, undefined);
  assert.deepEqual(seekTargets, [{ x: 950, y: 325 }]);
  assert.ok([decision.acceleration.x, decision.acceleration.y].every(Number.isFinite));
});
