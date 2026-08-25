import { getScenario } from "../scenarios.js";
import { compileBehavior } from "./compiler.js";
import { SimulationEngine } from "./engine.js";
import {
  DEFAULT_EVALUATION_SEEDS,
  evaluateMobilityWindow,
} from "./scenario-evaluation.js";

const EPSILON = 1e-9;

export const DEFAULT_DEADLOCK_CHECKPOINTS = Object.freeze([1_000, 1_500, 2_000, 2_400]);

export const DEADLOCK_CATEGORIES = Object.freeze([
  "inside-private-land",
  "route-reset",
  "activity-frontage",
  "parcel-face-collision",
  "parcel-corner-oscillation",
  "blocked-direct-line",
  "crowding",
  "looping-detour",
  "low-motion",
  "unclassified",
]);

export const DEADLOCK_CATEGORY_COLORS = Object.freeze({
  "inside-private-land": "#b42318",
  "route-reset": "#7f56d9",
  "activity-frontage": "#c11574",
  "parcel-face-collision": "#e04f16",
  "parcel-corner-oscillation": "#f79009",
  "blocked-direct-line": "#d6a800",
  crowding: "#1570ef",
  "looping-detour": "#039855",
  "low-motion": "#667085",
  unclassified: "#344054",
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value, fallback) {
  return Math.max(1, Math.round(finiteNumber(value, fallback)));
}

function nonNegativeInteger(value, fallback = 0) {
  return Math.max(0, Math.round(finiteNumber(value, fallback)));
}

function freezeArray(values) {
  return Object.freeze(values);
}

function compareIds(first, second) {
  const firstId = String(first);
  const secondId = String(second);
  return firstId < secondId ? -1 : firstId > secondId ? 1 : 0;
}

function mean(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function formatNumber(value, digits = 1) {
  return finiteNumber(value).toFixed(digits);
}

function normalizedCheckpoints(values) {
  const checkpoints = [...new Set((Array.isArray(values) ? values : DEFAULT_DEADLOCK_CHECKPOINTS)
    .map((value) => nonNegativeInteger(value, -1))
    .filter((value) => value > 0))]
    .sort((first, second) => first - second);
  if (checkpoints.length === 0) throw new TypeError("At least one positive checkpoint is required.");
  return freezeArray(checkpoints);
}

function normalizedSeeds(values) {
  const seeds = (Array.isArray(values) ? values : DEFAULT_EVALUATION_SEEDS)
    .map((value) => nonNegativeInteger(value, 0) >>> 0);
  if (seeds.length === 0) throw new TypeError("At least one seed is required.");
  return freezeArray(seeds);
}

function snapshotDestination(destination) {
  if (!destination) return null;
  return Object.freeze({
    id: String(destination.id),
    label: String(destination.label ?? destination.id),
    kind: String(destination.kind ?? "authored"),
    x: finiteNumber(destination.x),
    y: finiteNumber(destination.y),
    radius: Math.max(0, finiteNumber(destination.radius)),
    weight: Math.max(0, finiteNumber(destination.weight)),
    landId: destination.landId ? String(destination.landId) : null,
    roadLandId: destination.roadLandId ? String(destination.roadLandId) : null,
    parcelId: destination.parcelId ? String(destination.parcelId) : null,
    ownerId: Number.isSafeInteger(destination.ownerId) ? destination.ownerId : null,
    side: destination.side ? String(destination.side) : null,
  });
}

function snapshotJourney(journey) {
  if (!journey) return null;
  return Object.freeze({
    targetX: finiteNumber(journey.targetX),
    targetY: finiteNumber(journey.targetY),
    directDistance: Math.max(0, finiteNumber(journey.directDistance)),
    traveledDistance: Math.max(0, finiteNumber(journey.traveledDistance)),
    detourDistance: Math.max(0, finiteNumber(journey.detourDistance)),
    detourRatio: Math.max(1, finiteNumber(journey.detourRatio, 1)),
    stalledTicks: nonNegativeInteger(journey.stalledTicks),
    immobileTicks: nonNegativeInteger(journey.immobileTicks),
    blockedLandId: journey.blockedLandId ? String(journey.blockedLandId) : null,
    mobilityAnchorX: finiteNumber(journey.mobilityAnchorX),
    mobilityAnchorY: finiteNumber(journey.mobilityAnchorY),
  });
}

function landStateAt(engine, agent) {
  const land = engine.land;
  const geometry = land?.config?.geometry;
  if (!land || !geometry || !Array.isArray(land.config.cells)) return null;
  const pitch = Math.max(EPSILON, finiteNumber(geometry.pitch, geometry.cellSize));
  const column = Math.floor((agent.x - finiteNumber(geometry.x)) / pitch);
  const row = Math.floor((agent.y - finiteNumber(geometry.y)) / pitch);
  if (column < 0 || row < 0 || column >= geometry.columns || row >= geometry.rows) return null;
  const cell = land.config.cells[row * geometry.columns + column];
  if (!cell || agent.x < cell.x || agent.x > cell.x + cell.width
    || agent.y < cell.y || agent.y > cell.y + cell.height) return null;
  const ownerId = land.ownerByCell[cell.index];
  const reservedBy = land.reservedByCell[cell.index];
  const easement = ownerId !== -1 ? engine.circulation?.easement(cell.id) : null;
  const insideEasement = Boolean(easement
    && pointToSegmentDistance(agent, easement)
      <= Math.max(1, finiteNumber(easement.width, 1) / 2) + 0.01);
  return Object.freeze({
    landId: String(cell.id),
    state: ownerId !== -1 ? "claimed" : reservedBy !== -1 ? "reserved" : "unclaimed",
    ownerId: ownerId === -1 ? null : ownerId,
    reservedBy: reservedBy === -1 ? null : reservedBy,
    hasEasement: Boolean(easement),
    insideEasement,
  });
}

function snapshotEvents(engine) {
  const layers = [
    ["land", engine.land?.lastEvents],
    ["circulation", engine.circulation?.lastEvents],
    ["activity", engine.activity?.lastEvents],
  ];
  return freezeArray(layers.flatMap(([layer, events]) => (
    Array.isArray(events) ? events.map((event) => Object.freeze({
      layer,
      type: String(event.type ?? "event"),
      tick: nonNegativeInteger(event.tick, engine.tick),
      landId: event.landId ? String(event.landId) : null,
      agentId: Number.isSafeInteger(event.agentId) ? event.agentId : null,
      ownerId: Number.isSafeInteger(event.ownerId) ? event.ownerId : null,
      reason: event.reason ? String(event.reason) : null,
      cause: event.cause ? String(event.cause) : null,
    })) : []
  )));
}

/** Capture only the trajectory evidence needed by the diagnostic ring buffer. */
export function captureDeadlockObservation(engine) {
  if (!engine || !Array.isArray(engine.agents)) {
    throw new TypeError("A SimulationEngine instance is required.");
  }
  const agents = [...engine.agents]
    .sort((first, second) => first.id - second.id)
    .map((agent) => Object.freeze({
      id: agent.id,
      x: finiteNumber(agent.x),
      y: finiteNumber(agent.y),
      vx: finiteNumber(agent.vx),
      vy: finiteNumber(agent.vy),
      radius: Math.max(0, finiteNumber(agent.radius)),
      destinationId: agent.destinationId === null || agent.destinationId === undefined
        ? null
        : String(agent.destinationId),
      arrivalCount: nonNegativeInteger(agent.arrivalCount),
      target: snapshotDestination(engine.destinationById?.get(agent.destinationId)),
      journey: snapshotJourney(engine.circulation?.journeyByAgent?.get(agent.id)),
      land: landStateAt(engine, agent),
    }));
  return Object.freeze({
    tick: nonNegativeInteger(engine.tick),
    agents: freezeArray(agents),
    events: snapshotEvents(engine),
  });
}

function pointToRectangleDistance(point, rectangle) {
  const right = finiteNumber(rectangle.x) + Math.max(0, finiteNumber(rectangle.width));
  const bottom = finiteNumber(rectangle.y) + Math.max(0, finiteNumber(rectangle.height));
  const dx = Math.max(finiteNumber(rectangle.x) - point.x, 0, point.x - right);
  const dy = Math.max(finiteNumber(rectangle.y) - point.y, 0, point.y - bottom);
  return Math.hypot(dx, dy);
}

function pointInsideRectangle(point, rectangle, inset = 0) {
  const left = finiteNumber(rectangle.x) + inset;
  const top = finiteNumber(rectangle.y) + inset;
  const right = finiteNumber(rectangle.x) + finiteNumber(rectangle.width) - inset;
  const bottom = finiteNumber(rectangle.y) + finiteNumber(rectangle.height) - inset;
  return point.x > left && point.x < right && point.y > top && point.y < bottom;
}

function pointToSegmentDistance(point, segment) {
  const x1 = finiteNumber(segment.x1);
  const y1 = finiteNumber(segment.y1);
  const dx = finiteNumber(segment.x2) - x1;
  const dy = finiteNumber(segment.y2) - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return Math.hypot(point.x - x1, point.y - y1);
  const ratio = Math.max(0, Math.min(1, ((point.x - x1) * dx + (point.y - y1) * dy) / lengthSquared));
  return Math.hypot(point.x - (x1 + dx * ratio), point.y - (y1 + dy * ratio));
}

function clipSegmentToRectangle(from, to, rectangle, padding = 0) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const bounds = {
    left: finiteNumber(rectangle.x) - padding,
    right: finiteNumber(rectangle.x) + finiteNumber(rectangle.width) + padding,
    top: finiteNumber(rectangle.y) - padding,
    bottom: finiteNumber(rectangle.y) + finiteNumber(rectangle.height) + padding,
  };
  let enter = 0;
  let leave = 1;
  const clips = [
    [-dx, from.x - bounds.left],
    [dx, bounds.right - from.x],
    [-dy, from.y - bounds.top],
    [dy, bounds.bottom - from.y],
  ];
  for (const [direction, distance] of clips) {
    if (Math.abs(direction) <= EPSILON) {
      if (distance < 0) return null;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) enter = Math.max(enter, ratio);
    else leave = Math.min(leave, ratio);
    if (enter > leave) return null;
  }
  return Object.freeze({ enter, leave });
}

function pointAlong(from, to, ratio) {
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  };
}

