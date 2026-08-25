#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEADLOCK_CATEGORIES,
  DEFAULT_DEADLOCK_CHECKPOINTS,
  renderDeadlockAtlasSvg,
  runDeadlockAtlas,
} from "../src/simulation/deadlock-atlas.js";
import { DEFAULT_EVALUATION_SEEDS } from "../src/simulation/scenario-evaluation.js";

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
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return number;
}

function nonNegativeNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${name} must be a non-negative number.`);
  }
  return number;
}

function integerList(value, name, { positive = false } = {}) {
  const numbers = String(value).split(",").map((entry) => Number(entry.trim()));
  if (numbers.length === 0 || numbers.some((number) => (
    !Number.isSafeInteger(number) || (positive ? number <= 0 : number < 0)
  ))) {
    throw new TypeError(`${name} must be a comma-separated list of ${positive ? "positive" : "non-negative"} integers.`);
  }
  return numbers;
}

function decimal(value, digits = 1) {
  return Number(value).toFixed(digits);
}

function categorySummary(counts) {
  const entries = DEADLOCK_CATEGORIES
    .filter((category) => counts[category] > 0)
    .map((category) => `${category} ${counts[category]}`);
  return entries.length > 0 ? entries.join(", ") : "—";
}

function printTable(atlas, { details = false } = {}) {
  const columns = [
    ["Seed", (checkpoint) => checkpoint.seed],
    ["Tick", (checkpoint) => checkpoint.tick],
    ["Stuck", (checkpoint) => checkpoint.mobility.stuckAgents],
    ["Trips/window", (checkpoint) => checkpoint.mobility.completedTrips],
    ["Primary classifications", (checkpoint) => categorySummary(checkpoint.categoryCounts)],
    ["Checksum", (checkpoint) => checkpoint.checksum ?? "—"],
  ];
  const checkpoints = atlas.runs.flatMap((run) => run.checkpoints);
  const rows = checkpoints.map((checkpoint) => columns.map(([, select]) => String(select(checkpoint))));
  const widths = columns.map(([label], index) => Math.max(label.length, ...rows.map((row) => row[index].length)));
  console.log(columns.map(([label], index) => label.padEnd(widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(row.map((value, index) => value.padEnd(widths[index])).join("  "));
  }

  console.log("");
  console.log(
    `${atlas.aggregate.stuckObservations} stuck observations across `
    + `${atlas.aggregate.checkpointObservations} checkpoints; `
    + `${atlas.aggregate.uniqueSeedAgents} distinct seed/agent pairs, `
    + `${atlas.aggregate.repeatedSeedAgents} seen at multiple checkpoints.`,
  );
  console.log(`Primary classifications: ${categorySummary(atlas.aggregate.categoryCounts)}`);
  const blockers = atlas.aggregate.localBlockers;
  console.log(
    `Nearest local blockers: ${blockers.episodes} episodes · ${blockers.withoutEasement} without easement · `
    + `${blockers.misalignedEasement} with a misaligned easement · `
    + `${blockers.nearOpeningPressure} unopened but near threshold · `
    + `mean unopened pressure ${decimal(blockers.meanPressureWithoutEasement * 100, 0)}%.`,
  );
  if (atlas.aggregate.persistentAgents.length > 0) {
    console.log(`Repeated seed/agent pairs: ${atlas.aggregate.persistentAgents
      .map((entry) => `${entry.seed}/${entry.agentId} @ ${entry.ticks.join(",")}`)
      .join(" · ")}`);
  }

  if (!details) return;
  for (const checkpoint of checkpoints) {
    if (checkpoint.diagnostics.length === 0) continue;
    console.log("");
    console.log(`Seed ${checkpoint.seed}, tick ${checkpoint.tick}`);
    for (const diagnostic of checkpoint.diagnostics) {
      const { metrics, context } = diagnostic;
      const target = context.target
        ? `${context.target.id} @ ${decimal(context.targetDistance)}u`
        : "no target";
      const blocker = metrics.dominantBlockedLandId
        ? ` · blocked ${metrics.dominantBlockedLandId} (${metrics.blockedSamples})`
        : "";
      const localBlocker = context.localDirectBlockers[0];
      const local = localBlocker
        ? ` · local ${localBlocker.landId} ${decimal(localBlocker.distance)}u/${decimal(localBlocker.pressureRatio * 100, 0)}% pressure${localBlocker.hasEasement ? "/misaligned easement" : ""}`
        : "";
      console.log(
        `  agent ${diagnostic.agentId}: ${diagnostic.category} [${diagnostic.confidence}] · `
        + `net ${decimal(metrics.displacement)}u / path ${decimal(metrics.pathLength)}u · `
        + `${target}${blocker}${local}`,
      );
      console.log(`    signals: ${diagnostic.signals.join(", ")}`);
      if (metrics.privateEntryMode) {
        console.log(`    private entry: ${metrics.privateEntryMode} at tick ${metrics.firstInsidePrivateTick}`);
        if (metrics.privateEntryEvents.length > 0) {
          console.log(`    same-tick events: ${metrics.privateEntryEvents
            .map((event) => `${event.layer}:${event.type}${event.reason ? `(${event.reason})` : ""}`)
            .join(", ")}`);
        }
      }
    }
  }
}

function safeFilePart(value) {
  return String(value).replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
}

async function writeSvgs(atlas, directory) {
  const output = resolve(directory);
  await mkdir(output, { recursive: true });
  const written = [];
  for (const run of atlas.runs) {
    for (const checkpoint of run.checkpoints) {
      const filename = `${safeFilePart(atlas.configuration.scenarioId)}-seed-${run.seed}-tick-${checkpoint.tick}.svg`;
      const path = resolve(output, filename);
      await writeFile(path, renderDeadlockAtlasSvg(atlas, {
        seed: run.seed,
        checkpoint: checkpoint.tick,
      }), "utf8");
      written.push(path);
    }
  }
  return written;
}

function printHelp() {
  console.log(`Usage: npm run diagnose:territory -- [options]

