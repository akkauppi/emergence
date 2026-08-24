import assert from "node:assert/strict";
import test from "node:test";

import { LandGridState } from "../src/simulation/land-grid.js";
import {
  normalizeCirculationConfig,
  PublicCirculation,
} from "../src/simulation/public-circulation.js";

function createStores({ columns = 5, rows = 3, circulation = {}, land: landOverrides = {}, seed = 2026 } = {}) {
  const land = new LandGridState({
    enabled: true,
    origin: { x: 0, y: 0 },
    columns,
    rows,
    cellSize: 20,
    gap: 0,
    policy: { reservationTicks: 0, expiryTicks: 30, requireContiguous: true },
    ...landOverrides,
  }, { seed, worldWidth: columns * 20, worldHeight: rows * 20 });
  const publicCirculation = new PublicCirculation({
    enabled: true,
    sourceLayer: "land",
    entrySides: ["west"],
    usePersistence: 1,
    reserveThreshold: 1,
    releaseThreshold: 0.5,
    maturityTicks: 2,
    releaseTicks: 3,
    maxNewPerTick: 2,
    roadPreference: 0.45,
    trailPreference: 0.5,
    arrivalRadius: 8,
    ...circulation,
  }, {
    land,
    seed,
    worldWidth: columns * 20,
    worldHeight: rows * 20,
  });
  return { land, circulation: publicCirculation };
}

function centre(land, landId) {
  return land.config.cells.find((cell) => cell.id === landId).center;
}

function segment(land, agentId, fromId, toId) {
  return { agentId, from: centre(land, fromId), to: centre(land, toId) };
}

function acceptAll(circulation, transition) {
  circulation.commit(transition, {
    acceptedLandIds: transition.publicCandidates.map((candidate) => candidate.landId),
  });
}

test("circulation policy normalizes into a bounded immutable replay value", () => {
  const normalized = normalizeCirculationConfig({
    entrySides: ["left", "south", "bogus", "left"],
    usePersistence: 4,
    reserveThreshold: -2,
    formationTicks: 0,
    releaseThreshold: 99,
    maturityTicks: -5,
    releaseTicks: 0,
    maxNewPerTick: 999,
    roadPreference: 2,
    trailPreference: -1,
    flowPathThreshold: 4,
    flowFormationTicks: 0,
    flowReleaseThreshold: 99,
    flowReleaseTicks: 0,
    pressureDetourRatio: -1,
    pressureDetourDistance: -1,
    easementUsePersistence: 4,
    easementAcquisitionThreshold: -1,
    easementAcquisitionTicks: 0,
  });

  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.entrySides));
  assert.deepEqual(normalized.entrySides, ["south", "west"]);
  assert.equal(normalized.usePersistence, 1);
  assert.equal(normalized.reserveThreshold, 0.001);
  assert.equal(normalized.formationTicks, 1);
  assert.equal(normalized.releaseThreshold, 0.001);
  assert.equal(normalized.maturityTicks, 0);
  assert.equal(normalized.releaseTicks, 1);
  assert.equal(normalized.maxNewPerTick, 256);
  assert.equal(normalized.roadPreference, 0.95);
  assert.equal(normalized.trailPreference, 0);
  assert.equal(normalized.flowPathThreshold, 4);
  assert.equal(normalized.flowFormationTicks, 1);
  assert.equal(normalized.flowReleaseThreshold, 4);
  assert.equal(normalized.flowReleaseTicks, 1);
  assert.equal(normalized.pressureDetourRatio, 1);
  assert.equal(normalized.pressureDetourDistance, 0);
  assert.equal(normalized.easementUsePersistence, 1);
  assert.equal(normalized.easementAcquisitionThreshold, 0.1);
  assert.equal(normalized.easementAcquisitionTicks, 1);
  assert.equal(normalizeCirculationConfig({ enabled: false }), null);
});

test("movement can reserve only a threshold-crossing cell connected to the prior public snapshot", () => {
  const { land, circulation } = createStores({ circulation: { maxNewPerTick: 8 } });
  assert.deepEqual(circulation.publicLandIds(), ["land-1-0"]);

  const first = circulation.stage([
    segment(land, 0, "land-1-0", "land-1-4"),
  ], 0);
  assert.equal(first.ok, true);
  assert.deepEqual(first.publicCells, ["land-1-0"]);
  assert.deepEqual(first.publicCandidates.map((candidate) => candidate.landId), ["land-1-1"]);
  assert.deepEqual(first.publicCandidates[0], {
    landId: "land-1-1",
    bid: 1,
    use: 1,
    load: 1,
  });

  acceptAll(circulation, first);
  assert.deepEqual(circulation.publicLandIds(), ["land-1-0", "land-1-1"]);
  assert.equal(circulation.cell("land-1-1").role, "road-reserved");

  const second = circulation.stage([
    segment(land, 0, "land-1-0", "land-1-4"),
  ], 1);
  assert.deepEqual(second.publicCandidates.map((candidate) => candidate.landId), ["land-1-2"]);
});

