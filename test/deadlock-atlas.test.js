import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeDeadlockCheckpoint,
  classifyDeadlockSignals,
  renderDeadlockAtlasSvg,
  runDeadlockAtlas,
} from "../src/simulation/deadlock-atlas.js";

function diagnosticMetrics(overrides = {}) {
  return {
    sampleCount: 201,
    displacement: 10,
    pathLength: 30,
    pathToDisplacementRatio: 3,
    boundingWidth: 30,
    boundingHeight: 10,
    boundingDiagonal: 32,
    meanSpeed: 2,
    maximumSpeed: 4,
    stationaryShare: 0.1,
    sharpTurns: 0,
    arrivals: 0,
    destinationSwitches: 0,
    unexplainedDestinationSwitches: 0,
    destinationIds: ["east"],
    blockedSamples: 0,
    dominantBlockedLandId: null,
    dominantBlockedSamples: 0,
    maximumStalledTicks: 0,
    maximumImmobileTicks: 0,
    maximumDetourRatio: 1,
    insidePrivateSamples: 0,
    insideEasementSamples: 0,
    firstInsidePrivateTick: null,
    privateEntryMode: null,
    privateEntryEvents: [],
    privateLandIds: [],
    minimumNearestNeighbor: 100,
    meanNearestNeighbor: 100,
    crowdedShare: 0,
    ...overrides,
  };
}

function diagnosticContext(overrides = {}) {
  return {
    final: { x: 100, y: 100, radius: 7, destinationId: "east" },
    target: { id: "east", kind: "authored", x: 900, y: 100, radius: 25 },
    targetDistance: 800,
    arrivalRadius: 25,
    insideClaimedCell: null,
    insideEasementCell: null,
    overlappingClaimedCells: [],
    nearestClaimedCell: null,
    nearestEasement: null,
    directBlockers: [],
    unresolvedDirectBlockers: [],
    localDirectBlockers: [],
    localBlockerDistance: 90,
    easementPressureThreshold: 14,
    ...overrides,
  };
}

test("deadlock classifications prioritize explicit evidence and retain secondary signals", () => {
  const inside = classifyDeadlockSignals(
    diagnosticMetrics({ unexplainedDestinationSwitches: 2 }),
    diagnosticContext({ insideClaimedCell: { id: "land-1-1" } }),
  );
  assert.equal(inside.category, "inside-private-land");
  assert.equal(inside.confidence, "high");
  assert.deepEqual(inside.signals.slice(0, 2), ["inside-private-land", "route-reset"]);

  const reset = classifyDeadlockSignals(
    diagnosticMetrics({ destinationSwitches: 2, unexplainedDestinationSwitches: 2 }),
    diagnosticContext(),
  );
  assert.equal(reset.category, "route-reset");

  const frontage = classifyDeadlockSignals(
    diagnosticMetrics({ maximumImmobileTicks: 20 }),
    diagnosticContext({
      target: { id: "activity:parcel-3", kind: "parcel-activity", radius: 10 },
      targetDistance: 32,
    }),
  );
  assert.equal(frontage.category, "activity-frontage");

  const collision = classifyDeadlockSignals(
    diagnosticMetrics({
      blockedSamples: 12,
      dominantBlockedLandId: "land-2-4",
      dominantBlockedSamples: 10,
      maximumStalledTicks: 7,
    }),
    diagnosticContext(),
  );
  assert.equal(collision.category, "parcel-face-collision");
  assert.equal(collision.confidence, "high");

  const corner = classifyDeadlockSignals(
    diagnosticMetrics({ pathLength: 90, sharpTurns: 12, boundingDiagonal: 35 }),
    diagnosticContext({ nearestClaimedCell: { id: "land-3-5", distance: 2 } }),
  );
  assert.equal(corner.category, "parcel-corner-oscillation");

  const crowded = classifyDeadlockSignals(
    diagnosticMetrics({ crowdedShare: 0.8, minimumNearestNeighbor: 14 }),
    diagnosticContext(),
  );
  assert.equal(crowded.category, "crowding");
});

function sample(id, x, y, { arrivalCount = 0, target = null } = {}) {
  return {
    id,
    x,
    y,
    vx: 0,
    vy: 0,
    radius: 6,
    destinationId: target?.id ?? "east",
    arrivalCount,
    target: target ?? { id: "east", kind: "authored", x: 900, y: 100, radius: 25 },
    journey: null,
  };
}