function segmentUsesEasement(from, to, clipped, easement) {
  if (!easement) return false;
  const halfWidth = Math.max(1, finiteNumber(easement.width, 1) / 2) + 0.01;
  const ratios = [clipped.enter, (clipped.enter + clipped.leave) / 2, clipped.leave];
  return ratios.every((ratio) => pointToSegmentDistance(pointAlong(from, to, ratio), easement) <= halfWidth);
}

function conciseCell(cell, distance = undefined) {
  if (!cell) return null;
  return Object.freeze({
    id: String(cell.id),
    ownerId: Number.isSafeInteger(cell.ownerId) ? cell.ownerId : null,
    parcelId: cell.parcelId ? String(cell.parcelId) : null,
    x: finiteNumber(cell.x),
    y: finiteNumber(cell.y),
    width: Math.max(0, finiteNumber(cell.width)),
    height: Math.max(0, finiteNumber(cell.height)),
    ...(distance === undefined ? {} : { distance: Math.max(0, finiteNumber(distance)) }),
  });
}

function nearestNeighborEvidence(observations, agentId, crowdingDistance) {
  const distances = [];
  for (const observation of observations) {
    const agent = observation.agents.find((candidate) => String(candidate.id) === String(agentId));
    if (!agent) continue;
    let nearest = Infinity;
    for (const other of observation.agents) {
      if (String(other.id) === String(agentId)) continue;
      nearest = Math.min(nearest, Math.hypot(agent.x - other.x, agent.y - other.y));
    }
    if (Number.isFinite(nearest)) distances.push(nearest);
  }
  return Object.freeze({
    minimum: distances.length > 0 ? Math.min(...distances) : Infinity,
    mean: distances.length > 0 ? mean(distances) : Infinity,
    crowdedShare: distances.length > 0
      ? distances.filter((distance) => distance <= crowdingDistance).length / distances.length
      : 0,
  });
}

