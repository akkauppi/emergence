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

test("territory scenario exposes a complete immutable initial land frame", () => {
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
    { x: 140, y: 84, columns: 19, rows: 12, cellSize: 36, gap: 2 },
  );
  assert.equal(frame.land.cells.length, 228);
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
  assert.ok(Object.isFrozen(frame.land));
  assert.ok(Object.isFrozen(frame.land.cells));
  assert.ok(Object.isFrozen(frame.land.cells[0]));
});

test("bundled territory run produces deterministic claims and conflicts by tick 40", () => {
  const engine = createTerritoryEngine();
  assert.equal(engine.step(40).ok, true);

  const frame = engine.frame();
  assert.equal(frame.tick, 40);
  assert.equal(frame.metrics.claimedCells, 74);
  assert.equal(frame.metrics.reservedCells, 52);
  assert.equal(frame.metrics.landClaims, 74);
  assert.equal(frame.metrics.landConflicts, 46);
  assert.equal(frame.metrics.landOwners, 72);
  assert.equal(frame.land.parcels.length, 72);
  assert.ok(frame.land.cells.some((cell) => cell.state === "claimed"));
  assert.ok(frame.land.cells.some((cell) => cell.state === "reserved"));
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
  assert.deepEqual(replay.metrics, expected.metrics);
  assert.equal(replay.checksum, expected.checksum);
});

test("land arbitration ignores agent storage order", () => {
  const canonical = createTerritoryEngine({ seed: 991 });
  const reversed = createTerritoryEngine({ seed: 991 });
  reversed.agents.reverse();

  assert.equal(canonical.step(40).ok, true);
  assert.equal(reversed.step(40).ok, true);
  assert.deepEqual(reversed.frame().agents, canonical.frame().agents);
  assert.deepEqual(reversed.frame().land, canonical.frame().land);
  assert.equal(reversed.frame().checksum, canonical.frame().checksum);
});

test("territory evolution is invariant to step chunking", () => {
  const oneChunk = createTerritoryEngine({ seed: 104 });
  const manyChunks = createTerritoryEngine({ seed: 104 });

  assert.equal(oneChunk.step(40).ok, true);
  for (let tick = 0; tick < 40; tick += 1) assert.equal(manyChunks.step().ok, true);

  assert.deepEqual(manyChunks.frame().land, oneChunk.frame().land);
  assert.deepEqual(manyChunks.frame().metrics, oneChunk.frame().metrics);
  assert.equal(manyChunks.frame().checksum, oneChunk.frame().checksum);
});

test("every grown parcel is connected through cardinal topology", () => {
  const engine = createTerritoryEngine();
  assert.equal(engine.step(60).ok, true);
  const frame = engine.frame();
  const cells = landById(frame);

  assert.ok(frame.land.parcels.some((parcel) => parcel.cellIds.length > 1));
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

  const result = engine.step();
  const after = engine.frame();

  assert.equal(result.ok, false);
  assert.match(result.error.message, /finite number/);
  assert.equal(engine.tick, 0);
  assert.deepEqual(after.agents, before.agents);
  assert.deepEqual(engine.land.checksumState(), tenureBefore);
  assert.deepEqual(after.land, before.land);
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

test("dynamic land state contributes independently to the engine checksum", () => {
  const targetId = "land-0-0";
  const claimant = createProbeEngine(({ self }) => ({
    acceleration: { x: 0, y: 0 },
    ...(self.id === 0 ? { reserveLand: { landId: targetId, bid: 1 } } : {}),
  }));
  const control = createProbeEngine(() => ({ acceleration: { x: 0, y: 0 } }));
  assert.equal(claimant.frame().checksum, control.frame().checksum);

  assert.equal(claimant.step().ok, true);
  assert.equal(control.step().ok, true);

  assert.deepEqual(claimant.frame().agents, control.frame().agents);
  assert.equal(claimant.frame().land.cells[0].state, "reserved");
  assert.equal(control.frame().land.cells[0].state, "unclaimed");
  assert.notEqual(claimant.frame().checksum, control.frame().checksum);
});

test("all agents decide from the same frozen land snapshot", () => {
  const observedArrays = [];
  const observedCells = [];
  const observedStates = [];
  const targetId = "land-0-0";
  const engine = createProbeEngine(({ land }) => {
    observedArrays.push(land.cells);
    observedCells.push(land.cell(targetId));
    observedStates.push(land.cell(targetId).state);
    return {
      acceleration: { x: 0, y: 0 },
      reserveLand: { landId: targetId, bid: 1 },
    };
  });

  assert.equal(engine.step().ok, true);
  assert.equal(observedArrays.length, engine.population);
  assert.ok(observedArrays.every((cells) => cells === observedArrays[0]));
  assert.ok(observedCells.every((cell) => cell === observedCells[0]));
  assert.deepEqual(new Set(observedStates), new Set(["unclaimed"]));
  assert.ok(Object.isFrozen(observedArrays[0]));
  assert.ok(Object.isFrozen(observedCells[0]));
  assert.throws(() => { observedCells[0].ownerId = 999; }, TypeError);
  assert.equal(observedCells[0].state, "unclaimed");
  assert.equal(engine.frame().land.cells[0].state, "reserved");
});
