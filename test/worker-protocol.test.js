import assert from "node:assert/strict";
import test from "node:test";

import { copyParameters, getScenario } from "../src/scenarios.js";

const messages = [];
let receiveMessage = null;
const nativeSetInterval = globalThis.setInterval;

globalThis.self = {
  postMessage(message) {
    messages.push(message);
  },
  addEventListener(type, handler) {
    if (type === "message") receiveMessage = handler;
  },
};
globalThis.setInterval = () => 0;
await import("../src/simulation/engine.worker.js");
globalThis.setInterval = nativeSetInterval;

const send = (data) => receiveMessage({ data });

test("worker revisions reject stale controls and make perturbation frames atomic", () => {
  const scenario = getScenario("desire-paths");
  send({
    type: "initialize",
    worldRevision: 1,
    config: {
      source: scenario.source,
      seed: 2026,
      population: 12,
      width: 1_000,
      height: 650,
      params: copyParameters(scenario),
      relationMode: scenario.relationMode,
      environment: scenario.environment,
      tempo: 1,
    },
  });

  assert.ok(messages.length > 0);
  assert.ok(messages.every((message) => message.worldRevision === 1));
  const initialFrame = messages.find((message) => message.type === "frame").frame;
  assert.equal(initialFrame.environment.destinations.length, 2);
  assert.equal(initialFrame.environment.obstacles[0].id, "central-block");
  assert.equal(initialFrame.agents[0].destinationId === "west" || initialFrame.agents[0].destinationId === "east", true);

  const beforePerturbation = messages.length;
  send({
    type: "perturbAgent",
    worldRevision: 2,
    agentId: 0,
    position: { x: 400, y: 300 },
    sequence: 1,
  });
  const perturbationMessages = messages.slice(beforePerturbation);

  assert.deepEqual(perturbationMessages.map((message) => message.type), ["status", "interventionResult"]);
  assert.equal(perturbationMessages[1].worldRevision, 2);
  assert.equal(perturbationMessages[1].frame.eventCursor, 1);
  assert.equal(perturbationMessages[1].frame.lastIntervention.sequence, 1);

  const beforeStalePlay = messages.length;
  send({ type: "play", worldRevision: 1 });
  assert.equal(messages.length, beforeStalePlay);

  send({ type: "play", worldRevision: 2 });
  assert.deepEqual(messages.at(-1), { type: "status", worldRevision: 2, running: true });
});

test("failed source changes retag the unchanged frame for the new world", () => {
  const beforeApply = messages.length;
  send({
    type: "applySource",
    worldRevision: 3,
    source: "function notBehave() {}",
  });
  const applyMessages = messages.slice(beforeApply);

  assert.deepEqual(applyMessages.map((message) => message.type), ["status", "status", "compileResult", "frame"]);
  assert.ok(applyMessages.every((message) => message.worldRevision === 3));
  assert.equal(applyMessages[2].ok, false);
  assert.equal(applyMessages[3].frame.eventCursor, 1);
});

test("journey behavior receives its environment after worker reset", () => {
  const beforeReset = messages.length;
  send({ type: "reset", worldRevision: 4, seed: 2026 });
  const resetMessages = messages.slice(beforeReset);
  assert.equal(resetMessages.at(-1).type, "frame");
  assert.equal(resetMessages.at(-1).frame.environment.field.cellSize, 14);

  const beforeStep = messages.length;
  send({ type: "step", worldRevision: 4, count: 2 });
  const stepMessages = messages.slice(beforeStep);
  assert.equal(stepMessages.some((message) => message.type === "runtimeError"), false);
  assert.equal(stepMessages.at(-1).frame.tick, 2);
  assert.equal(Number.isFinite(stepMessages.at(-1).frame.metrics.trailConcentration), true);
});

