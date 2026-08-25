#!/usr/bin/env node

import {
  DEFAULT_EVALUATION_SEEDS,
  runScenarioEvaluation,
} from "../src/simulation/scenario-evaluation.js";

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
    throw new TypeError(`${name} requires a value.`);
  }
  return args[index + 1];
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return number;
}

function seedsFrom(value) {
  const seeds = String(value).split(",").map((seed) => Number(seed.trim()));
  if (seeds.length === 0 || seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0)) {
    throw new TypeError("--seeds must be a comma-separated list of non-negative integers.");
  }
  return seeds;
}

function decimal(value, digits = 3) {
  return Number(value).toFixed(digits);
}

function percent(value) {
  return `${decimal(Number(value) * 100, 1)}%`;
}

function printTable(evaluation) {
  const columns = [
    ["Seed", (run) => run.seed],
    ["Trips", (run) => run.outcomes.trips],
    ["Stuck", (run) => run.mobility.stuckAgents],
    ["Route div.", (run) => decimal(run.routes.routeDiversity)],
    ["Dir. div.", (run) => decimal(run.routes.directionDiversity)],
    ["Streets", (run) => run.routes.establishedFlowEdges],
    ["Multi-dir.", (run) => run.routes.multiDirectionCells],
    ...(evaluation.runs.some((run) => run.outcomes.meanFlowCapacity > 0) ? [
      ["Capacity", (run) => decimal(run.outcomes.meanFlowCapacity, 2)],
      ["Overload", (run) => percent(run.outcomes.overloadedFlowShare)],
    ] : []),
    ["Easements", (run) => run.outcomes.easements],
    ["Activities", (run) => run.outcomes.activities],
    ["Checksum", (run) => run.checksum ?? "—"],
  ];
  const rows = evaluation.runs.map((run) => columns.map(([, select]) => String(select(run))));
  const widths = columns.map(([label], index) => Math.max(label.length, ...rows.map((row) => row[index].length)));
  console.log(columns.map(([label], index) => label.padEnd(widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(row.map((value, index) => value.padEnd(widths[index])).join("  "));
  }

  const { aggregate } = evaluation;
  console.log("");
  console.log(
    `Mean: ${decimal(aggregate.outcomes.trips.mean, 1)} trips · `
    + `${decimal(aggregate.mobility.stuckAgents.mean, 2)} stuck `
    + `(${percent(aggregate.mobility.stuckShare.mean)}) · `
    + `${decimal(aggregate.routes.routeDiversity.mean)} route diversity · `
    + `${decimal(aggregate.routes.establishedFlowEdges.mean, 1)} established flow edges`,
  );
}

function printHelp() {
  console.log(`Usage: npm run evaluate:territory -- [options]

Options:
  --seeds <list>       Comma-separated seeds (default: ${DEFAULT_EVALUATION_SEEDS.join(",")})
  --ticks <count>      Evaluation horizon (default: 2400)
  --window <count>     Late mobility window (default: 200)
  --distance <units>   Maximum displacement counted as stuck (default: 25)
  --population <count> Agent population (default: 72)
  --scenario <id>      Scenario ID (default: territory-growth)
  --json               Print machine-readable JSON
  --help               Show this help`);
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  printHelp();
  process.exit(0);
}

try {
  const distance = Number(optionValue(args, "--distance", 25));
  if (!Number.isFinite(distance) || distance < 0) throw new TypeError("--distance must be a non-negative number.");
  const evaluation = runScenarioEvaluation({
    scenarioId: optionValue(args, "--scenario", "territory-growth"),
    seeds: seedsFrom(optionValue(args, "--seeds", DEFAULT_EVALUATION_SEEDS.join(","))),
    ticks: positiveInteger(optionValue(args, "--ticks", 2_400), "--ticks"),
    mobilityWindow: positiveInteger(optionValue(args, "--window", 200), "--window"),
    distanceThreshold: distance,
    population: positiveInteger(optionValue(args, "--population", 72), "--population"),
  });
  if (args.includes("--json")) console.log(JSON.stringify(evaluation, null, 2));
  else printTable(evaluation);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
