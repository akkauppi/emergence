import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateScenarioEvaluations,
  evaluateMobilityWindow,
  evaluateRouteDiversity,
  runScenarioEvaluation,
} from "../src/simulation/scenario-evaluation.js";

function agent(id, x, y, arrivalCount = 0) {
  return { id, x, y, arrivalCount };
}

function flowEdge(id, x1, y1, x2, y2, use, status = "road") {
  return { id, x1, y1, x2, y2, use, status, flow: true };
}

test("the mobility probe requires both no arrival and bounded displacement", () => {
  const start = {
    tick: 1_000,
    agents: [agent(1, 0, 0), agent(2, 0, 0), agent(3, 0, 0)],
  };
  const end = {
    tick: 1_200,
    agents: [agent(1, 10, 0), agent(2, 30, 0), agent(3, 2, 0, 1)],
  };

  assert.deepEqual(evaluateMobilityWindow(start, end), {
    windowTicks: 200,
    distanceThreshold: 25,
    observedAgents: 3,
    stuckAgents: 1,
    stuckShare: 1 / 3,
    stuckAgentIds: [1],
    completedTrips: 1,
    meanDisplacement: 14,
  });
});

test("route diversity reports use evenness independently of edge count", () => {
  const balanced = {
    circulation: {
      edges: [
        flowEdge("flow-edge:0:0:0", 0, 0, 20, 0, 10),
        flowEdge("flow-edge:1:0:0", 20, 0, 40, 0, 10),
        flowEdge("flow-edge:1:0:6", 20, 0, 20, 20, 10),
      ],
    },
  };
  const concentrated = {
    circulation: {
      edges: [
        flowEdge("flow-edge:0:0:0", 0, 0, 20, 0, 100),
        flowEdge("flow-edge:1:0:0", 20, 0, 40, 0, 1),
        flowEdge("flow-edge:1:0:6", 20, 0, 20, 20, 1),
        flowEdge("trace", 0, 20, 20, 20, 30, "trace"),
      ],
    },
  };

  const balancedMetrics = evaluateRouteDiversity(balanced);
  const concentratedMetrics = evaluateRouteDiversity(concentrated);
  assert.equal(balancedMetrics.activeFlowEdges, 3);
  assert.equal(balancedMetrics.establishedFlowEdges, 3);
  assert.equal(balancedMetrics.occupiedFlowCells, 2);
  assert.equal(balancedMetrics.multiDirectionCells, 1);
  assert.ok(Math.abs(balancedMetrics.routeDiversity - 1) < 1e-12);
  assert.equal(concentratedMetrics.activeFlowEdges, 4);
  assert.equal(concentratedMetrics.establishedFlowEdges, 3);
  assert.ok(concentratedMetrics.routeDiversity < balancedMetrics.routeDiversity);
  assert.ok(balancedMetrics.directionDiversity > 0);
});

test("multi-seed evaluation is deterministic and aggregates every run", () => {
  const options = {
    seeds: [104, 613],
    ticks: 12,
    mobilityWindow: 6,
    population: 8,
  };
  const first = runScenarioEvaluation(options);
  const replay = runScenarioEvaluation(options);

  assert.deepEqual(replay, first);
  assert.deepEqual(first.configuration.seeds, [104, 613]);
  assert.equal(first.runs.length, 2);
  assert.equal(first.aggregate.runs, 2);
  assert.ok(first.runs.every((run) => run.tick === 12 && run.population === 8));
  assert.deepEqual(aggregateScenarioEvaluations(first.runs), first.aggregate);
});
