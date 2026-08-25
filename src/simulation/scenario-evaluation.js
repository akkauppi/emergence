import { getScenario } from "../scenarios.js";
import { compileBehavior } from "./compiler.js";
import { SimulationEngine } from "./engine.js";

export const DEFAULT_EVALUATION_SEEDS = Object.freeze([104, 613, 991, 2026]);

const EPSILON = 1e-9;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  return Math.max(0, Math.round(finiteNumber(value, fallback)));
}

function mean(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function numericSummary(values) {
  const observed = values.filter(Number.isFinite);
  return Object.freeze({
    minimum: observed.length > 0 ? Math.min(...observed) : 0,
    mean: mean(observed),
    maximum: observed.length > 0 ? Math.max(...observed) : 0,
  });
}

function entropy(weights) {
  const total = weights.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= EPSILON) return 0;
  return weights.reduce((sum, value) => {
    const probability = Math.max(0, value) / total;
    return probability > EPSILON ? sum - probability * Math.log(probability) : sum;
  }, 0);
}

function establishedFlowEdges(frame) {
  return (Array.isArray(frame?.circulation?.edges) ? frame.circulation.edges : [])
    .filter((edge) => edge?.flow === true && String(edge.status) === "road");
}

function activeFlowEdges(frame) {
  return (Array.isArray(frame?.circulation?.edges) ? frame.circulation.edges : [])
    .filter((edge) => edge?.flow === true);
}

function undirectedAngle(edge) {
  let angle = Math.atan2(
    finiteNumber(edge?.y2) - finiteNumber(edge?.y1),
    finiteNumber(edge?.x2) - finiteNumber(edge?.x1),
  );
  if (angle < 0) angle += Math.PI;
  if (angle >= Math.PI) angle -= Math.PI;
  return angle;
}

function inferredFlowResolution(edges) {
  const lengths = edges
    .map((edge) => Math.hypot(
      finiteNumber(edge?.x2) - finiteNumber(edge?.x1),
      finiteNumber(edge?.y2) - finiteNumber(edge?.y1),
    ))
    .filter((length) => length > EPSILON)
    .sort((first, second) => first - second);
  if (lengths.length === 0) return 16;
  return Math.max(4, lengths[Math.floor(lengths.length / 2)] / 1.8);
}

function flowSpatialDiversity(edges, directionBins) {
  const resolution = inferredFlowResolution(edges);
  const cells = new Map();
  for (const edge of edges) {
    const encoded = /^flow-edge:(-?\d+):(-?\d+):\d+$/.exec(String(edge.id));
    const column = encoded
      ? Number(encoded[1])
      : Math.floor((finiteNumber(edge.x1) + finiteNumber(edge.x2)) / 2 / resolution);
    const row = encoded
      ? Number(encoded[2])
      : Math.floor((finiteNumber(edge.y1) + finiteNumber(edge.y2)) / 2 / resolution);
    const key = `${column}:${row}`;
    if (!cells.has(key)) cells.set(key, new Set());
    const direction = Math.min(
      directionBins - 1,
      Math.floor(undirectedAngle(edge) / Math.PI * directionBins),
    );
    cells.get(key).add(direction);
  }
  return Object.freeze({
    occupiedFlowCells: cells.size,
    multiDirectionCells: [...cells.values()].filter((directions) => directions.size > 1).length,
  });
}