Options:
  --seeds <list>         Comma-separated seeds (default: ${DEFAULT_EVALUATION_SEEDS.join(",")})
  --checkpoints <list>   Comma-separated ticks (default: ${DEFAULT_DEADLOCK_CHECKPOINTS.join(",")})
  --window <count>       Rolling mobility window (default: 200)
  --distance <units>     Maximum endpoint displacement counted as stuck (default: 25)
  --crowding <units>     Nearest-neighbor distance counted as crowded (default: 20)
  --population <count>   Agent population (default: 72)
  --stride <count>       Tick spacing in rendered trajectories (default: 4)
  --scenario <id>        Scenario ID (default: territory-growth)
  --svg-dir <path>       Write one standalone SVG per seed/checkpoint
  --details              Print one evidence row per stuck journey
  --json                 Print machine-readable JSON
  --help                 Show this help

Classifications are heuristic diagnostic signals, not causal proof.`);
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  printHelp();
  process.exit(0);
}

try {
  const atlas = runDeadlockAtlas({
    scenarioId: optionValue(args, "--scenario", "territory-growth"),
    seeds: integerList(optionValue(args, "--seeds", DEFAULT_EVALUATION_SEEDS.join(",")), "--seeds"),
    checkpoints: integerList(
      optionValue(args, "--checkpoints", DEFAULT_DEADLOCK_CHECKPOINTS.join(",")),
      "--checkpoints",
      { positive: true },
    ),
    windowTicks: positiveInteger(optionValue(args, "--window", 200), "--window"),
    distanceThreshold: nonNegativeNumber(optionValue(args, "--distance", 25), "--distance"),
    crowdingDistance: nonNegativeNumber(optionValue(args, "--crowding", 20), "--crowding"),
    population: positiveInteger(optionValue(args, "--population", 72), "--population"),
    trajectoryStride: positiveInteger(optionValue(args, "--stride", 4), "--stride"),
  });
  const svgDirectory = optionValue(args, "--svg-dir", null);
  const written = svgDirectory ? await writeSvgs(atlas, svgDirectory) : [];
  if (args.includes("--json")) console.log(JSON.stringify(atlas, null, 2));
  else {
    printTable(atlas, { details: args.includes("--details") });
    if (written.length > 0) {
      console.log("");
      console.log(`Wrote ${written.length} SVG atlas file${written.length === 1 ? "" : "s"} to ${resolve(svgDirectory)}`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
