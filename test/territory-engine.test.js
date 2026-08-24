import assert from "node:assert/strict";
import test from "node:test";

import { getScenario } from "../src/scenarios.js";
import { compileBehavior } from "../src/simulation/compiler.js";
import { SimulationEngine } from "../src/simulation/engine.js";

const scenario = getScenario("territory-growth");

function createTerritoryEngine(overrides = {}) {
  return new SimulationEngine({
    behavior: compileBehavior(scenario.source),
    ruleKey: scenario.source,
    seed: 2026,
    population: 72,
    width: 1_000,
    height: 650,
    params: { ...scenario.params },
    relationMode: scenario.relationMode,
    environment: scenario.environment,
    ...overrides,
  });
}

function createProbeEngine(behavior, overrides = {}) {
  return createTerritoryEngine({
    behavior,
    ruleKey: "territory-engine-probe",
    population: 12,
    ...overrides,
  });
}

function landById(frame) {
  return new Map(frame.land.cells.map((cell) => [cell.id, cell]));
}

function publicLandIds(frame) {
  return new Set(frame.circulation.cells
    .filter((cell) => cell.role === "road" || cell.role === "road-reserved")
    .map((cell) => cell.id));
}

function physicalAgents(frame) {
  return frame.agents.map(({ circulationRoute: _circulationRoute, ...agent }) => agent);
}

function assertConnectedPublicNetwork(frame) {
  const cells = landById(frame);
  const publicIds = publicLandIds(frame);
  const pending = frame.circulation.entries.map((entry) => entry.landId);
  const reached = new Set();
  while (pending.length > 0) {
    const landId = pending.pop();
    if (reached.has(landId) || !publicIds.has(landId)) continue;
    reached.add(landId);
    for (const neighborId of cells.get(landId).neighborIds) {
      if (publicIds.has(neighborId) && !reached.has(neighborId)) pending.push(neighborId);
    }
  }
  assert.equal(
    reached.size,
    publicIds.size,
    `${publicIds.size - reached.size} public cells are disconnected from an entry seed`,
  );
}

test("territory starts as undivided land with entry seeds, not a preset street grid", () => {
  const engine = createTerritoryEngine();
  const frame = engine.frame();

  assert.equal(frame.tick, 0);
  assert.equal(frame.land.enabled, true);
  assert.deepEqual(
    {
      x: frame.land.geometry.x,
      y: frame.land.geometry.y,
      columns: frame.land.geometry.columns,
      rows: frame.land.geometry.rows,
      cellSize: frame.land.geometry.cellSize,
      gap: frame.land.geometry.gap,
    },
    { x: 20, y: 10, columns: 24, rows: 15, cellSize: 40, gap: 0 },
  );
  assert.equal(frame.land.cells.length, 360);
  assert.deepEqual(frame.land.cells.slice(0, 3).map((cell) => cell.id), [
    "land-0-0",
    "land-0-1",
    "land-0-2",
  ]);
  assert.ok(frame.land.cells.every((cell) => (
    cell.state === "unclaimed"
    && cell.ownerId === null
    && cell.reservedBy === null
    && Number.isFinite(cell.access)
    && Number.isFinite(cell.amenity)
    && Number.isFinite(cell.terrain)
    && Number.isFinite(cell.cost)
  )));
  assert.deepEqual(frame.land.parcels, []);
  assert.deepEqual(frame.land.events, []);
  assert.equal(frame.metrics.claimedCells, 0);
  assert.equal(frame.metrics.reservedCells, 0);
  assert.equal(frame.metrics.claimedShare, 0);
  assert.equal(frame.circulation.enabled, true);
  assert.equal(frame.circulation.kind, "emergent-cell-network");
  assert.equal(frame.circulation.cells.length, frame.land.cells.length);
  assert.deepEqual(
    [...publicLandIds(frame)].sort(),
    frame.circulation.entries.map((entry) => entry.landId).sort(),
  );
  assert.deepEqual(
    frame.circulation.entries.map((entry) => entry.side).sort(),
    ["east", "west"],
  );
  assert.equal(frame.circulation.regions.length, 2);
  assert.equal(frame.circulation.nodes.length, 2);
  assert.equal(frame.circulation.edges.length, 0);
  assert.equal(frame.metrics.roadCells, 2);
  assert.equal(frame.metrics.roadReservedCells, 0);
  assert.ok(frame.circulation.cells.every((cell) => cell.use === 0 && cell.load === 0));
  assert.doesNotThrow(() => structuredClone(frame.circulation));
  assert.deepEqual(structuredClone(frame.circulation), frame.circulation);
  assertConnectedPublicNetwork(frame);
  assert.ok(Object.isFrozen(frame.land));
  assert.ok(Object.isFrozen(frame.land.cells));
  assert.ok(Object.isFrozen(frame.land.cells[0]));
});

