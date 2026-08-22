import assert from "node:assert/strict";
import test from "node:test";

import {
  LandGridState,
  normalizeLandConfig,
  parseLandIntent,
} from "../src/simulation/land-grid.js";

function config(overrides = {}) {
  return {
    enabled: true,
    origin: { x: 10, y: 8 },
    columns: 3,
    rows: 3,
    cellSize: 10,
    gap: 2,
    attributes: {
      access: { sources: [{ x: 10, y: 8 }], falloff: 40 },
      amenity: { sources: [{ x: 40, y: 40, strength: 0.8 }], falloff: 30 },
      terrain: { seed: 77, variation: 0.4 },
      cost: { base: 5, accessMultiplier: 2, amenityMultiplier: 3 },
      frontage: { edges: ["top", "west"] },
    },
    policy: {
      reservationTicks: 0,
      expiryTicks: 4,
      requireContiguous: true,
      maxReservationsPerOwner: 1,
    },
    ...overrides,
  };
}

function submit(agentId, parsed) {
  assert.equal(parsed.ok, true, parsed.error);
  return { agentId, ...parsed.intent };
}

function reserve(agentId, landId, bid = 1) {
  return submit(agentId, parseLandIntent({ reserveLand: { landId, bid } }));
}

function claim(agentId, landId) {
  return submit(agentId, parseLandIntent({ claimLand: { landId } }));
}

function commit(state, intents, tick, coordination) {
  const transition = state.stage(intents, tick, coordination);
  assert.equal(transition.ok, true, transition.error);
  state.commit(transition);
  return transition;
}

function reserveAndClaim(state, ownerId, landId, tick) {
  commit(state, [reserve(ownerId, landId)], tick);
  commit(state, [claim(ownerId, landId)], tick + 1);
  return tick + 2;
}

test("land geometry is bounded, immutable, row-major, attributed, and idempotent", () => {
  const normalized = normalizeLandConfig(config({ columns: 30, rows: 30 }), 100, 80);

  assert.equal(normalized.geometry.columns, 7);
  assert.equal(normalized.geometry.rows, 6);
  assert.deepEqual(normalized.cells.slice(0, 4).map((cell) => cell.id), [
    "land-0-0",
    "land-0-1",
    "land-0-2",
    "land-0-3",
  ]);
  assert.deepEqual(normalized.cells[0].neighborIds, ["land-0-1", "land-1-0"]);
  assert.deepEqual(normalized.cells[1].neighborIds, ["land-0-2", "land-1-1", "land-0-0"]);
  assert.equal(normalized.cells[0].frontage, 20);
  assert.ok(normalized.cells.every((cell) => (
    cell.x >= 0
    && cell.y >= 0
    && cell.x + cell.width <= 100
    && cell.y + cell.height <= 80
    && cell.access >= 0
    && cell.access <= 1
    && cell.amenity >= 0
    && cell.amenity <= 1
    && cell.terrain >= 0
    && cell.terrain <= 1
    && Number.isFinite(cell.cost)
  )));
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.cells));
  assert.ok(Object.isFrozen(normalized.cells[0]));
  assert.deepEqual(normalizeLandConfig(normalized), normalized);
});

test("land intent parsing distinguishes structural errors from no action", () => {
  assert.deepEqual(parseLandIntent({ acceleration: { x: 0, y: 0 } }), {
    ok: true,
    intent: null,
    error: null,
  });
  assert.deepEqual(parseLandIntent({ reserveLand: { landId: "land-0-0", bid: "2.5" } }).intent, {
    type: "reserve",
    landId: "land-0-0",
    bid: 2.5,
  });
  assert.deepEqual(parseLandIntent({ claimLand: { landId: "land-0-0" } }).intent, {
    type: "claim",
    landId: "land-0-0",
  });
  assert.match(parseLandIntent({ reserveLand: {}, claimLand: {} }).error, /not both/);
  assert.match(parseLandIntent({ reserveLand: { landId: "land-0-0", bid: Number.NaN } }).error, /finite/);
  assert.match(parseLandIntent({ claimLand: { landId: 3 } }).error, /non-empty string/);
});