test("a cell must remain well used before it can enter the public network", () => {
  const { land, circulation } = createStores({
    circulation: { formationTicks: 2, maxNewPerTick: 8 },
  });
  let transition = circulation.stage([
    segment(land, 0, "land-1-0", "land-1-4"),
  ], 0);
  assert.deepEqual(transition.publicCandidates, []);
  circulation.commit(transition);

  transition = circulation.stage([
    segment(land, 0, "land-1-0", "land-1-4"),
  ], 1);
  assert.deepEqual(transition.publicCandidates.map((candidate) => candidate.landId), ["land-1-1"]);
});

test("only candidates accepted by atomic land arbitration become public", () => {
  const { land, circulation } = createStores();
  const offered = circulation.stage([
    segment(land, 0, "land-1-0", "land-1-2"),
  ], 0);
  assert.deepEqual(offered.publicCandidates.map((candidate) => candidate.landId), ["land-1-1"]);

  circulation.commit(offered, { acceptedLandIds: [] });
  assert.equal(circulation.cell("land-1-1").role, "open");
  assert.equal(circulation.usage("land-1-1"), 1);

  const accepted = circulation.stage([
    segment(land, 0, "land-1-0", "land-1-2"),
  ], 1);
  circulation.commit(accepted, { acceptedLandIds: ["land-1-1", "unknown"] });
  assert.equal(circulation.cell("land-1-1").role, "road-reserved");
  assert.equal(circulation.metrics().roadReservedCells, 1);
  assert.equal(circulation.lastEvents.at(-1).type, "road-reservation");
});

test("an active route may preempt a private reservation but never claimed land", () => {
  const reservedStores = createStores();
  let privateTransition = reservedStores.land.stage([
    { agentId: 7, type: "reserve", landId: "land-1-1", bid: 0.2 },
  ], 0);
  reservedStores.land.commit(privateTransition);
  assert.equal(reservedStores.land.frame(1).cells[6].state, "reserved");

  const publicOffer = reservedStores.circulation.stage([
    segment(reservedStores.land, 0, "land-1-0", "land-1-2"),
  ], 1);
  assert.deepEqual(publicOffer.publicCandidates.map((candidate) => candidate.landId), ["land-1-1"]);

  const claimedStores = createStores();
  privateTransition = claimedStores.land.stage([
    { agentId: 7, type: "reserve", landId: "land-1-1", bid: 0.2 },
  ], 0);
  claimedStores.land.commit(privateTransition);
  privateTransition = claimedStores.land.stage([
    { agentId: 7, type: "claim", landId: "land-1-1" },
  ], 1);
  claimedStores.land.commit(privateTransition);
  assert.equal(claimedStores.land.frame(2).cells[6].state, "claimed");

  const protectedOffer = claimedStores.circulation.stage([
    segment(claimedStores.land, 0, "land-1-0", "land-1-2"),
  ], 2);
  assert.equal(protectedOffer.publicCandidates.some(({ landId }) => landId === "land-1-1"), false);
  const route = claimedStores.circulation.route(
    centre(claimedStores.land, "land-1-0"),
    0,
    0,
    "land-1-2",
  );
  assert.equal(route.cellIds.includes("land-1-1"), false);
});

test("continuous flow edges retain the angle of actual movement", () => {
  const { circulation } = createStores({
    circulation: { flowTraceThreshold: 0.1, flowPathThreshold: 1 },
  });
  const transition = circulation.stage([{
    agentId: 3,
    from: { x: 5, y: 5 },
    to: { x: 35, y: 25 },
  }], 0);
  circulation.commit(transition);

  const flowEdge = circulation.frame().edges.find((edge) => edge.flow);
  assert.ok(flowEdge);
  assert.ok(Math.abs(flowEdge.x2 - flowEdge.x1) > 1);
  assert.ok(Math.abs(flowEdge.y2 - flowEdge.y1) > 1);
});