function trajectoryMetrics(observations, agentId, crowdingDistance) {
  const samples = observations.flatMap((observation) => {
    const agent = observation.agents.find((candidate) => String(candidate.id) === String(agentId));
    return agent ? [{ ...agent, tick: observation.tick }] : [];
  });
  if (samples.length === 0) return null;
  const first = samples[0];
  const last = samples.at(-1);
  let pathLength = 0;
  let sharpTurns = 0;
  let stationarySteps = 0;
  let priorMovement = null;
  let destinationSwitches = 0;
  const destinationIds = new Set(first.destinationId ? [first.destinationId] : []);
  const blockedCounts = new Map();
  let maximumStalledTicks = 0;
  let maximumImmobileTicks = 0;
  let maximumDetourRatio = 1;
  let minimumX = first.x;
  let maximumX = first.x;
  let minimumY = first.y;
  let maximumY = first.y;
  let speedTotal = 0;
  let maximumSpeed = 0;
  let insidePrivateSamples = 0;
  let insideEasementSamples = 0;
  let firstInsidePrivateTick = null;
  let privateEntryMode = null;
  let privateEntryEvents = freezeArray([]);
  const privateLandIds = new Set();

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const speed = Math.hypot(sample.vx, sample.vy);
    speedTotal += speed;
    maximumSpeed = Math.max(maximumSpeed, speed);
    minimumX = Math.min(minimumX, sample.x);
    maximumX = Math.max(maximumX, sample.x);
    minimumY = Math.min(minimumY, sample.y);
    maximumY = Math.max(maximumY, sample.y);
    maximumStalledTicks = Math.max(maximumStalledTicks, sample.journey?.stalledTicks ?? 0);
    maximumImmobileTicks = Math.max(maximumImmobileTicks, sample.journey?.immobileTicks ?? 0);
    maximumDetourRatio = Math.max(maximumDetourRatio, sample.journey?.detourRatio ?? 1);
    const insidePrivate = sample.land?.state === "claimed" && sample.land.insideEasement !== true;
    if (sample.land?.state === "claimed" && sample.land.insideEasement === true) {
      insideEasementSamples += 1;
    }
    if (insidePrivate) {
      insidePrivateSamples += 1;
      privateLandIds.add(sample.land.landId);
      const priorLand = index > 0 ? samples[index - 1].land : null;
      const priorInsidePrivate = priorLand?.state === "claimed" && priorLand.insideEasement !== true;
      if (firstInsidePrivateTick === null && !priorInsidePrivate) {
        firstInsidePrivateTick = sample.tick;
        if (index === 0) privateEntryMode = "pre-existing-before-window";
        else if (priorLand?.landId === sample.land.landId && priorLand.state !== "claimed") {
          privateEntryMode = "claim-around-agent";
        } else if (priorLand?.landId === sample.land.landId
          && priorLand.insideEasement === true
          && sample.land.hasEasement !== true) {
          privateEntryMode = "easement-closed-around-agent";
        } else if (priorLand?.landId === sample.land.landId && priorLand.insideEasement === true) {
          privateEntryMode = "left-easement-corridor";
        } else {
          privateEntryMode = "entered-private-land";
        }
        privateEntryEvents = freezeArray((observations
          .find((observation) => observation.tick === sample.tick)?.events ?? [])
          .filter((event) => event.landId === sample.land.landId));
      }
    }
    if (sample.journey?.blockedLandId) {
      blockedCounts.set(
        sample.journey.blockedLandId,
        (blockedCounts.get(sample.journey.blockedLandId) ?? 0) + 1,
      );
    }
    if (index === 0) continue;
    const prior = samples[index - 1];
    if (sample.destinationId !== prior.destinationId
      && (sample.destinationId !== null || prior.destinationId !== null)) {
      destinationSwitches += 1;
    }
    if (sample.destinationId) destinationIds.add(sample.destinationId);
    const movement = { x: sample.x - prior.x, y: sample.y - prior.y };
    const distance = Math.hypot(movement.x, movement.y);
    pathLength += distance;
    if (distance < 0.05) stationarySteps += 1;
    if (priorMovement) {
      const priorDistance = Math.hypot(priorMovement.x, priorMovement.y);
      if (distance > 0.05 && priorDistance > 0.05) {
        const cosine = (movement.x * priorMovement.x + movement.y * priorMovement.y)
          / (distance * priorDistance);
        if (cosine < 0) sharpTurns += 1;
      }
    }
    if (distance > 0.05) priorMovement = movement;
  }

  const dominantBlocker = [...blockedCounts.entries()]
    .sort((firstEntry, secondEntry) => secondEntry[1] - firstEntry[1]
      || compareIds(firstEntry[0], secondEntry[0]))[0] ?? null;
  const arrivals = Math.max(0, last.arrivalCount - first.arrivalCount);
  const displacement = Math.hypot(last.x - first.x, last.y - first.y);
  const nearest = nearestNeighborEvidence(observations, agentId, crowdingDistance);
  return {
    samples,
    public: Object.freeze({
      sampleCount: samples.length,
      displacement,
      pathLength,
      pathToDisplacementRatio: pathLength / Math.max(EPSILON, displacement),
      boundingWidth: maximumX - minimumX,
      boundingHeight: maximumY - minimumY,
      boundingDiagonal: Math.hypot(maximumX - minimumX, maximumY - minimumY),
      meanSpeed: speedTotal / samples.length,
      maximumSpeed,
      stationaryShare: samples.length > 1 ? stationarySteps / (samples.length - 1) : 0,
      sharpTurns,
      arrivals,
      destinationSwitches,
      unexplainedDestinationSwitches: Math.max(0, destinationSwitches - arrivals),
      destinationIds: freezeArray([...destinationIds].sort(compareIds)),
      blockedSamples: [...blockedCounts.values()].reduce((sum, count) => sum + count, 0),
      dominantBlockedLandId: dominantBlocker?.[0] ?? null,
      dominantBlockedSamples: dominantBlocker?.[1] ?? 0,
      maximumStalledTicks,
      maximumImmobileTicks,
      maximumDetourRatio,
      insidePrivateSamples,
      insideEasementSamples,
      firstInsidePrivateTick,
      privateEntryMode,
      privateEntryEvents,
      privateLandIds: freezeArray([...privateLandIds].sort(compareIds)),
      minimumNearestNeighbor: nearest.minimum,
      meanNearestNeighbor: nearest.mean,
      crowdedShare: nearest.crowdedShare,
    }),
  };
}

