import { cleanErrorMessage, compileBehavior } from "./compiler.js";
import { SimulationEngine } from "./engine.js";

let engine = null;
let behavior = null;
let running = false;
let tempo = 1;
let fractionalSteps = 0;
let configuration = null;
let worldRevision = 0;

function asRevision(value, fallback = worldRevision) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : fallback;
}

function emit(type, detail = {}) {
  self.postMessage({ type, worldRevision, ...detail });
}

function emitFrame() {
  if (engine) emit("frame", { frame: engine.frame() });
}

function setRunning(value) {
  running = Boolean(value);
  fractionalSteps = 0;
  emit("status", { running });
}

function isCurrentWorldMessage(message) {
  return asRevision(message.worldRevision, -1) === worldRevision;
}

function beginWorldMutation(message) {
  const nextRevision = asRevision(message.worldRevision, -1);
  if (nextRevision <= worldRevision) return false;
  worldRevision = nextRevision;
  return true;
}

function initialize(config, revision = 0) {
  worldRevision = asRevision(revision, 0);
  configuration = {
    ...config,
    params: { ...config.params },
    environment: config.environment ?? null,
  };
  tempo = Math.max(0.05, Math.min(8, Number(config.tempo) || 1));
  behavior = compileBehavior(config.source);
  engine = new SimulationEngine({
    behavior,
    ruleKey: config.source,
    seed: config.seed,
    population: config.population,
    width: config.width,
    height: config.height,
    params: config.params,
    relationMode: config.relationMode,
    environment: config.environment ?? null,
  });
  setRunning(false);
  emit("compileResult", { ok: true, initial: true });
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
        initialize(message.config, message.worldRevision);
        break;
      case "play":
        if (engine && isCurrentWorldMessage(message)) setRunning(true);
        break;
      case "pause":
        if (isCurrentWorldMessage(message)) setRunning(false);
        break;
      case "step":
        if (!isCurrentWorldMessage(message)) break;
        setRunning(false);
        advance(message.count || 1);
        break;
      case "reset":
        if (!engine || !beginWorldMutation(message)) break;
        setRunning(false);
        configuration = {
          ...configuration,
          seed: message.seed ?? engine.seed,
          population: message.population ?? engine.population,
          params: { ...(message.params ?? engine.params) },
          environment: message.environment ?? configuration.environment,
        };
        behavior = compileBehavior(configuration.source);
        engine.setBehavior(behavior, configuration.source);
        engine.reset({
          seed: configuration.seed,
          population: configuration.population,
          params: configuration.params,
          environment: configuration.environment,
        });
        emitFrame();
        break;
      case "reconfigure":
        if (!engine || !beginWorldMutation(message)) break;
        configuration = {
          ...configuration,
          population: message.population ?? configuration.population,
          params: { ...(message.params ?? configuration.params) },
          environment: message.environment ?? configuration.environment,
        };
        setRunning(false);
        behavior = compileBehavior(configuration.source);
        engine.setBehavior(behavior, configuration.source);
        engine.reset({
          seed: engine.seed,
          population: configuration.population,
          params: configuration.params,
          environment: configuration.environment,
        });
        emitFrame();
        break;
      case "setTempo":
        if (!isCurrentWorldMessage(message)) break;
        tempo = Math.max(0.05, Math.min(8, Number(message.tempo) || 1));
        if (configuration) configuration.tempo = tempo;
        fractionalSteps = 0;
        break;
      case "applySource": {
        if (!engine || !beginWorldMutation(message)) break;
        setRunning(false);
        const nextBehavior = compileBehavior(message.source);
        behavior = nextBehavior;
        configuration = { ...configuration, source: message.source };
        engine.setBehavior(nextBehavior, message.source);
        engine.reset();
        emit("compileResult", { ok: true, initial: false });
        emitFrame();
        break;
      }
      case "perturbAgent": {
        if (!engine || !beginWorldMutation(message)) break;
        setRunning(false);
        const result = engine.perturbAgent(message.agentId, message.position, {
          sequence: message.sequence,
          zeroVelocity: true,
        });
        const frame = engine.frame();
        if (!result.ok) {
          emit("interventionResult", {
            ok: false,
            sequence: message.sequence,
            message: result.error,
            frame,
          });
          break;
        }
        // The result and the exact post-intervention frame form one atomic
        // message. The main thread renders it before it sends a tagged `play`
        // acknowledgement, so no subsequent tick can overtake the mutation.
        emit("interventionResult", {
          ok: true,
          sequence: result.intervention.sequence,
          intervention: result.intervention,
          frame,
        });
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
      setRunning(false);
      emit("compileResult", {
        ok: false,
        initial: message.type === "initialize",
        message: cleanErrorMessage(error),
      });
      // A failed apply still advances the logical revision. Re-emit the
      // unchanged world under that revision so future controls stay coherent.
      emitFrame();
      return;
    }

    setRunning(false);
    emit("runtimeError", {
      error: {
        tick: engine?.tick ?? 0,
        message: cleanErrorMessage(error),
      },
    });
    emitFrame();
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