test("territory worlds mature claims, reset cleanly, and replay under worker revisions", () => {
  const scenario = getScenario("territory-growth");
  const beforeInitialize = messages.length;
  send({
    type: "initialize",
    worldRevision: 5,
    config: {
      source: scenario.source,
      seed: 2026,
      population: 12,
      width: 1_000,
      height: 650,
      params: copyParameters(scenario),
      relationMode: scenario.relationMode,
      environment: scenario.environment,
      tempo: 1,
    },
  });
  const initializeMessages = messages.slice(beforeInitialize);

  assert.deepEqual(
    initializeMessages.map((message) => message.type),
    ["status", "compileResult", "frame", "ready"],
  );
  assert.ok(initializeMessages.every((message) => message.worldRevision === 5));
  const initialFrame = initializeMessages.find((message) => message.type === "frame").frame;
  assert.equal(initialFrame.tick, 0);
  assert.equal(initialFrame.land.enabled, true);
  assert.deepEqual(
    {
      x: initialFrame.land.geometry.x,
      y: initialFrame.land.geometry.y,
      columns: initialFrame.land.geometry.columns,
      rows: initialFrame.land.geometry.rows,
      cellSize: initialFrame.land.geometry.cellSize,
      gap: initialFrame.land.geometry.gap,
    },
    { x: 140, y: 84, columns: 19, rows: 12, cellSize: 36, gap: 2 },
  );
  assert.deepEqual(initialFrame.land.policy, scenario.environment.land.policy);
  assert.equal(initialFrame.land.cells.length, 19 * 12);
  assert.ok(initialFrame.land.cells.every((cell) => cell.state === "unclaimed"));
  assert.ok(initialFrame.land.cells.every((cell) => Number.isFinite(cell.access)));
  assert.deepEqual(initialFrame.land.events, []);
  assert.equal(initialFrame.metrics.claimedCells, 0);
  assert.equal(initialFrame.metrics.landConflicts, 0);

  const beforeWaiting = messages.length;
  send({ type: "step", worldRevision: 5, count: 19 });
  const waitingMessages = messages.slice(beforeWaiting);
  assert.equal(waitingMessages.some((message) => message.type === "runtimeError"), false);
  const waitingFrame = waitingMessages.at(-1).frame;
  assert.equal(waitingFrame.tick, 19);
  assert.equal(waitingFrame.metrics.claimedCells, 0);
  assert.ok(waitingFrame.metrics.reservedCells > 0);
  assert.ok(waitingFrame.metrics.landConflicts > 0);
  assert.ok(waitingFrame.land.cells.some((cell) => cell.state === "reserved"));

  const beforeMaturity = messages.length;
  send({ type: "step", worldRevision: 5, count: 1 });
  const maturityMessages = messages.slice(beforeMaturity);
  assert.equal(maturityMessages.some((message) => message.type === "runtimeError"), false);
  const matureFrame = maturityMessages.at(-1).frame;
  assert.equal(matureFrame.tick, 20);
  assert.ok(matureFrame.metrics.claimedCells > 0);
  assert.ok(matureFrame.metrics.landClaims > 0);
  assert.ok(matureFrame.metrics.landConflicts > 0);
  assert.ok(matureFrame.land.events.some((event) => event.type === "claim"));
  assert.ok(matureFrame.land.cells.some((cell) => cell.state === "claimed"));
  assert.ok(matureFrame.land.parcels.length > 0);

  const beforeReset = messages.length;
  send({
    type: "reset",
    worldRevision: 6,
    seed: 2026,
    population: 12,
    params: copyParameters(scenario),
    environment: scenario.environment,
  });
  const resetMessages = messages.slice(beforeReset);
  assert.ok(resetMessages.every((message) => message.worldRevision === 6));
  const resetFrame = resetMessages.at(-1).frame;
  assert.equal(resetFrame.tick, 0);
  assert.equal(resetFrame.checksum, initialFrame.checksum);
  assert.equal(resetFrame.land.cells.length, initialFrame.land.cells.length);
  assert.ok(resetFrame.land.cells.every((cell) => cell.state === "unclaimed"));
  assert.deepEqual(resetFrame.land.parcels, []);
  assert.deepEqual(resetFrame.land.events, []);
  assert.equal(resetFrame.metrics.claimedCells, 0);
  assert.equal(resetFrame.metrics.reservedCells, 0);
  assert.equal(resetFrame.metrics.landClaims, 0);
  assert.equal(resetFrame.metrics.landConflicts, 0);

  const beforeStaleControls = messages.length;
  send({ type: "play", worldRevision: 5 });
  send({ type: "step", worldRevision: 5, count: 1 });
  assert.equal(messages.length, beforeStaleControls);

  const beforeReplay = messages.length;
  send({ type: "step", worldRevision: 6, count: 20 });
  const replayMessages = messages.slice(beforeReplay);
  assert.equal(replayMessages.some((message) => message.type === "runtimeError"), false);
  const replayFrame = replayMessages.at(-1).frame;
  assert.equal(replayFrame.tick, 20);
  assert.equal(replayFrame.checksum, matureFrame.checksum);
  assert.deepEqual(replayFrame.land.metrics, matureFrame.land.metrics);
  assert.deepEqual(replayFrame.land.events, matureFrame.land.events);
});
