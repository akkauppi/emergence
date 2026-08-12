import { cleanErrorMessage, compileBehavior } from "./compiler.js";
import { SimulationEngine } from "./engine.js";

let engine = null;
let behavior = null;
let running = false;
let tempo = 1;
let fractionalSteps = 0;
let configuration = null;

function emit(type, detail = {}) {
  self.postMessage({ type, ...detail });
}

function emitFrame() {
  if (engine) emit("frame", { frame: engine.frame() });
}

function setRunning(value) {
  running = Boolean(value);
  fractionalSteps = 0;
  emit("status", { running });
}

function initialize(config, revision = 0) {
  configuration = {
    ...config,
    params: { ...config.params },
  };
  behavior = compileBehavior(config.source);
  engine = new SimulationEngine({
    behavior,
    seed: config.seed,
    population: config.population,
    width: config.width,
    height: config.height,
    params: config.params,
    relationMode: config.relationMode,
  });
  setRunning(false);
  emit("compileResult", { ok: true, revision, initial: true });
  emitFrame();
  emit("ready");
}

function advance(count = 1) {
  if (!engine) return;
  const result = engine.step(count);
  if (!result.ok) {
    setRunning(false);
    emit("runtimeError", { error: result.error });
    return;
  }
  emitFrame();
}

self.addEventListener("message", (event) => {
  const message = event.data || {};

  try {
    switch (message.type) {
      case "initialize":
        initialize(message.config, message.revision);
        break;
      case "play":
        if (engine) setRunning(true);
        break;
      case "pause":
        setRunning(false);
        break;
      case "step":
        setRunning(false);
        advance(message.count || 1);
        break;
      case "reset":
        if (!engine) break;
        setRunning(false);
        engine.reset({
          seed: message.seed ?? engine.seed,
          population: message.population ?? engine.population,
          params: message.params ?? engine.params,
        });
        emitFrame();
        break;
      case "reconfigure":
        if (!engine) break;
        configuration = {
          ...configuration,
          population: message.population ?? configuration.population,
          params: { ...(message.params ?? configuration.params) },
        };
        setRunning(false);
        engine.reset({
          seed: engine.seed,
          population: configuration.population,
          params: configuration.params,
        });
        emitFrame();
        break;
      case "setTempo":
        tempo = Math.max(0.05, Math.min(8, Number(message.tempo) || 1));
        fractionalSteps = 0;
        break;
      case "applySource": {
        const nextBehavior = compileBehavior(message.source);
        behavior = nextBehavior;
        configuration = { ...configuration, source: message.source };
        engine.setBehavior(nextBehavior);
        engine.reset();
        setRunning(false);
        emit("compileResult", { ok: true, revision: message.revision, initial: false });
        emitFrame();
        break;
      }
      case "ping":
        emit("pong", { nonce: message.nonce });
        break;
      default:
        break;
    }
  } catch (error) {
    if (message.type === "applySource" || message.type === "initialize") {
      emit("compileResult", {
        ok: false,
        revision: message.revision || 0,
        initial: message.type === "initialize",
        message: cleanErrorMessage(error),
      });
      return;
    }

    setRunning(false);
    emit("runtimeError", {
      error: {
        tick: engine?.tick ?? 0,
        message: cleanErrorMessage(error),
      },
    });
  }
});

setInterval(() => {
  if (!running || !engine) return;
  fractionalSteps += tempo;
  const steps = Math.floor(fractionalSteps);
  if (steps < 1) return;
  fractionalSteps -= steps;
  advance(steps);
}, 1_000 / 30);
