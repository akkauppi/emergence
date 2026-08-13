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
  const scenario = getScenario("between");
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
      tempo: 1,
    },
  });

  assert.ok(messages.length > 0);
  assert.ok(messages.every((message) => message.worldRevision === 1));

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