function directBlockers(
  from,
  target,
  radius,
  claimedCells,
  easementsByLandId,
  circulationByLandId,
  easementPressureThreshold,
) {
  if (!target) return freezeArray([]);
  return freezeArray(claimedCells.flatMap((cell) => {
    const clipped = clipSegmentToRectangle(from, target, cell, radius);
    if (!clipped) return [];
    const easement = easementsByLandId.get(String(cell.id)) ?? null;
    const circulation = circulationByLandId.get(String(cell.id)) ?? null;
    const entryPoint = pointAlong(from, target, clipped.enter);
    const pressure = Math.max(0, finiteNumber(circulation?.pressure));
    return [Object.freeze({
      landId: String(cell.id),
      ownerId: Number.isSafeInteger(cell.ownerId) ? cell.ownerId : null,
      parcelId: cell.parcelId ? String(cell.parcelId) : null,
      distance: Math.hypot(entryPoint.x - from.x, entryPoint.y - from.y),
      hasEasement: Boolean(easement),
      usableEasement: segmentUsesEasement(from, target, clipped, easement),
      pressure,
      pressureRatio: pressure / Math.max(EPSILON, easementPressureThreshold),
    })];
  }).sort((first, second) => first.distance - second.distance || compareIds(first.landId, second.landId)));
}

function spatialContext(frame, finalSample, {
  localBlockerDistance = 90,
  easementPressureThreshold = 14,
} = {}) {
  const claimedCells = (Array.isArray(frame?.land?.cells) ? frame.land.cells : [])
    .filter((cell) => cell?.state === "claimed");
  const easements = (Array.isArray(frame?.circulation?.edges) ? frame.circulation.edges : [])
    .filter((edge) => edge?.easement === true);
  const easementsByLandId = new Map(easements.map((edge) => [String(edge.landId), edge]));
  const circulationByLandId = new Map(
    (Array.isArray(frame?.circulation?.cells) ? frame.circulation.cells : [])
      .map((cell) => [String(cell.id), cell]),
  );
  const point = { x: finalSample.x, y: finalSample.y };
  const distances = claimedCells
    .map((cell) => ({ cell, distance: pointToRectangleDistance(point, cell) }))
    .sort((first, second) => first.distance - second.distance || compareIds(first.cell.id, second.cell.id));
  const inside = claimedCells
    .filter((cell) => pointInsideRectangle(point, cell, 0.01))
    .sort((first, second) => compareIds(first.id, second.id));
  const insideEasement = inside.filter((cell) => {
    const easement = easementsByLandId.get(String(cell.id));
    return easement
      && pointToSegmentDistance(point, easement) <= Math.max(1, finiteNumber(easement.width, 1) / 2) + 0.01;
  });
  const insidePrivate = inside.filter((cell) => !insideEasement.includes(cell));
  const overlapping = distances
    .filter(({ distance }) => distance + 0.05 < finalSample.radius)
    .map(({ cell, distance }) => conciseCell(cell, distance));
  const target = finalSample.target;
  const journeyArrivalRadius = Math.max(0, finiteNumber(frame?.environment?.journeys?.arrivalRadius));
  const arrivalRadius = target ? Math.max(journeyArrivalRadius, target.radius) : journeyArrivalRadius;
  const targetDistance = target ? Math.hypot(target.x - point.x, target.y - point.y) : Infinity;
  const nearestEasement = easements
    .map((edge) => ({ edge, distance: pointToSegmentDistance(point, edge) }))
    .sort((first, second) => first.distance - second.distance || compareIds(first.edge.id, second.edge.id))[0];
  const blockers = directBlockers(
    point,
    target,
    finalSample.radius,
    claimedCells,
    easementsByLandId,
    circulationByLandId,
    Math.max(EPSILON, finiteNumber(easementPressureThreshold, 14)),
  );
  const unresolved = blockers.filter((blocker) => !blocker.usableEasement);
  return Object.freeze({
    final: Object.freeze({
      x: finalSample.x,
      y: finalSample.y,
      radius: finalSample.radius,
      destinationId: finalSample.destinationId,
    }),
    target,
    targetDistance,
    arrivalRadius,
    // A cadastral cell can remain claimed around a legal narrow easement. Only
    // report an inside-private-land signal when the walker is outside that
    // corridor; otherwise the apparently "buried" centre is legitimate.
    insideClaimedCell: conciseCell(insidePrivate[0]),
    insideEasementCell: conciseCell(insideEasement[0]),
    overlappingClaimedCells: freezeArray(overlapping),
    nearestClaimedCell: distances[0] ? conciseCell(distances[0].cell, distances[0].distance) : null,
    nearestEasement: nearestEasement ? Object.freeze({
      id: String(nearestEasement.edge.id),
      landId: nearestEasement.edge.landId ? String(nearestEasement.edge.landId) : null,
      distance: nearestEasement.distance,
      acquired: nearestEasement.edge.acquired === true,
      width: Math.max(0, finiteNumber(nearestEasement.edge.width)),
    }) : null,
    directBlockers: blockers,
    unresolvedDirectBlockers: freezeArray(unresolved),
    localDirectBlockers: freezeArray(unresolved.filter(
      (blocker) => blocker.distance <= Math.max(0, finiteNumber(localBlockerDistance, 90)),
    )),
    localBlockerDistance: Math.max(0, finiteNumber(localBlockerDistance, 90)),
    easementPressureThreshold: Math.max(EPSILON, finiteNumber(easementPressureThreshold, 14)),
  });
}

function confidenceFor(category, metrics) {
  if (category === "inside-private-land") return "high";
  if (category === "parcel-face-collision" && metrics.blockedSamples >= 10) return "high";
  if (["low-motion", "unclassified"].includes(category)) return "low";
  return "medium";
}