test("continuous traces require repeated use to become streets and fade after quiet use", () => {
  const { circulation } = createStores({
    circulation: {
      flowPersistence: 0,
      flowTraceThreshold: 0.1,
      flowPathThreshold: 1,
      flowFormationTicks: 3,
      flowReleaseThreshold: 0.5,
      flowReleaseTicks: 2,
    },
  });
  const movement = [{
    agentId: 3,
    from: { x: 5, y: 5 },
    to: { x: 35, y: 25 },
  }];

  for (let tick = 0; tick < 2; tick += 1) {
    circulation.commit(circulation.stage(movement, tick));
    assert.equal(circulation.frame().edges.find((edge) => edge.flow)?.status, "trace");
  }
  circulation.commit(circulation.stage(movement, 2));
  assert.equal(circulation.frame().edges.find((edge) => edge.flow)?.status, "road");
  assert.ok(circulation.lastEvents.some((event) => event.type === "flow-promotion"));

  circulation.commit(circulation.stage([], 3));
  assert.equal(circulation.frame().edges.find((edge) => edge.flow)?.status, "road");
  circulation.commit(circulation.stage([], 4));
  assert.equal(circulation.frame().edges.some((edge) => edge.flow), false);
  assert.ok(circulation.lastEvents.some((event) => event.type === "flow-degeneration"));
  assert.equal(circulation.metrics().flowPromotions, 1);
  assert.equal(circulation.metrics().flowDegenerations, 1);
});

test("only a costly accumulated detour creates pressure and an easement", () => {
  const { land, circulation } = createStores({
    columns: 3,
    rows: 3,
    circulation: {
      pressurePersistence: 1,
      pressureDetourRatio: 1.15,
      pressureDetourDistance: 10,
      pressureContribution: 1,
      easementPressureThreshold: 2,
      easementWidth: 8,
    },
  });
  let tenure = land.stage([
    { agentId: 7, type: "reserve", landId: "land-1-1", bid: 1 },
  ], 0);
  land.commit(tenure);
  tenure = land.stage([
    { agentId: 7, type: "claim", landId: "land-1-1" },
  ], 1);
  land.commit(tenure);

  let transition = circulation.stage([{
    agentId: 2,
    from: { x: 10, y: 30 },
    to: { x: 15, y: 30 },
    pressureTo: { x: 50, y: 30 },
  }], 2);
  circulation.commit(transition);
  assert.equal(circulation.cell("land-1-1").pressure, 0, "direct progress must not build pressure");

  transition = circulation.stage([{
    agentId: 2,
    from: { x: 15, y: 30 },
    to: { x: 15, y: 10 },
    pressureTo: { x: 50, y: 30 },
  }], 3);
  circulation.commit(transition);

  const easement = circulation.easement("land-1-1");
  assert.ok(easement);
  assert.equal(easement.landId, "land-1-1");
  assert.ok(Math.abs(easement.y2 - easement.y1) < 0.001);
  assert.equal(land.frame(4).cells[4].ownerId, 7);
  assert.equal(circulation.frame().metrics.easementCount, 1);
  assert.ok(circulation.lastEvents.some((event) => event.type === "pressure-easement"));
});

test("sustained easement traffic acquires a safe parcel edge as public right-of-way", () => {
  const { land, circulation } = createStores({
    columns: 3,
    rows: 3,
    circulation: {
      pressurePersistence: 1,
      pressureDetourRatio: 1.15,
      pressureDetourDistance: 10,
      pressureContribution: 1,
      easementPressureThreshold: 2,
      easementUsePersistence: 1,
      easementAcquisitionThreshold: 1,
      easementAcquisitionTicks: 2,
    },
  });
  let tenure = land.stage([
    { agentId: 7, type: "reserve", landId: "land-1-1", bid: 1 },
  ], 0);
  land.commit(tenure);
  tenure = land.stage([
    { agentId: 7, type: "claim", landId: "land-1-1" },
  ], 1);
  land.commit(tenure);

  let transition = circulation.stage([{
    agentId: 2,
    from: { x: 10, y: 30 },
    to: { x: 10, y: 10 },
    pressureTo: { x: 50, y: 30 },
  }], 2);
  circulation.commit(transition);
  assert.ok(circulation.easement("land-1-1"));

  for (let tick = 3; tick <= 4; tick += 1) {
    transition = circulation.stage([{
      agentId: 2,
      from: { x: 10, y: 30 },
      to: { x: 50, y: 30 },
    }], tick);
    tenure = land.stage([], tick, {
      publicCells: circulation.publicLandIds(),
      publicCandidates: transition.publicCandidates,
      publicAcquisitions: transition.publicAcquisitions,
    });
    circulation.commit(transition, {
      acceptedLandIds: tenure.acceptedPublicLandIds,
      acceptedAcquisitionLandIds: tenure.acceptedPublicAcquisitionLandIds,
    });
    land.commit(tenure);
  }

  assert.equal(land.frame(5).cells[4].ownerId, null);
  assert.equal(circulation.cell("land-1-1").role, "right-of-way");
  assert.equal(circulation.cell("land-1-1").acquired, true);
  assert.equal(circulation.isPublic("land-1-1"), true);
  assert.equal(circulation.frame().regions.some((region) => region.landId === "land-1-1"), false);
  assert.equal(circulation.easement("land-1-1").acquired, true);
  assert.equal(circulation.metrics().acquiredRightOfWays, 1);
  assert.equal(circulation.metrics().easementAcquisitions, 1);
  assert.ok(circulation.lastEvents.some((event) => event.type === "easement-acquisition"));
  assert.ok(land.lastEvents.some((event) => event.type === "public-acquisition"));
});