test("movement use grows a connected street network without taking claimed land", () => {
  const engine = createTerritoryEngine();
  const initialRoads = engine.frame().metrics.roadCells;
  assert.equal(engine.step(120).ok, true);

  const frame = engine.frame();
  assert.equal(frame.tick, 120);
  assert.ok(frame.metrics.activeMovementCells > 0);
  assert.ok(frame.circulation.cells.some((cell) => cell.use > 0));
  assert.ok(frame.metrics.roadCells + frame.metrics.roadReservedCells > initialRoads);
  assert.ok(frame.metrics.landClaims > 0);
  assert.ok(frame.land.cells.some((cell) => cell.state === "claimed"));
  for (const landId of publicLandIds(frame)) {
    assert.equal(landById(frame).get(landId).ownerId, null, `${landId} is both road and claimed`);
  }
  assertConnectedPublicNetwork(frame);
});

test("same-seed reset replays exact agents, tenure, events, and checksum", () => {
  const engine = createTerritoryEngine({ seed: 613 });
  assert.equal(engine.step(40).ok, true);
  const expected = engine.frame();

  engine.reset();
  assert.equal(engine.step(40).ok, true);
  const replay = engine.frame();

  assert.deepEqual(replay.agents, expected.agents);
  assert.deepEqual(replay.land, expected.land);
  assert.deepEqual(replay.circulation, expected.circulation);
  assert.deepEqual(replay.metrics, expected.metrics);
  assert.equal(replay.checksum, expected.checksum);
});

test("land and movement arbitration ignore agent storage order", () => {
  const canonical = createTerritoryEngine({ seed: 991 });
  const reversed = createTerritoryEngine({ seed: 991 });
  reversed.agents.reverse();

  assert.equal(canonical.step(40).ok, true);
  assert.equal(reversed.step(40).ok, true);
  assert.deepEqual(reversed.frame().agents, canonical.frame().agents);
  assert.deepEqual(reversed.frame().land, canonical.frame().land);
  assert.deepEqual(reversed.frame().circulation, canonical.frame().circulation);
  assert.equal(reversed.frame().checksum, canonical.frame().checksum);
});

test("territory evolution is invariant to step chunking", () => {
  const oneChunk = createTerritoryEngine({ seed: 104 });
  const manyChunks = createTerritoryEngine({ seed: 104 });

  assert.equal(oneChunk.step(40).ok, true);
  for (let tick = 0; tick < 40; tick += 1) assert.equal(manyChunks.step().ok, true);

  assert.deepEqual(manyChunks.frame().land, oneChunk.frame().land);
  assert.deepEqual(manyChunks.frame().circulation, oneChunk.frame().circulation);
  assert.deepEqual(manyChunks.frame().metrics, oneChunk.frame().metrics);
  assert.equal(manyChunks.frame().checksum, oneChunk.frame().checksum);
});

test("every grown parcel and public route stays connected through cardinal topology", () => {
  const engine = createTerritoryEngine();
  assert.equal(engine.step(120).ok, true);
  const frame = engine.frame();
  const cells = landById(frame);

  assertConnectedPublicNetwork(frame);
  assert.ok(frame.land.parcels.length > 0);
  for (const parcel of frame.land.parcels) {
    const parcelIds = new Set(parcel.cellIds);
    const reached = new Set();
    const pending = [parcel.cellIds[0]];
    while (pending.length > 0) {
      const landId = pending.pop();
      if (reached.has(landId)) continue;
      reached.add(landId);
      for (const neighborId of cells.get(landId).neighborIds) {
        if (parcelIds.has(neighborId) && !reached.has(neighborId)) pending.push(neighborId);
      }
    }
    assert.equal(
      reached.size,
      parcel.cellIds.length,
      `${parcel.id} has ${parcel.cellIds.length - reached.size} disconnected cells`,
    );
    assert.ok(parcel.cellIds.every((landId) => cells.get(landId).ownerId === parcel.ownerId));
  }
});

test("a malformed late land intent leaves the complete engine state atomic", () => {
  const engine = createProbeEngine(({ self, land }) => ({
    acceleration: { x: 25, y: -10 },
    reserveLand: {
      landId: land.cells[self.id % land.cells.length].id,
      bid: self.id === 11 ? Number.NaN : self.id + 1,
    },
  }));
  const before = engine.frame();
  const tenureBefore = engine.land.checksumState();
  const circulationBefore = engine.circulation.checksumState();

  const result = engine.step();
  const after = engine.frame();

  assert.equal(result.ok, false);
  assert.match(result.error.message, /finite number/);
  assert.equal(engine.tick, 0);
  assert.deepEqual(after.agents, before.agents);
  assert.deepEqual(engine.land.checksumState(), tenureBefore);
  assert.deepEqual(engine.circulation.checksumState(), circulationBefore);
  assert.deepEqual(after.land, before.land);
  assert.deepEqual(after.circulation, before.circulation);
  assert.equal(after.checksum, before.checksum);
});