/**
 * Assign descriptive signals to one endpoint-stuck journey. These are
 * deliberately heuristic: they narrow the next investigation, not prove a
 * simulation cause.
 */
export function classifyDeadlockSignals(metrics, context, {
  distanceThreshold = 25,
  crowdingDistance = 20,
  localBlockerDistance = 90,
} = {}) {
  const threshold = Math.max(0, finiteNumber(distanceThreshold, 25));
  const signals = [];
  const nearParcel = context.nearestClaimedCell
    && context.nearestClaimedCell.distance <= finiteNumber(context.final?.radius) + 8;
  if (context.insideClaimedCell) signals.push("inside-private-land");
  if (metrics.unexplainedDestinationSwitches > 0) signals.push("route-reset");
  if (context.target?.kind === "parcel-activity"
    && context.targetDistance <= context.arrivalRadius + Math.max(20, threshold)
    && (metrics.maximumImmobileTicks >= 15 || metrics.blockedSamples >= 2 || nearParcel)) {
    signals.push("activity-frontage");
  }
  if (metrics.dominantBlockedLandId
    && (metrics.blockedSamples >= 3 || metrics.maximumStalledTicks >= 3)) {
    signals.push("parcel-face-collision");
  }
  if (nearParcel
    && metrics.pathLength >= Math.max(40, threshold * 1.5)
    && metrics.boundingDiagonal <= Math.max(60, threshold * 2.5)
    && (metrics.sharpTurns >= 4 || metrics.pathToDisplacementRatio >= 3)) {
    signals.push("parcel-corner-oscillation");
  }
  const localDirectBlockers = Array.isArray(context.localDirectBlockers)
    ? context.localDirectBlockers
    : context.unresolvedDirectBlockers
      .filter((blocker) => blocker.distance <= Math.max(0, finiteNumber(localBlockerDistance, 90)));
  if (localDirectBlockers.length > 0
    && (metrics.maximumImmobileTicks >= 25 || metrics.blockedSamples > 0)) {
    signals.push("blocked-direct-line");
  }
  if (metrics.crowdedShare >= 0.45 && metrics.minimumNearestNeighbor <= crowdingDistance) {
    signals.push("crowding");
  }
  if (metrics.pathLength >= Math.max(35, threshold * 2)
    && metrics.displacement / Math.max(EPSILON, metrics.pathLength) < 0.35) {
    signals.push("looping-detour");
  }
  if (metrics.pathLength < threshold) signals.push("low-motion");
  if (signals.length === 0) signals.push("unclassified");

  const orderedSignals = DEADLOCK_CATEGORIES.filter((category) => signals.includes(category));
  const category = orderedSignals[0];
  const evidence = [
    `${formatNumber(metrics.displacement)} net units and ${formatNumber(metrics.pathLength)} path units over ${metrics.sampleCount} samples`,
    `${metrics.arrivals} arrivals and ${metrics.destinationSwitches} destination switches`,
  ];
  if (metrics.dominantBlockedLandId) {
    evidence.push(`${metrics.blockedSamples} collision samples; ${metrics.dominantBlockedLandId} dominates ${metrics.dominantBlockedSamples}`);
  }
  if (metrics.maximumImmobileTicks > 0 || metrics.maximumStalledTicks > 0) {
    evidence.push(`journey counters peak at ${metrics.maximumImmobileTicks} immobile and ${metrics.maximumStalledTicks} hard-stall ticks`);
  }
  if (context.insideClaimedCell && metrics.privateEntryMode) {
    evidence.push(`off-corridor private occupancy began at tick ${metrics.firstInsidePrivateTick} via ${metrics.privateEntryMode}`);
    if (metrics.privateEntryEvents.length > 0) {
      evidence.push(`same-tick cell events: ${metrics.privateEntryEvents.map((event) => `${event.layer}:${event.type}`).join(", ")}`);
    }
  }
  if (context.target) {
    evidence.push(`${formatNumber(context.targetDistance)} units from ${context.target.kind} target ${context.target.id} (arrival radius ${formatNumber(context.arrivalRadius)})`);
  }
  if (context.nearestClaimedCell) {
    evidence.push(`nearest claimed cell ${context.nearestClaimedCell.id} is ${formatNumber(context.nearestClaimedCell.distance)} units away`);
  }
  if (localDirectBlockers.length > 0) {
    const firstBlocker = localDirectBlockers[0];
    evidence.push(
      `${localDirectBlockers.length} claimed direct-line blocker(s) within ${formatNumber(context.localBlockerDistance ?? localBlockerDistance, 0)} units lack an aligned easement; `
      + `${firstBlocker.landId} has ${formatNumber(firstBlocker.pressureRatio * 100, 0)}% of opening pressure`,
    );
  }
  if (metrics.crowdedShare > 0) {
    evidence.push(`another walker is within ${formatNumber(crowdingDistance, 0)} units in ${formatNumber(metrics.crowdedShare * 100, 0)}% of samples`);
  }
  return Object.freeze({
    category,
    confidence: confidenceFor(category, metrics),
    signals: freezeArray(orderedSignals),
    evidence: freezeArray(evidence),
  });
}

function sampledTrajectory(samples, stride) {
  const interval = positiveInteger(stride, 4);
  return freezeArray(samples
    .filter((sample, index) => index === 0 || index === samples.length - 1 || index % interval === 0)
    .map((sample) => Object.freeze({ tick: sample.tick, x: sample.x, y: sample.y })));
}

function emptyCounts() {
  return Object.fromEntries(DEADLOCK_CATEGORIES.map((category) => [category, 0]));
}

