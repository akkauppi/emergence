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
  params = {},
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
    params: { ...scenario.params, ...params },
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
    reserveThreshold: 18,
    formationTicks: 10,
    releaseThreshold: 6,
    maturityTicks: 24,
    releaseTicks: 60,
    maxNewPerTick: 1,
    roadPreference: 0.45,
    trailPreference: 0.5,
    arrivalRadius: 12,
    flowResolution: 16,
    flowAngleBins: 24,
    flowPersistence: 0.96,
    flowTraceThreshold: 0.9,
    flowPathThreshold: 5.5,
    flowFormationTicks: 5,
    flowReleaseThreshold: 2,
    flowReleaseTicks: 45,
    pressurePersistence: 0.98,
    pressureDetourRatio: 1.18,
    pressureDetourDistance: 60,
    pressureContribution: 0.24,
    easementPressureThreshold: 14,
    easementWidth: 15,
    easementUsePersistence: 0.97,
    easementAcquisitionThreshold: 15,
    easementAcquisitionTicks: 24,
  });
  assert.deepEqual(
    {
      viewAngle: scenario.params.viewAngle,
      viewDepth: scenario.params.viewDepth,
      routeMomentum: scenario.params.routeMomentum,
    },
    { viewAngle: 110, viewDepth: 70, routeMomentum: 0.55 },
  );
  assert.ok(scenario.controls.some(({ key }) => key === "viewAngle"));
});

test("walking follows desire lines while settlement favors busy public frontage", () => {
  const quiet = cell("land-7-2", 100, 300, { access: 0.4, amenity: 0.3 });
  const busy = cell("land-7-1", 60, 300, { access: 0.4, amenity: 0.3 });
  const busyPath = cell("land-8-1", 60, 340);
  const quietPath = cell("land-8-2", 100, 340);
  const blocker = { id: "claimed-centre", x: 142, y: 230, width: 140, height: 190 };
  const { decision, seekTargets } = runBehavior({
    cells: [busy, quiet, busyPath, quietPath],
    obstacles: [blocker],
    fieldSample: (point) => point.y < 325 ? 1 : 0,
    neighborIds: {
      [busy.id]: [busyPath.id],
      [quiet.id]: [quietPath.id],
    },
    circulationCells: {
      [busyPath.id]: { role: "road", use: 8 },
      [quietPath.id]: { role: "road", use: 3 },
    },
  });

  assert.equal(decision.reserveLand.landId, busy.id, "the busier cell should attract settlement");
  assert.ok(Number.isFinite(decision.reserveLand.bid));
  assert.equal(seekTargets.length, 1);
  assert.ok(seekTargets[0].y < 325, "the reinforced upper local alternative should be preferred");
  assert.notDeepEqual(seekTargets[0], quiet.center, "settlement never replaces the trip target");
});

test("wayfinding is bounded and does not plan around a distant blocker", () => {
  const distant = { id: "distant", x: 430, y: 230, width: 140, height: 190 };
  const { seekTargets } = runBehavior({ cells: undefined, obstacles: [distant] });

  assert.equal(seekTargets.length, 1);
  assert.deepEqual(seekTargets[0], { x: 150, y: 325 });
  assert.equal(Math.hypot(seekTargets[0].x - 80, seekTargets[0].y - 325), scenario.params.viewDepth);
});

test("local traces can bend a walker's next step inside the forward view", () => {
  const { seekTargets } = runBehavior({
    cells: undefined,
    fieldSample: (point) => point.y < 325 ? 1 : 0,
  });

  assert.equal(seekTargets.length, 1);
  assert.ok(seekTargets[0].x > 80);
  assert.ok(seekTargets[0].y < 325);
  const angle = Math.abs(Math.atan2(seekTargets[0].y - 325, seekTargets[0].x - 80));
  assert.ok(angle <= scenario.params.viewAngle * Math.PI / 360 + 0.000001);
});

test("a nearby claimed block redirects the local step without exposing a complete route", () => {
  const nearby = { id: "nearby", x: 132, y: 285, width: 90, height: 80 };
  const { seekTargets } = runBehavior({ cells: undefined, obstacles: [nearby] });

  assert.equal(seekTargets.length, 1);
  assert.ok(Math.abs(seekTargets[0].y - 325) > 1);
  assert.ok(
    seekTargets[0].x < nearby.x ||
    seekTargets[0].x > nearby.x + nearby.width ||
    seekTargets[0].y < nearby.y ||
    seekTargets[0].y > nearby.y + nearby.height,
  );
});

test("a site beside active frontage remains reservable, but a public cell does not", () => {
  const active = cell("land-7-1", 60, 300, { access: 1, amenity: 1 });
  const frontage = cell("land-8-1", 60, 340);
  const contested = runBehavior({
    cells: [active, frontage],
    neighborIds: { [active.id]: [frontage.id] },
    circulationCells: { [frontage.id]: { role: "road", use: 3 } },
  });
  assert.equal(contested.decision.reserveLand.landId, active.id);

  const protectedRoad = runBehavior({
    cells: [active, frontage],
    neighborIds: { [active.id]: [frontage.id] },
    circulationCells: {
      [active.id]: { role: "road", use: 1 },
      [frontage.id]: { role: "road", use: 3 },
    },
  });
  assert.equal(protectedRoad.decision.reserveLand, undefined);

  const protectedByFacade = runBehavior({ cells: [active], publicIds: [active.id] });
  assert.equal(protectedByFacade.decision.reserveLand, undefined);
});

test("settlement waits for the movement warm-up before reserving frontage sites", () => {
  const active = cell("land-7-1", 60, 300, { access: 1, amenity: 1 });
  const frontage = cell("land-8-1", 60, 340);
  const early = runBehavior({
    cells: [active, frontage],
    tick: 0,
    neighborIds: { [active.id]: [frontage.id] },
    circulationCells: { [frontage.id]: { role: "road", use: 8 } },
  });
  assert.equal(early.decision.reserveLand, undefined);

  const settled = runBehavior({
    cells: [active, frontage],
    tick: 240,
    neighborIds: { [active.id]: [frontage.id] },
    circulationCells: { [frontage.id]: { role: "road", use: 8 } },
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
  assert.deepEqual(seekTargets, [{ x: 150, y: 325 }]);
  assert.ok([decision.acceleration.x, decision.acceleration.y].every(Number.isFinite));
});
