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