function mapSnapshot(frame) {
  const cells = Array.isArray(frame?.land?.cells) ? frame.land.cells : [];
  const edges = Array.isArray(frame?.circulation?.edges) ? frame.circulation.edges : [];
  return Object.freeze({
    width: Math.max(1, finiteNumber(frame?.width, frame?.land?.geometry?.worldWidth ?? 1_000)),
    height: Math.max(1, finiteNumber(frame?.height, frame?.land?.geometry?.worldHeight ?? 650)),
    claimedCells: freezeArray(cells
      .filter((cell) => cell?.state === "claimed")
      .map((cell) => conciseCell(cell))),
    reservedCells: freezeArray(cells
      .filter((cell) => cell?.state === "reserved")
      .map((cell) => Object.freeze({
        ...conciseCell(cell),
        reservedBy: Number.isSafeInteger(cell.reservedBy) ? cell.reservedBy : null,
      }))),
    edges: freezeArray(edges.map((edge) => Object.freeze({
      id: String(edge.id),
      landId: edge.landId ? String(edge.landId) : null,
      x1: finiteNumber(edge.x1),
      y1: finiteNumber(edge.y1),
      x2: finiteNumber(edge.x2),
      y2: finiteNumber(edge.y2),
      width: Math.max(0.5, finiteNumber(edge.width, 1)),
      status: String(edge.status ?? "path"),
      hierarchy: String(edge.hierarchy ?? "path"),
      flow: edge.flow === true,
      easement: edge.easement === true,
      acquired: edge.acquired === true,
    }))),
    activities: freezeArray((Array.isArray(frame?.activity?.destinations) ? frame.activity.destinations : [])
      .map(snapshotDestination)),
  });
}

/** Analyze one rolling trajectory window against its final map state. */
export function analyzeDeadlockCheckpoint(observations, frame, {
  scenarioId = "territory-growth",
  distanceThreshold = 25,
  crowdingDistance = 20,
  trajectoryStride = 4,
  localBlockerDistance = 90,
  easementPressureThreshold = 14,
} = {}) {
  if (!Array.isArray(observations) || observations.length < 2) {
    throw new TypeError("At least two ordered trajectory observations are required.");
  }
  const ordered = [...observations].sort((first, second) => first.tick - second.tick);
  const mobility = evaluateMobilityWindow(ordered[0], ordered.at(-1), { distanceThreshold });
  const diagnostics = mobility.stuckAgentIds.flatMap((agentId) => {
    const measured = trajectoryMetrics(ordered, agentId, crowdingDistance);
    if (!measured) return [];
    const finalSample = measured.samples.at(-1);
    const context = spatialContext(frame, finalSample, {
      localBlockerDistance,
      easementPressureThreshold,
    });
    const classification = classifyDeadlockSignals(measured.public, context, {
      distanceThreshold,
      crowdingDistance,
      localBlockerDistance,
    });
    return [Object.freeze({
      agentId,
      category: classification.category,
      confidence: classification.confidence,
      signals: classification.signals,
      evidence: classification.evidence,
      metrics: measured.public,
      context,
      trajectory: sampledTrajectory(measured.samples, trajectoryStride),
    })];
  }).sort((first, second) => first.agentId - second.agentId);
  const categoryCounts = emptyCounts();
  const signalCounts = emptyCounts();
  for (const diagnostic of diagnostics) {
    categoryCounts[diagnostic.category] += 1;
    for (const signal of diagnostic.signals) signalCounts[signal] += 1;
  }
  return Object.freeze({
    scenarioId: String(scenarioId),
    seed: nonNegativeInteger(frame?.seed),
    tick: nonNegativeInteger(frame?.tick, ordered.at(-1).tick),
    checksum: frame?.checksum ?? null,
    window: Object.freeze({
      startTick: ordered[0].tick,
      endTick: ordered.at(-1).tick,
      ticks: ordered.at(-1).tick - ordered[0].tick,
      distanceThreshold: Math.max(0, finiteNumber(distanceThreshold, 25)),
      crowdingDistance: Math.max(0, finiteNumber(crowdingDistance, 20)),
    }),
    mobility,
    categoryCounts: Object.freeze(categoryCounts),
    signalCounts: Object.freeze(signalCounts),
    localBlockers: summarizeLocalBlockers(diagnostics),
    diagnostics: freezeArray(diagnostics),
    map: mapSnapshot(frame),
  });
}

function localBlockerSummary(blockers) {
  const withoutEasement = blockers.filter((blocker) => !blocker.hasEasement);
  const misaligned = blockers.filter((blocker) => blocker.hasEasement && !blocker.usableEasement);
  return Object.freeze({
    episodes: blockers.length,
    withoutEasement: withoutEasement.length,
    misalignedEasement: misaligned.length,
    atOpeningPressure: blockers.filter((blocker) => blocker.pressureRatio >= 1).length,
    nearOpeningPressure: withoutEasement.filter((blocker) => blocker.pressureRatio >= 0.75).length,
    meanPressureRatio: blockers.length > 0 ? mean(blockers.map((blocker) => blocker.pressureRatio)) : 0,
    meanPressureWithoutEasement: withoutEasement.length > 0
      ? mean(withoutEasement.map((blocker) => blocker.pressureRatio))
      : 0,
    meanPressureMisaligned: misaligned.length > 0
      ? mean(misaligned.map((blocker) => blocker.pressureRatio))
      : 0,
  });
}

function summarizeLocalBlockers(diagnostics) {
  return localBlockerSummary(
    diagnostics.flatMap((diagnostic) => diagnostic.context.localDirectBlockers.slice(0, 1)),
  );
}