test("the atlas uses endpoint mobility while preserving the traveled trajectory", () => {
  const observations = [
    { tick: 0, agents: [sample(1, 0, 100), sample(2, 0, 200)] },
    { tick: 1, agents: [sample(1, 60, 100), sample(2, 30, 200)] },
    { tick: 2, agents: [sample(1, 10, 100), sample(2, 60, 200)] },
  ];
  const frame = {
    seed: 7,
    tick: 2,
    width: 1_000,
    height: 650,
    checksum: "probe",
    environment: { journeys: { arrivalRadius: 25 } },
    land: { cells: [], geometry: { worldWidth: 1_000, worldHeight: 650 } },
    circulation: { edges: [] },
    activity: { destinations: [] },
  };
  const checkpoint = analyzeDeadlockCheckpoint(observations, frame, {
    scenarioId: "probe <&>",
    distanceThreshold: 25,
    trajectoryStride: 1,
  });

  assert.deepEqual(checkpoint.mobility.stuckAgentIds, [1]);
  assert.equal(checkpoint.diagnostics[0].metrics.displacement, 10);
  assert.equal(checkpoint.diagnostics[0].metrics.pathLength, 110);
  assert.equal(checkpoint.diagnostics[0].trajectory.length, 3);

  const svg = renderDeadlockAtlasSvg({ runs: [{ seed: 7, checkpoints: [checkpoint] }] }, {
    seed: 7,
    checkpoint: 2,
  });
  assert.match(svg, /<polyline points="0,100 60,100 10,100"/);
  assert.match(svg, /probe &lt;&amp;&gt; deadlock atlas/);
  assert.doesNotMatch(svg, /probe <&>/);
});

test("a walker inside a legal easement is not classified as buried private land", () => {
  const target = { id: "east", kind: "authored", x: 900, y: 50, radius: 25 };
  const observations = (insideEasement) => [
    {
      tick: 0,
      agents: [{
        ...sample(1, 48, 50, { target }),
        land: { landId: "land-0-0", state: "claimed", hasEasement: insideEasement, insideEasement },
      }],
    },
    {
      tick: 1,
      agents: [{
        ...sample(1, 50, 50, { target }),
        land: { landId: "land-0-0", state: "claimed", hasEasement: insideEasement, insideEasement },
      }],
    },
  ];
  const baseFrame = {
    seed: 9,
    tick: 1,
    width: 1_000,
    height: 650,
    environment: { journeys: { arrivalRadius: 25 } },
    land: {
      cells: [{
        id: "land-0-0",
        state: "claimed",
        ownerId: 4,
        parcelId: "parcel-4",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      }],
    },
    activity: { destinations: [] },
  };
  const easement = {
    id: "easement:land-0-0",
    landId: "land-0-0",
    easement: true,
    acquired: false,
    x1: 0,
    y1: 50,
    x2: 100,
    y2: 50,
    width: 15,
  };
  const legal = analyzeDeadlockCheckpoint(observations(true), {
    ...baseFrame,
    circulation: { edges: [easement] },
  });
  assert.equal(legal.diagnostics[0].context.insideClaimedCell, null);
  assert.equal(legal.diagnostics[0].context.insideEasementCell.id, "land-0-0");
  assert.notEqual(legal.diagnostics[0].category, "inside-private-land");

  const buried = analyzeDeadlockCheckpoint(observations(false), {
    ...baseFrame,
    circulation: { edges: [] },
  });
  assert.equal(buried.diagnostics[0].category, "inside-private-land");
  assert.equal(buried.diagnostics[0].metrics.privateEntryMode, "pre-existing-before-window");
});

test("short multi-checkpoint atlas runs replay deterministically", () => {
  const options = {
    seeds: [104],
    checkpoints: [8, 16],
    windowTicks: 5,
    population: 6,
  };
  const first = runDeadlockAtlas(options);
  const replay = runDeadlockAtlas(options);

  assert.deepEqual(replay, first);
  assert.deepEqual(first.configuration.checkpoints, [8, 16]);
  assert.equal(first.runs[0].checkpoints.length, 2);
  assert.equal(first.aggregate.checkpointObservations, 2);
  assert.ok(first.aggregate.repeatedSeedAgents >= 0);
});