test("public reservations mature under use and release after sustained disuse", () => {
  const immediate = createStores({ circulation: { maturityTicks: 0 } });
  let transition = immediate.circulation.stage([
    segment(immediate.land, 0, "land-1-0", "land-1-2"),
  ], 0);
  acceptAll(immediate.circulation, transition);
  assert.equal(immediate.circulation.cell("land-1-1").role, "road");

  const persistent = createStores({ circulation: { usePersistence: 1, maturityTicks: 2 } });
  transition = persistent.circulation.stage([
    segment(persistent.land, 0, "land-1-0", "land-1-2"),
  ], 0);
  acceptAll(persistent.circulation, transition);
  assert.equal(persistent.circulation.cell("land-1-1").role, "road-reserved");

  transition = persistent.circulation.stage([], 1);
  persistent.circulation.commit(transition);
  assert.equal(persistent.circulation.cell("land-1-1").role, "road-reserved");
  transition = persistent.circulation.stage([], 2);
  persistent.circulation.commit(transition);
  assert.equal(persistent.circulation.cell("land-1-1").role, "road");
  assert.equal(persistent.circulation.lastEvents.at(-1).type, "road-promotion");

  const fading = createStores({
    circulation: { usePersistence: 0, maturityTicks: 20, releaseTicks: 2 },
  });
  transition = fading.circulation.stage([
    segment(fading.land, 0, "land-1-0", "land-1-2"),
  ], 0);
  acceptAll(fading.circulation, transition);
  transition = fading.circulation.stage([], 1);
  fading.circulation.commit(transition);
  assert.equal(fading.circulation.cell("land-1-1").role, "road-reserved");
  transition = fading.circulation.stage([], 2);
  fading.circulation.commit(transition);
  assert.equal(fading.circulation.cell("land-1-1").role, "open");
  assert.equal(fading.circulation.lastEvents.at(-1).type, "road-release");
});

test("an established street degenerates after sustained low use while its entry remains", () => {
  const { land, circulation } = createStores({
    circulation: {
      usePersistence: 0,
      maturityTicks: 0,
      releaseThreshold: 0.5,
      releaseTicks: 2,
    },
  });
  let transition = circulation.stage([
    segment(land, 0, "land-1-0", "land-1-2"),
  ], 0);
  acceptAll(circulation, transition);
  assert.equal(circulation.cell("land-1-1").role, "road");

  circulation.commit(circulation.stage([], 1));
  assert.equal(circulation.cell("land-1-1").role, "road");
  circulation.commit(circulation.stage([], 2));
  assert.equal(circulation.cell("land-1-1").role, "open");
  assert.equal(circulation.cell("land-1-0").role, "road");
  assert.ok(circulation.lastEvents.some((event) => event.type === "road-degeneration"));
  assert.equal(circulation.metrics().streetDegenerations, 1);
});

test("release hysteresis never strands a downstream public branch", () => {
  const { land, circulation } = createStores({
    circulation: { usePersistence: 0, maturityTicks: 20, releaseTicks: 1, maxNewPerTick: 4 },
  });
  let transition = circulation.stage([
    segment(land, 0, "land-1-0", "land-1-3"),
  ], 0);
  acceptAll(circulation, transition);
  transition = circulation.stage([
    segment(land, 0, "land-1-0", "land-1-3"),
  ], 1);
  acceptAll(circulation, transition);
  assert.deepEqual(circulation.publicLandIds(), ["land-1-0", "land-1-1", "land-1-2"]);

  transition = circulation.stage([], 2);
  circulation.commit(transition);
  // The leaf may disappear immediately, but its parent remains for this tick.
  assert.deepEqual(circulation.publicLandIds(), ["land-1-0", "land-1-1"]);
  transition = circulation.stage([], 3);
  circulation.commit(transition);
  assert.deepEqual(circulation.publicLandIds(), ["land-1-0"]);
});