function aggregateAtlas(runs) {
  const categoryCounts = emptyCounts();
  const signalCounts = emptyCounts();
  let checkpointObservations = 0;
  let stuckObservations = 0;
  const uniqueSeedAgents = new Set();
  const observationsBySeedAgent = new Map();
  const localBlockers = [];
  for (const run of runs) {
    for (const checkpoint of run.checkpoints) {
      checkpointObservations += 1;
      stuckObservations += checkpoint.diagnostics.length;
      localBlockers.push(...checkpoint.diagnostics
        .flatMap((diagnostic) => diagnostic.context.localDirectBlockers.slice(0, 1)));
      for (const category of DEADLOCK_CATEGORIES) {
        categoryCounts[category] += checkpoint.categoryCounts[category];
        signalCounts[category] += checkpoint.signalCounts[category];
      }
      for (const diagnostic of checkpoint.diagnostics) {
        const key = `${run.seed}:${diagnostic.agentId}`;
        uniqueSeedAgents.add(key);
        const existing = observationsBySeedAgent.get(key) ?? {
          seed: run.seed,
          agentId: diagnostic.agentId,
          ticks: [],
          categories: [],
        };
        existing.ticks.push(checkpoint.tick);
        existing.categories.push(diagnostic.category);
        observationsBySeedAgent.set(key, existing);
      }
    }
  }
  return Object.freeze({
    checkpointObservations,
    stuckObservations,
    uniqueSeedAgents: uniqueSeedAgents.size,
    repeatedSeedAgents: [...observationsBySeedAgent.values()].filter((entry) => entry.ticks.length > 1).length,
    maximumCheckpointsPerSeedAgent: observationsBySeedAgent.size > 0
      ? Math.max(...[...observationsBySeedAgent.values()].map((entry) => entry.ticks.length))
      : 0,
    persistentAgents: freezeArray([...observationsBySeedAgent.values()]
      .filter((entry) => entry.ticks.length > 1)
      .sort((first, second) => first.seed - second.seed || first.agentId - second.agentId)
      .map((entry) => Object.freeze({
        seed: entry.seed,
        agentId: entry.agentId,
        ticks: freezeArray(entry.ticks),
        categories: freezeArray(entry.categories),
      }))),
    localBlockers: localBlockerSummary(localBlockers),
    categoryCounts: Object.freeze(categoryCounts),
    signalCounts: Object.freeze(signalCounts),
  });
}