test("behavior views are frozen snapshots and staging is non-mutating", () => {
  const state = new LandGridState(config(), { seed: 12, worldWidth: 100, worldHeight: 80 });
  const before = state.viewFor(4, 0);
  const transition = state.stage([reserve(4, "land-0-0", 3)], 0);

  assert.equal(transition.ok, true);
  assert.equal(state.frame(0).cells[0].state, "unclaimed");
  assert.equal(before.cell("land-0-0").state, "unclaimed");
  assert.ok(Object.isFrozen(before));
  assert.ok(Object.isFrozen(before.cells));
  assert.ok(Object.isFrozen(before.cells[0]));
  assert.ok(Object.isFrozen(before.neighbors("land-0-0")));
  assert.throws(() => { before.cells[0].ownerId = 99; }, TypeError);

  state.commit(transition);
  const after = state.viewFor(4, 1);
  assert.equal(after.cell("land-0-0").state, "reserved");
  assert.deepEqual(after.mine, []);
  assert.deepEqual(after.reservation, {
    landId: "land-0-0",
    reservedAt: 1,
    claimableAt: 1,
    expiresAt: 5,
    claimable: true,
  });
  assert.equal(before.cell("land-0-0").state, "unclaimed");
});

test("higher bids win and seeded ties ignore submission order", () => {
  const highBid = new LandGridState(config(), { seed: 31 });
  commit(highBid, [reserve(1, "land-0-0", 2), reserve(8, "land-0-0", 9)], 0);
  assert.equal(highBid.frame(1).cells[0].reservedBy, 8);
  assert.equal(highBid.metrics().landConflicts, 1);

  const first = new LandGridState(config(), { seed: 91 });
  const reordered = new LandGridState(config(), { seed: 91 });
  commit(first, [reserve(2, "land-1-1", 5), reserve(7, "land-1-1", 5)], 0);
  commit(reordered, [reserve(7, "land-1-1", 5), reserve(2, "land-1-1", 5)], 0);

  assert.deepEqual(reordered.frame(1), first.frame(1));
  assert.deepEqual(reordered.checksumState(), first.checksumState());
  assert.equal(first.frame(1).events.filter((event) => event.type === "conflict").length, 1);
});

test("public movement and private tenure arbitrate the same cell atomically", () => {
  const publicWinner = new LandGridState(config(), { seed: 41 });
  const publicTransition = commit(
    publicWinner,
    [reserve(7, "land-1-1", 3)],
    0,
    { publicCandidates: [{ landId: "land-1-1", bid: 8, use: 8 }] },
  );

  assert.deepEqual(publicTransition.acceptedPublicLandIds, ["land-1-1"]);
  assert.equal(publicWinner.frame(1).cells[4].state, "unclaimed");
  assert.deepEqual(
    publicTransition.events.filter((event) => event.type === "road-land-conflict"),
    [{
      type: "road-land-conflict",
      tick: 1,
      landId: "land-1-1",
      publicBid: 8,
      privateBid: 3,
      privateOwner: 7,
      winner: "public",
    }],
  );
  assert.ok(publicTransition.events.some((event) => (
    event.type === "rejection"
    && event.ownerId === 7
    && event.reason === "lost-public-conflict"
  )));

  const privateWinner = new LandGridState(config(), { seed: 41 });
  const privateTransition = commit(
    privateWinner,
    [reserve(7, "land-1-1", 8)],
    0,
    { publicCandidates: [{ landId: "land-1-1", bid: 3, use: 3 }] },
  );

  assert.deepEqual(privateTransition.acceptedPublicLandIds, []);
  assert.equal(privateWinner.frame(1).cells[4].reservedBy, 7);
  assert.ok(privateTransition.events.some((event) => (
    event.type === "road-land-conflict" && event.winner === "private"
  )));
  assert.equal(privateWinner.metrics().roadLandConflicts, 1);
});

test("a strong public route can preempt a reservation, but never a claim", () => {
  const state = new LandGridState(config(), { seed: 59 });
  commit(state, [reserve(4, "land-0-1", 2)], 0);

  const preemption = commit(
    state,
    [claim(4, "land-0-1")],
    1,
    { publicCandidates: [{ landId: "land-0-1", bid: 9, use: 9 }] },
  );
  assert.deepEqual(preemption.acceptedPublicLandIds, ["land-0-1"]);
  assert.equal(state.frame(2).cells[1].state, "unclaimed");
  assert.ok(preemption.events.some((event) => (
    event.type === "road-preemption" && event.ownerId === 4
  )));
  assert.ok(preemption.events.some((event) => (
    event.type === "rejection" && event.action === "claim" && event.reason === "public-way"
  )));
  assert.equal(state.metrics().roadPreemptions, 1);

  const claimed = new LandGridState(config(), { seed: 59 });
  reserveAndClaim(claimed, 4, "land-0-1", 0);
  const attemptedRoad = commit(
    claimed,
    [],
    2,
    { publicCandidates: [{ landId: "land-0-1", bid: 999, use: 999 }] },
  );
  assert.deepEqual(attemptedRoad.acceptedPublicLandIds, []);
  assert.equal(claimed.frame(3).cells[1].ownerId, 4);
  assert.equal(claimed.metrics().roadPreemptions, 0);
});