/** Measure agents that neither arrived nor escaped a bounded area during a fixed window. */
export function evaluateMobilityWindow(startFrame, endFrame, {
  distanceThreshold = 25,
} = {}) {
  const threshold = Math.max(0, finiteNumber(distanceThreshold, 25));
  const startById = new Map((Array.isArray(startFrame?.agents) ? startFrame.agents : [])
    .map((agent) => [String(agent.id), agent]));
  const observations = (Array.isArray(endFrame?.agents) ? endFrame.agents : []).flatMap((agent) => {
    const start = startById.get(String(agent.id));
    if (!start) return [];
    const displacement = Math.hypot(
      finiteNumber(agent.x) - finiteNumber(start.x),
      finiteNumber(agent.y) - finiteNumber(start.y),
    );
    const arrivals = Math.max(
      0,
      nonNegativeInteger(agent.arrivalCount, 0) - nonNegativeInteger(start.arrivalCount, 0),
    );
    return [{ id: agent.id, displacement, arrivals }];
  });
  const stuck = observations.filter((agent) => (
    agent.arrivals === 0 && agent.displacement < threshold
  ));
  const completedTrips = observations.reduce((sum, agent) => sum + agent.arrivals, 0);
  return Object.freeze({
    windowTicks: Math.max(0, nonNegativeInteger(endFrame?.tick, 0)
      - nonNegativeInteger(startFrame?.tick, 0)),
    distanceThreshold: threshold,
    observedAgents: observations.length,
    stuckAgents: stuck.length,
    stuckShare: observations.length > 0 ? stuck.length / observations.length : 0,
    stuckAgentIds: Object.freeze(stuck.map((agent) => agent.id)),
    completedTrips,
    meanDisplacement: mean(observations.map((agent) => agent.displacement)),
  });
}

/** Measure how broadly sustained movement is distributed over the off-grid street graph. */
export function evaluateRouteDiversity(frame, { directionBins = 12 } = {}) {
  const binCount = Math.max(4, nonNegativeInteger(directionBins, 12));
  const established = establishedFlowEdges(frame);
  const active = activeFlowEdges(frame);
  const uses = established.map((edge) => Math.max(0, finiteNumber(edge.use)));
  const useEntropy = entropy(uses);
  const effectiveEstablishedEdges = uses.length > 0 ? Math.exp(useEntropy) : 0;
  const directionWeights = new Array(binCount).fill(0);
  for (const edge of established) {
    const index = Math.min(binCount - 1, Math.floor(undirectedAngle(edge) / Math.PI * binCount));
    directionWeights[index] += Math.max(EPSILON, finiteNumber(edge.use, 0));
  }
  const directionEntropy = entropy(directionWeights);
  const spatial = flowSpatialDiversity(established, binCount);
  return Object.freeze({
    activeFlowEdges: active.length,
    establishedFlowEdges: established.length,
    effectiveEstablishedEdges,
    routeDiversity: established.length > 1
      ? effectiveEstablishedEdges / established.length
      : established.length,
    directionDiversity: binCount > 1 ? directionEntropy / Math.log(binCount) : 0,
    directionBinsUsed: directionWeights.filter((weight) => weight > EPSILON).length,
    occupiedFlowCells: spatial.occupiedFlowCells,
    multiDirectionCells: spatial.multiDirectionCells,
  });
}

export function evaluateScenarioFrames(startFrame, endFrame, options = {}) {
  const metrics = endFrame?.metrics ?? {};
  return Object.freeze({
    scenarioId: String(options.scenarioId ?? "territory-growth"),
    seed: nonNegativeInteger(endFrame?.seed, options.seed ?? 0),
    tick: nonNegativeInteger(endFrame?.tick, 0),
    population: Array.isArray(endFrame?.agents) ? endFrame.agents.length : 0,
    checksum: endFrame?.checksum ?? null,
    mobility: evaluateMobilityWindow(startFrame, endFrame, options),
    routes: evaluateRouteDiversity(endFrame, options),
    outcomes: Object.freeze({
      trips: nonNegativeInteger(metrics.trips, 0),
      trailConcentration: finiteNumber(metrics.trailConcentration, 0),
      claimedShare: finiteNumber(metrics.claimedShare, 0),
      roadShare: finiteNumber(metrics.roadShare, 0),
      easements: nonNegativeInteger(metrics.easementCount, 0),
      acquiredRightOfWays: nonNegativeInteger(metrics.acquiredRightOfWays, 0),
      activities: nonNegativeInteger(metrics.activeActivities, 0),
      localTrips: nonNegativeInteger(metrics.activityTrips, 0),
      meanFlowCapacity: finiteNumber(metrics.meanFlowCapacity, 0),
      maxFlowCapacity: finiteNumber(metrics.maxFlowCapacity, 0),
      meanFlowCondition: finiteNumber(metrics.meanFlowCondition, 0),
      meanFlowCongestion: finiteNumber(metrics.meanFlowCongestion, 0),
      overloadedFlowShare: finiteNumber(metrics.overloadedFlowShare, 0),
    }),
  });
}