test("a structurally valid unknown land ID is rejected as a domain action while time advances", () => {
  const engine = createProbeEngine(({ self }) => ({
    acceleration: { x: 0, y: 0 },
    ...(self.id === 0 ? { reserveLand: { landId: "land-does-not-exist", bid: 7 } } : {}),
  }));

  assert.equal(engine.step().ok, true);
  const frame = engine.frame();
  assert.equal(frame.tick, 1);
  assert.equal(frame.metrics.reservedCells, 0);
  assert.equal(frame.metrics.landRejectedActions, 1);
  assert.deepEqual(frame.land.events, [{
    type: "rejection",
    tick: 1,
    ownerId: 0,
    landId: "land-does-not-exist",
    action: "reserve",
    reason: "unknown-land",
  }]);
});

test("dynamic land and circulation state contribute to the engine checksum", () => {
  const targetId = "land-0-0";
  const claimant = createProbeEngine(({ self }) => ({
    acceleration: { x: 0, y: 0 },
    ...(self.id === 0 ? { reserveLand: { landId: targetId, bid: 1 } } : {}),
  }));
  const control = createProbeEngine(() => ({ acceleration: { x: 0, y: 0 } }));
  assert.equal(claimant.frame().checksum, control.frame().checksum);

  assert.equal(claimant.step().ok, true);
  assert.equal(control.step().ok, true);

  assert.deepEqual(physicalAgents(claimant.frame()), physicalAgents(control.frame()));
  assert.equal(claimant.frame().land.cells[0].state, "reserved");
  assert.equal(control.frame().land.cells[0].state, "unclaimed");
  assert.deepEqual(claimant.frame().circulation, control.frame().circulation);
  assert.notEqual(claimant.frame().checksum, control.frame().checksum);

  const traveled = createProbeEngine(() => ({ acceleration: { x: 0, y: 0 } }));
  const untraveled = createProbeEngine(() => ({ acceleration: { x: 0, y: 0 } }));
  const entryId = traveled.frame().circulation.entries[0].landId;
  const entry = landById(traveled.frame()).get(entryId);
  const circulationTransition = traveled.circulation.stage([{
    agentId: 0,
    from: { x: entry.center.x - 2, y: entry.center.y },
    to: { x: entry.center.x + 2, y: entry.center.y },
  }], 0);
  assert.equal(circulationTransition.ok, true);
  traveled.circulation.commit(circulationTransition);

  assert.deepEqual(physicalAgents(traveled.frame()), physicalAgents(untraveled.frame()));
  assert.deepEqual(traveled.frame().land, untraveled.frame().land);
  assert.ok(traveled.frame().circulation.cells.find((cell) => cell.id === entryId).use > 0);
  assert.equal(untraveled.frame().circulation.cells.find((cell) => cell.id === entryId).use, 0);
  assert.notEqual(traveled.frame().checksum, untraveled.frame().checksum);
});

test("all agents decide from the same frozen land and circulation-use snapshot", () => {
  const observedLandArrays = [];
  const observedLandCells = [];
  const observedStates = [];
  const observedCirculationArrays = [];
  const observedCirculationCells = [];
  const observedUses = [];
  const targetId = "land-0-0";
  const entryId = "land-7-0";
  const engine = createProbeEngine(({ land, circulation }) => {
    observedLandArrays.push(land.cells);
    observedLandCells.push(land.cell(targetId));
    observedStates.push(land.cell(targetId).state);
    observedCirculationArrays.push(circulation.cells);
    observedCirculationCells.push(circulation.cell(entryId));
    observedUses.push(circulation.usage(entryId));
    return {
      acceleration: { x: 0, y: 0 },
      reserveLand: { landId: targetId, bid: 1 },
    };
  });

  assert.equal(engine.step().ok, true);
  assert.equal(observedLandArrays.length, engine.population);
  assert.ok(observedLandArrays.every((cells) => cells === observedLandArrays[0]));
  assert.ok(observedLandCells.every((cell) => cell === observedLandCells[0]));
  assert.ok(observedCirculationArrays.every((cells) => cells === observedCirculationArrays[0]));
  assert.ok(observedCirculationCells.every((cell) => cell === observedCirculationCells[0]));
  assert.deepEqual(new Set(observedStates), new Set(["unclaimed"]));
  assert.deepEqual(new Set(observedUses), new Set([0]));
  assert.ok(Object.isFrozen(observedLandArrays[0]));
  assert.ok(Object.isFrozen(observedLandCells[0]));
  assert.ok(Object.isFrozen(observedCirculationArrays[0]));
  assert.ok(Object.isFrozen(observedCirculationCells[0]));
  assert.throws(() => { observedLandCells[0].ownerId = 999; }, TypeError);
  assert.throws(() => { observedCirculationCells[0].use = 999; }, TypeError);
  assert.equal(observedLandCells[0].state, "unclaimed");
  assert.equal(observedCirculationCells[0].use, 0);
  assert.equal(engine.frame().land.cells[0].state, "reserved");
  assert.ok(engine.frame().circulation.cells.some((cell) => cell.use > 0));
});