test("established public cells reject private reservations", () => {
  const state = new LandGridState(config());
  const transition = commit(
    state,
    [reserve(2, "land-2-1", 999)],
    0,
    { publicCells: ["land-2-1"] },
  );

  assert.equal(state.frame(1).cells[7].state, "unclaimed");
  assert.deepEqual(transition.events, [{
    type: "rejection",
    tick: 1,
    ownerId: 2,
    landId: "land-2-1",
    action: "reserve",
    reason: "public-way",
  }]);
});

test("reservations mature and expire on explicit tick boundaries", () => {
  const state = new LandGridState(config({
    policy: { reservationTicks: 2, expiryTicks: 4, requireContiguous: true },
  }));
  commit(state, [reserve(3, "land-0-0")], 0);
  assert.equal(state.viewFor(3, 1).reservation.claimable, false);

  const premature = commit(state, [claim(3, "land-0-0")], 1);
  assert.equal(premature.events[0].reason, "not-mature");
  assert.equal(state.frame(2).cells[0].state, "reserved");
  commit(state, [], 2);
  assert.equal(state.viewFor(3, 3).reservation.claimable, true);
  commit(state, [claim(3, "land-0-0")], 3);
  assert.equal(state.frame(4).cells[0].ownerId, 3);

  const expiring = new LandGridState(config({
    policy: { reservationTicks: 0, expiryTicks: 3, requireContiguous: true },
  }));
  commit(expiring, [reserve(6, "land-1-1")], 0);
  commit(expiring, [], 1);
  commit(expiring, [], 2);
  assert.equal(expiring.frame(3).cells[4].state, "reserved");
  const expiry = commit(expiring, [], 3);
  assert.equal(expiring.frame(4).cells[4].state, "unclaimed");
  assert.equal(expiry.events.at(-1).type, "expiry");
  assert.equal(expiring.metrics().landExpiries, 1);
});

test("claimed holdings grow only through cardinally contiguous cells", () => {
  const state = new LandGridState(config());
  let tick = reserveAndClaim(state, 0, "land-0-0", 0);

  const diagonal = commit(state, [reserve(0, "land-1-1")], tick);
  tick += 1;
  assert.equal(diagonal.events[0].reason, "not-contiguous");
  assert.equal(state.frame(tick).cells[4].state, "unclaimed");

  commit(state, [reserve(0, "land-0-1")], tick);
  tick += 1;
  commit(state, [claim(0, "land-0-1")], tick);
  tick += 1;
  assert.deepEqual(state.viewFor(0, tick).mine, ["land-0-0", "land-0-1"]);

  const disconnected = commit(state, [reserve(0, "land-2-2")], tick);
  assert.equal(disconnected.events[0].reason, "not-contiguous");
  assert.equal(state.metrics().claimedCells, 2);
});

test("parcel area, perimeter, compactness, and concentration are derived exactly", () => {
  const state = new LandGridState(config({ columns: 2, rows: 2, gap: 0 }));
  let tick = reserveAndClaim(state, 0, "land-0-0", 0);
  tick = reserveAndClaim(state, 0, "land-0-1", tick);
  reserveAndClaim(state, 1, "land-1-1", tick);

  const frame = state.frame(tick + 2);
  const metrics = state.metrics();
  assert.deepEqual(frame.parcels.map(({ ownerId, area, perimeter }) => ({ ownerId, area, perimeter })), [
    { ownerId: 0, area: 200, perimeter: 60 },
    { ownerId: 1, area: 100, perimeter: 40 },
  ]);
  assert.equal(metrics.claimedCells, 3);
  assert.equal(metrics.claimedShare, 0.75);
  assert.equal(metrics.reservedCells, 0);
  assert.equal(metrics.landOwners, 2);
  assert.equal(metrics.parcelCount, 2);
  assert.equal(metrics.meanParcelArea, 150);
  assert.ok(Math.abs(metrics.ownershipConcentration - 5 / 9) < 1e-12);
  assert.ok(Math.abs(frame.parcels[0].compactness - (4 * Math.PI * 200) / 3_600) < 1e-12);
});

test("malformed staging and stale transitions cannot partially commit", () => {
  const state = new LandGridState(config());
  const before = state.checksumState();
  const invalid = state.stage([{ agentId: 1, type: "reserve", landId: "land-0-0", bid: Number.NaN }], 0);
  assert.equal(invalid.ok, false);
  assert.deepEqual(state.checksumState(), before);

  const first = state.stage([reserve(1, "land-0-0")], 0);
  const stale = state.stage([reserve(2, "land-0-1")], 0);
  state.commit(first);
  assert.throws(() => state.commit(stale), /stale/);
  assert.equal(state.frame(1).cells[0].reservedBy, 1);
  assert.equal(state.frame(1).cells[1].state, "unclaimed");
});