export function aggregateScenarioEvaluations(runs) {
  const values = Array.isArray(runs) ? runs : [];
  const summarize = (select) => numericSummary(values.map(select));
  return Object.freeze({
    runs: values.length,
    seeds: Object.freeze(values.map((run) => run.seed)),
    mobility: Object.freeze({
      stuckAgents: summarize((run) => run.mobility.stuckAgents),
      stuckShare: summarize((run) => run.mobility.stuckShare),
      windowTrips: summarize((run) => run.mobility.completedTrips),
    }),
    routes: Object.freeze({
      routeDiversity: summarize((run) => run.routes.routeDiversity),
      directionDiversity: summarize((run) => run.routes.directionDiversity),
      establishedFlowEdges: summarize((run) => run.routes.establishedFlowEdges),
      multiDirectionCells: summarize((run) => run.routes.multiDirectionCells),
    }),
    outcomes: Object.freeze({
      trips: summarize((run) => run.outcomes.trips),
      trailConcentration: summarize((run) => run.outcomes.trailConcentration),
      claimedShare: summarize((run) => run.outcomes.claimedShare),
      easements: summarize((run) => run.outcomes.easements),
      activities: summarize((run) => run.outcomes.activities),
      meanFlowCapacity: summarize((run) => run.outcomes.meanFlowCapacity),
      meanFlowCondition: summarize((run) => run.outcomes.meanFlowCondition),
      overloadedFlowShare: summarize((run) => run.outcomes.overloadedFlowShare),
    }),
  });
}

export function runScenarioEvaluation({
  scenarioId = "territory-growth",
  seeds = DEFAULT_EVALUATION_SEEDS,
  ticks = 2_400,
  mobilityWindow = 200,
  distanceThreshold = 25,
  population = 72,
  width = 1_000,
  height = 650,
  parameterOverrides = {},
} = {}) {
  const scenario = getScenario(scenarioId);
  if (scenario.id !== scenarioId) throw new RangeError(`Unknown scenario: ${scenarioId}`);
  const horizon = Math.max(1, nonNegativeInteger(ticks, 2_400));
  const windowTicks = Math.min(horizon, Math.max(1, nonNegativeInteger(mobilityWindow, 200)));
  const behavior = compileBehavior(scenario.source);
  const runs = seeds.map((seedValue) => {
    const seed = nonNegativeInteger(seedValue, 0) >>> 0;
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
    const startTick = horizon - windowTicks;
    if (startTick > 0) {
      const result = engine.step(startTick);
      if (!result.ok) throw result.error ?? new Error(`Simulation failed at tick ${engine.tick}.`);
    }
    const startFrame = engine.frame();
    const result = engine.step(windowTicks);
    if (!result.ok) throw result.error ?? new Error(`Simulation failed at tick ${engine.tick}.`);
    return evaluateScenarioFrames(startFrame, engine.frame(), {
      scenarioId,
      seed,
      distanceThreshold,
    });
  });
  return Object.freeze({
    configuration: Object.freeze({
      scenarioId,
      seeds: Object.freeze(runs.map((run) => run.seed)),
      ticks: horizon,
      mobilityWindow: windowTicks,
      distanceThreshold: Math.max(0, finiteNumber(distanceThreshold, 25)),
      population: Math.max(3, nonNegativeInteger(population, 72)),
      width: Math.max(100, finiteNumber(width, 1_000)),
      height: Math.max(100, finiteNumber(height, 650)),
      parameterOverrides: Object.freeze({ ...parameterOverrides }),
    }),
    runs: Object.freeze(runs),
    aggregate: aggregateScenarioEvaluations(runs),
  });
}