test("claimed land defensively displaces an overlapping pending road before promotion", () => {
  const { land, circulation } = createStores({ circulation: { maturityTicks: 1 } });
  let transition = circulation.stage([
    segment(land, 0, "land-1-0", "land-1-2"),
  ], 0);
  acceptAll(circulation, transition);
  assert.equal(circulation.cell("land-1-1").role, "road-reserved");

  let tenure = land.stage([{ agentId: 9, type: "reserve", landId: "land-1-1", bid: 1 }], 1);
  land.commit(tenure);
  tenure = land.stage([{ agentId: 9, type: "claim", landId: "land-1-1" }], 2);
  land.commit(tenure);
  assert.equal(land.frame(3).cells[6].state, "claimed");

  transition = circulation.stage([], 3);
  circulation.commit(transition);
  assert.equal(circulation.isPublic("land-1-1"), false);
  assert.equal(circulation.cell("land-1-1").role, "open");
  assert.equal(circulation.cell("land-1-1").claimed, true);
  assert.equal(circulation.lastEvents.some((event) => event.type === "road-private-displacement"), true);
});

test("preferred-route cost follows reinforced use while retaining a positive edge cost", () => {
  const plain = createStores({
    columns: 5,
    rows: 3,
    circulation: { reserveThreshold: 1, trailPreference: 0.9, roadPreference: 0 },
  });
  const reinforced = createStores({
    columns: 5,
    rows: 3,
    circulation: { reserveThreshold: 1, trailPreference: 0.9, roadPreference: 0 },
  });
  const start = centre(plain.land, "land-1-0");
  const target = "land-1-4";
  const direct = plain.circulation.route(start, 0, 3, target);

  const trace = reinforced.circulation.stage([
    segment(reinforced.land, 0, "land-0-0", "land-0-4"),
  ], 0);
  reinforced.circulation.commit(trace);
  const preferred = reinforced.circulation.route(start, 0, 3, target);

  assert.equal(direct.reachable, true);
  assert.equal(preferred.reachable, true);
  assert.equal(direct.cellIds.some((id) => id.startsWith("land-0-")), false);
  assert.equal(preferred.cellIds.some((id) => id.startsWith("land-0-")), true);
  assert.ok(preferred.cost > 0);
  assert.ok(preferred.cost < direct.cost);
});

test("candidate ranking, frame, and checksum replay independently of segment order", () => {
  const first = createStores({ circulation: { maxNewPerTick: 2 }, seed: 811 });
  const second = createStores({ circulation: { maxNewPerTick: 2 }, seed: 811 });
  const segments = [
    segment(first.land, 4, "land-1-0", "land-0-0"),
    segment(first.land, 2, "land-1-0", "land-1-1"),
    segment(first.land, 9, "land-1-0", "land-2-0"),
  ];
  const replaySegments = [
    segment(second.land, 9, "land-1-0", "land-2-0"),
    segment(second.land, 2, "land-1-0", "land-1-1"),
    segment(second.land, 4, "land-1-0", "land-0-0"),
  ];
  const firstTransition = first.circulation.stage(segments, 0);
  const secondTransition = second.circulation.stage(replaySegments, 0);
  assert.deepEqual(secondTransition.publicCandidates, firstTransition.publicCandidates);
  acceptAll(first.circulation, firstTransition);
  acceptAll(second.circulation, secondTransition);

  assert.deepEqual(second.circulation.checksumState(), first.circulation.checksumState());
  assert.deepEqual(second.circulation.frame(), first.circulation.frame());
  const frame = first.circulation.frame();
  assert.equal(frame.kind, "emergent-flow-network");
  assert.ok(frame.regions.length >= 3);
  assert.ok(frame.nodes.length >= 3);
  assert.ok(frame.edges.length >= 2);
  assert.ok(frame.cells.some((cell) => cell.load > 0));
  assert.equal(frame.metrics.activeRouteCells, frame.metrics.activeMovementCells);
  assert.deepEqual(structuredClone(frame), frame);
});

test("direct route and staged transition APIs fail safely for unknown inputs", () => {
  const { circulation } = createStores();
  const route = circulation.route({ x: 10, y: 30 }, 6, 0, "missing");
  assert.deepEqual(route.cellIds, []);
  assert.equal(route.reachable, false);
  assert.equal(route.distance, null);
  assert.equal(circulation.usage("missing"), null);
  assert.equal(circulation.cell("missing"), null);
  assert.equal(circulation.stage("bad", 0).ok, false);
  assert.equal(circulation.stage([{ agentId: 0, from: {}, to: {} }], 0).ok, false);
});