/** Run one engine per seed and inspect rolling windows at several checkpoints. */
export function runDeadlockAtlas({
  scenarioId = "territory-growth",
  seeds = DEFAULT_EVALUATION_SEEDS,
  checkpoints = DEFAULT_DEADLOCK_CHECKPOINTS,
  windowTicks = 200,
  distanceThreshold = 25,
  crowdingDistance = 20,
  trajectoryStride = 4,
  localBlockerDistance = 90,
  population = 72,
  width = 1_000,
  height = 650,
  parameterOverrides = {},
} = {}) {
  const scenario = getScenario(scenarioId);
  if (scenario.id !== scenarioId) throw new RangeError(`Unknown scenario: ${scenarioId}`);
  const normalizedSeedValues = normalizedSeeds(seeds);
  const normalizedCheckpointValues = normalizedCheckpoints(checkpoints);
  const window = positiveInteger(windowTicks, 200);
  const behavior = compileBehavior(scenario.source);
  const checkpointSet = new Set(normalizedCheckpointValues);
  const horizon = normalizedCheckpointValues.at(-1);
  const runs = normalizedSeedValues.map((seed) => {
    const engine = new SimulationEngine({
      behavior,
      ruleKey: scenario.source,
      seed,
      population,
      width,
      height,
      params: { ...scenario.params, ...parameterOverrides },
      relationMode: scenario.relationMode,
      environment: scenario.environment,
    });
    const ring = [captureDeadlockObservation(engine)];
    const analyzed = [];
    for (let tick = 1; tick <= horizon; tick += 1) {
      const result = engine.step(1);
      if (!result.ok) throw result.error ?? new Error(`Simulation failed at tick ${engine.tick}.`);
      ring.push(captureDeadlockObservation(engine));
      while (ring.length > window + 1) ring.shift();
      if (!checkpointSet.has(tick)) continue;
      analyzed.push(analyzeDeadlockCheckpoint(ring, engine.frame(), {
        scenarioId,
        distanceThreshold,
        crowdingDistance,
        trajectoryStride,
        localBlockerDistance,
        easementPressureThreshold: scenario.environment?.circulation?.easementPressureThreshold ?? 14,
      }));
    }
    return Object.freeze({ seed, checkpoints: freezeArray(analyzed) });
  });
  const frozenRuns = freezeArray(runs);
  return Object.freeze({
    configuration: Object.freeze({
      scenarioId,
      seeds: normalizedSeedValues,
      checkpoints: normalizedCheckpointValues,
      windowTicks: window,
      distanceThreshold: Math.max(0, finiteNumber(distanceThreshold, 25)),
      crowdingDistance: Math.max(0, finiteNumber(crowdingDistance, 20)),
      trajectoryStride: positiveInteger(trajectoryStride, 4),
      localBlockerDistance: Math.max(0, finiteNumber(localBlockerDistance, 90)),
      population: Math.max(3, nonNegativeInteger(population, 72)),
      width: Math.max(100, finiteNumber(width, 1_000)),
      height: Math.max(100, finiteNumber(height, 650)),
      parameterOverrides: Object.freeze({ ...parameterOverrides }),
    }),
    runs: frozenRuns,
    aggregate: aggregateAtlas(frozenRuns),
  });
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function svgNumber(value) {
  return formatNumber(value, 2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function selectedCheckpoint(atlas, seed, checkpoint) {
  const selectedRun = seed === undefined
    ? atlas?.runs?.[0]
    : atlas?.runs?.find((run) => run.seed === Number(seed));
  if (!selectedRun) throw new RangeError(`Atlas has no run for seed ${seed}.`);
  const selected = checkpoint === undefined
    ? selectedRun.checkpoints?.[0]
    : selectedRun.checkpoints?.find((entry) => entry.tick === Number(checkpoint));
  if (!selected) throw new RangeError(`Atlas has no checkpoint ${checkpoint} for seed ${selectedRun.seed}.`);
  return selected;
}

/** Render one atlas checkpoint as a standalone, dependency-free SVG. */
export function renderDeadlockAtlasSvg(atlas, { seed, checkpoint } = {}) {
  const selected = selectedCheckpoint(atlas, seed, checkpoint);
  const width = selected.map.width;
  const height = selected.map.height;
  const panelWidth = 250;
  const trajectoryLines = selected.diagnostics.map((diagnostic) => {
    const color = DEADLOCK_CATEGORY_COLORS[diagnostic.category] ?? DEADLOCK_CATEGORY_COLORS.unclassified;
    const points = diagnostic.trajectory.map((point) => `${svgNumber(point.x)},${svgNumber(point.y)}`).join(" ");
    const start = diagnostic.trajectory[0];
    const end = diagnostic.trajectory.at(-1);
    const target = diagnostic.context.target;
    return [
      target ? `<line x1="${svgNumber(end.x)}" y1="${svgNumber(end.y)}" x2="${svgNumber(target.x)}" y2="${svgNumber(target.y)}" stroke="${color}" stroke-width="1" stroke-dasharray="4 5" opacity="0.5"/>` : "",
      target ? `<rect x="${svgNumber(target.x - 3)}" y="${svgNumber(target.y - 3)}" width="6" height="6" transform="rotate(45 ${svgNumber(target.x)} ${svgNumber(target.y)})" fill="none" stroke="${color}" stroke-width="1.5"/>` : "",
      `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`,
      `<circle cx="${svgNumber(start.x)}" cy="${svgNumber(start.y)}" r="3" fill="#fff" stroke="${color}" stroke-width="2"/>`,
      `<circle cx="${svgNumber(end.x)}" cy="${svgNumber(end.y)}" r="5" fill="${color}" stroke="#fff" stroke-width="1.5"/>`,
      `<text x="${svgNumber(end.x + 7)}" y="${svgNumber(end.y - 7)}" fill="${color}" font-size="11" font-weight="700">${escapeXml(diagnostic.agentId)}</text>`,
    ].join("");
  }).join("");
  const usedCategories = DEADLOCK_CATEGORIES
    .filter((category) => selected.categoryCounts[category] > 0);
  const legend = usedCategories.map((category, index) => {
    const y = 104 + index * 24;
    return `<circle cx="${width + 24}" cy="${y - 4}" r="5" fill="${DEADLOCK_CATEGORY_COLORS[category]}"/><text x="${width + 36}" y="${y}" font-size="12" fill="#344054">${escapeXml(category)} · ${selected.categoryCounts[category]}</text>`;
  }).join("");
  const claimed = selected.map.claimedCells.map((cell) => {
    const hue = ((finiteNumber(cell.ownerId) * 47) % 360 + 360) % 360;
    return `<rect x="${svgNumber(cell.x)}" y="${svgNumber(cell.y)}" width="${svgNumber(cell.width)}" height="${svgNumber(cell.height)}" fill="hsl(${hue} 18% 77%)" stroke="#98a2b3" stroke-width="0.55"/>`;
  }).join("");
  const reserved = selected.map.reservedCells.map((cell) => (
    `<rect x="${svgNumber(cell.x)}" y="${svgNumber(cell.y)}" width="${svgNumber(cell.width)}" height="${svgNumber(cell.height)}" fill="#fef0c7" fill-opacity="0.45" stroke="#f79009" stroke-width="0.8" stroke-dasharray="3 3"/>`
  )).join("");
  const flowEdges = selected.map.edges.filter((edge) => edge.flow && !edge.easement).map((edge) => {
    const road = edge.status === "road";
    return `<line x1="${svgNumber(edge.x1)}" y1="${svgNumber(edge.y1)}" x2="${svgNumber(edge.x2)}" y2="${svgNumber(edge.y2)}" stroke="${road ? "#475467" : "#98a2b3"}" stroke-width="${svgNumber(road ? Math.max(1.4, edge.width) : 1)}" stroke-linecap="round" opacity="${road ? "0.72" : "0.42"}"${road ? "" : ' stroke-dasharray="2 3"'}/>`;
  }).join("");
  const easements = selected.map.edges.filter((edge) => edge.easement).map((edge) => (
    `<line x1="${svgNumber(edge.x1)}" y1="${svgNumber(edge.y1)}" x2="${svgNumber(edge.x2)}" y2="${svgNumber(edge.y2)}" stroke="${edge.acquired ? "#087e8b" : "#0e9384"}" stroke-width="${svgNumber(Math.max(2, edge.width * 0.35))}" stroke-linecap="round" opacity="0.85"${edge.acquired ? "" : ' stroke-dasharray="6 4"'}/>`
  )).join("");
  const activities = selected.map.activities.map((activity) => (
    `<circle cx="${svgNumber(activity.x)}" cy="${svgNumber(activity.y)}" r="4" fill="#fff" stroke="#c11574" stroke-width="2"/>`
  )).join("");
  const subtitle = `${selected.diagnostics.length} endpoint-stuck walker${selected.diagnostics.length === 1 ? "" : "s"} · window ${selected.window.startTick}–${selected.window.endTick}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgNumber(width + panelWidth)} ${svgNumber(height)}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(selected.scenarioId)} deadlock atlas, seed ${selected.seed}, tick ${selected.tick}</title>
  <desc id="description">${escapeXml(subtitle)}. Lines show recent trajectories and dashed rays show current targets. Categories are heuristic signals.</desc>
  <rect width="${svgNumber(width + panelWidth)}" height="${svgNumber(height)}" fill="#f8fafc"/>
  <g id="map">
    <rect width="${svgNumber(width)}" height="${svgNumber(height)}" fill="#f2f4f7" stroke="#667085" stroke-width="1"/>
    <g id="claimed-land">${claimed}</g>
    <g id="reserved-land">${reserved}</g>
    <g id="flow-network">${flowEdges}</g>
    <g id="easements">${easements}</g>
    <g id="activities">${activities}</g>
    <g id="deadlock-trajectories">${trajectoryLines}</g>
  </g>
  <g id="legend" font-family="ui-sans-serif, system-ui, sans-serif">
    <text x="${svgNumber(width + 18)}" y="34" font-size="18" font-weight="700" fill="#101828">Late-deadlock atlas</text>
    <text x="${svgNumber(width + 18)}" y="57" font-size="12" fill="#475467">seed ${selected.seed} · tick ${selected.tick}</text>
    <text x="${svgNumber(width + 18)}" y="76" font-size="11" fill="#667085">${escapeXml(subtitle)}</text>
    ${legend || `<text x="${svgNumber(width + 18)}" y="106" font-size="12" fill="#667085">No stuck journeys in this window.</text>`}
    <text x="${svgNumber(width + 18)}" y="${svgNumber(height - 42)}" font-size="10" fill="#667085">Classification is diagnostic, not causal proof.</text>
    <text x="${svgNumber(width + 18)}" y="${svgNumber(height - 25)}" font-size="10" fill="#667085">Circle: final position · diamond: target</text>
  </g>
</svg>`;
}
