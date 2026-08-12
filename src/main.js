import { CanvasRenderer } from "./canvas-renderer.js";
import { copyParameters, getScenario, scenarios } from "./scenarios.js";

const element = (id) => document.getElementById(id);
const ui = {
  scenario: element("scenario-select"),
  seed: element("seed-value"),
  newSeed: element("new-seed-button"),
  tick: element("tick-value"),
  canvasStatus: element("canvas-status"),
  canvasDescription: element("canvas-description"),
  play: element("play-button"),
  playIcon: element("play-icon"),
  playLabel: element("play-label"),
  step: element("step-button"),
  reset: element("reset-button"),
  tempo: element("speed-select"),
  population: element("population-input"),
  populationValue: element("population-value"),
  trails: element("trails-toggle"),
  relations: element("relations-toggle"),
  parameters: element("parameter-controls"),
  spread: element("spread-value"),
  nearest: element("nearest-value"),
  match: element("match-value"),
  matchLabel: element("match-label"),
  metricLine: element("metric-line"),
  lessonKicker: element("lesson-kicker"),
  lessonTitle: element("lesson-title"),
  lessonDescription: element("lesson-description"),
  ruleSteps: element("rule-steps"),
  question: element("question-prompt"),
  editor: element("code-editor"),
  lineNumbers: element("line-numbers"),
  codeState: element("code-state"),
  diagnostics: element("diagnostics"),
  apply: element("apply-button"),
  restore: element("restore-button"),
  presentation: element("presentation-button"),
  roadmapButton: element("roadmap-button"),
  roadmapDialog: element("roadmap-dialog"),
};

const state = {
  scenario: getScenario("between"),
  seed: 2026,
  population: 72,
  params: {},
  source: "",
  appliedSource: "",
  pendingSource: null,
  revision: 0,
  running: false,
  frame: null,
  metricHistory: [],
  lastMetricTick: -1,
  worker: null,
  lastPong: performance.now(),
  recovering: false,
};

const renderer = new CanvasRenderer(element("world-canvas"), {
  onSelect: () => updateCanvasDescription(true),
});

for (const scenario of scenarios) {
  const option = document.createElement("option");
  option.value = scenario.id;
  option.textContent = scenario.title;
  ui.scenario.append(option);
}

function workerConfiguration() {
  return {
    source: state.appliedSource,
    seed: state.seed,
    population: state.population,
    width: 1_000,
    height: 650,
    params: { ...state.params },
    relationMode: state.scenario.relationMode,
  };
}

function startWorker({ recovered = false } = {}) {
  state.worker?.terminate();
  state.worker = new Worker(new URL("./simulation/engine.worker.js", import.meta.url), { type: "module" });
  state.lastPong = performance.now();
  state.running = false;
  updateRunningUi();
  state.worker.addEventListener("message", handleWorkerMessage);
  state.worker.addEventListener("error", (event) => {
    showDiagnostic(`Worker error: ${event.message || "the simulation stopped unexpectedly"}`);
    state.running = false;
    updateRunningUi();
  });
  post({ type: "initialize", config: workerConfiguration(), revision: state.revision });

  if (recovered) {
    showDiagnostic("The last rule stopped responding. The simulation worker was restarted at tick 0; edit the rule before running it again.");
  }
}

function post(message) {
  state.worker?.postMessage(message);
}

function handleWorkerMessage(event) {
  const message = event.data || {};
  state.lastPong = performance.now();

  switch (message.type) {
    case "frame":
      receiveFrame(message.frame);
      break;
    case "status":
      state.running = message.running;
      updateRunningUi();
      break;
    case "compileResult":
      handleCompileResult(message);
      break;
    case "runtimeError":
      state.running = false;
      updateRunningUi();
      showDiagnostic(formatRuntimeError(message.error));
      break;
    case "pong":
      break;
    default:
      break;
  }
}

function handleCompileResult(message) {
  if (!message.ok) {
    showDiagnostic(message.message || "The rule could not be compiled.");
    ui.codeState.textContent = "Needs attention";
    ui.codeState.classList.add("is-dirty");
    return;
  }

  if (!message.initial && message.revision === state.revision && state.pendingSource !== null) {
    state.appliedSource = state.pendingSource;
    state.pendingSource = null;
    state.source = ui.editor.value;
    hideDiagnostic();
    updateDirtyState();
  }
}

function receiveFrame(frame) {
  const reset = frame.tick === 0 || frame.tick < (state.frame?.tick ?? -1) || frame.seed !== state.frame?.seed;
  state.frame = frame;
  if (reset) {
    state.metricHistory = [];
    state.lastMetricTick = -1;
  }
  if (frame.tick !== state.lastMetricTick) {
    state.metricHistory.push(frame.metrics.spread);
    if (state.metricHistory.length > 90) state.metricHistory.shift();
    state.lastMetricTick = frame.tick;
  }
  renderer.update(frame);
  renderMetrics(frame);
  updateCanvasDescription(frame.tick % 15 === 0 || reset);
}

function renderMetrics(frame) {
  ui.tick.textContent = String(frame.tick);
  ui.seed.textContent = String(frame.seed);
  ui.spread.textContent = `${Math.round(frame.metrics.spread)} u`;
  ui.nearest.textContent = `${Math.round(frame.metrics.nearest)} u`;
  ui.match.textContent = frame.metrics.match === null ? "baseline" : `${Math.round(frame.metrics.match)}%`;
  drawMetricHistory();
}

function drawMetricHistory() {
  if (state.metricHistory.length < 2) {
    ui.metricLine.setAttribute("points", "");
    return;
  }
  const minimum = Math.min(...state.metricHistory);
  const maximum = Math.max(...state.metricHistory);
  const range = Math.max(8, maximum - minimum);
  const points = state.metricHistory.map((value, index) => {
    const x = 2 + (index / Math.max(1, state.metricHistory.length - 1)) * 128;
    const y = 38 - ((value - minimum) / range) * 34;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  ui.metricLine.setAttribute("points", points.join(" "));
}

function formatRuntimeError(error = {}) {
  const location = Number.isInteger(error.agentId) ? `Agent ${error.agentId}, tick ${error.tick}: ` : `Tick ${error.tick ?? 0}: `;
  return `${location}${error.message || "The behavior failed."}`;
}

function updateRunningUi() {
  ui.playLabel.textContent = state.running ? "Pause" : "Run";
  ui.playIcon.textContent = state.running ? "Ⅱ" : "▶";
  ui.play.setAttribute("aria-pressed", String(state.running));
  ui.canvasStatus.classList.toggle("is-running", state.running);
  ui.canvasStatus.lastChild.textContent = state.running ? " Running" : " Paused";
}

function updateCanvasDescription(force = false) {
  if (!force || !state.frame) return;
  const selected = state.frame.agents.find((agent) => agent.id === renderer.selectedId);
  const selection = selected
    ? ` Selected person ${selected.id} follows people ${selected.chosen[0]} and ${selected.chosen[1]}.`
    : "";
  ui.canvasDescription.textContent = `${state.scenario.shortTitle}. ${state.population} people. ${
    state.running ? "Running" : "Paused"
  } at tick ${state.frame.tick}. Group spread ${Math.round(state.frame.metrics.spread)}.${selection}`;
}

function showDiagnostic(message) {
  ui.diagnostics.hidden = false;
  ui.diagnostics.textContent = message;
}

function hideDiagnostic() {
  ui.diagnostics.hidden = true;
  ui.diagnostics.textContent = "";
}

function updateLineNumbers() {
  const count = ui.editor.value.split("\n").length;
  ui.lineNumbers.replaceChildren(
    ...Array.from({ length: count }, (_, index) => {
      const line = document.createElement("span");
      line.textContent = String(index + 1);
      return line;
    }),
  );
}

function updateDirtyState() {
  const dirty = ui.editor.value !== state.appliedSource;
  ui.codeState.textContent = dirty ? "Modified · not applied" : "Applied at tick 0";
  ui.codeState.classList.toggle("is-dirty", dirty);
  ui.apply.disabled = !dirty;
}

function renderParameterControls() {
  ui.parameters.replaceChildren();
  for (const definition of state.scenario.controls) {
    const wrapper = document.createElement("div");
    wrapper.className = "parameter-control";
    const id = `parameter-${definition.key}`;
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = definition.label;
    const output = document.createElement("output");
    output.htmlFor = id;
    output.textContent = formatParameter(state.params[definition.key]);
    const input = document.createElement("input");
    input.id = id;
    input.type = "range";
    input.min = String(definition.min);
    input.max = String(definition.max);
    input.step = String(definition.step);
    input.value = String(state.params[definition.key]);
    input.addEventListener("input", () => {
      state.params[definition.key] = Number(input.value);
      output.textContent = formatParameter(state.params[definition.key]);
      renderer.setScenario(state.scenario.relationMode, state.params);
    });
    input.addEventListener("change", () => {
      post({
        type: "reconfigure",
        population: state.population,
        params: { ...state.params },
      });
    });
    wrapper.append(label, output, input);
    ui.parameters.append(wrapper);
  }
}

function formatParameter(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(1);
}

function loadScenario(scenario, { preserveSeed = true } = {}) {
  state.scenario = scenario;
  state.params = copyParameters(scenario);
  state.source = scenario.source;
  state.appliedSource = scenario.source;
  state.pendingSource = null;
  state.revision += 1;
  if (!preserveSeed) state.seed = 2026;
  state.metricHistory = [];
  state.lastMetricTick = -1;

  ui.scenario.value = scenario.id;
  ui.lessonKicker.textContent = scenario.kicker;
  ui.lessonTitle.textContent = scenario.shortTitle;
  ui.lessonDescription.textContent = scenario.description;
  ui.ruleSteps.replaceChildren(
    ...scenario.steps.map((step) => {
      const item = document.createElement("li");
      item.textContent = step;
      return item;
    }),
  );
  ui.question.textContent = scenario.question;
  ui.matchLabel.textContent = scenario.matchLabel;
  ui.editor.value = scenario.source;
  renderer.setScenario(scenario.relationMode, state.params);
  renderer.setSelected(0);
  updateLineNumbers();
  updateDirtyState();
  renderParameterControls();
  hideDiagnostic();
  startWorker();
}

function togglePlayback() {
  if (state.running) post({ type: "pause" });
  else post({ type: "play" });
}

function applySource() {
  state.revision += 1;
  state.pendingSource = ui.editor.value;
  ui.codeState.textContent = "Checking…";
  ui.codeState.classList.add("is-dirty");
  post({
    type: "applySource",
    source: state.pendingSource,
    revision: state.revision,
  });
}

ui.play.addEventListener("click", togglePlayback);
ui.step.addEventListener("click", () => post({ type: "step", count: 1 }));
ui.reset.addEventListener("click", () => {
  hideDiagnostic();
  post({ type: "reset", seed: state.seed, population: state.population, params: { ...state.params } });
});
ui.newSeed.addEventListener("click", () => {
  state.seed = (state.seed + 7_919) % 100_000;
  post({ type: "reset", seed: state.seed, population: state.population, params: { ...state.params } });
});
ui.tempo.addEventListener("change", () => post({ type: "setTempo", tempo: Number(ui.tempo.value) }));
ui.population.addEventListener("input", () => {
  state.population = Number(ui.population.value);
  ui.populationValue.textContent = String(state.population);
});
ui.population.addEventListener("change", () => {
  post({ type: "reconfigure", population: state.population, params: { ...state.params } });
});
ui.trails.addEventListener("change", () => renderer.setTrails(ui.trails.checked));
ui.relations.addEventListener("change", () => renderer.setRelations(ui.relations.checked));
ui.scenario.addEventListener("change", () => loadScenario(getScenario(ui.scenario.value)));
ui.editor.addEventListener("input", () => {
  state.source = ui.editor.value;
  updateLineNumbers();
  updateDirtyState();
});
ui.editor.addEventListener("scroll", () => {
  ui.lineNumbers.scrollTop = ui.editor.scrollTop;
});
ui.editor.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const start = ui.editor.selectionStart;
    const end = ui.editor.selectionEnd;
    ui.editor.setRangeText("  ", start, end, "end");
    ui.editor.dispatchEvent(new Event("input"));
  }
});
ui.apply.addEventListener("click", applySource);
ui.restore.addEventListener("click", () => {
  ui.editor.value = state.scenario.source;
  state.source = ui.editor.value;
  hideDiagnostic();
  updateLineNumbers();
  updateDirtyState();
});
ui.roadmapButton.addEventListener("click", () => ui.roadmapDialog.showModal());
ui.presentation.addEventListener("click", () => {
  const enabled = document.body.classList.toggle("presentation-mode");
  ui.presentation.innerHTML = enabled ? "<span aria-hidden=\"true\">×</span> Exit" : "<span aria-hidden=\"true\">↗</span> Present";
  window.setTimeout(() => renderer.draw(), 30);
});

for (const tab of document.querySelectorAll(".mobile-tab")) {
  tab.addEventListener("click", () => {
    document.body.dataset.mobileTab = tab.dataset.tab;
    document.querySelectorAll(".mobile-tab").forEach((candidate) => {
      candidate.classList.toggle("is-active", candidate === tab);
    });
    if (tab.dataset.tab === "playground") window.setTimeout(() => renderer.draw(), 20);
  });
}

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    if (ui.editor.value !== state.appliedSource) applySource();
    return;
  }

  const interactive = event.target.closest?.("textarea, input, select, button, summary");
  if (event.code === "Space" && !interactive) {
    event.preventDefault();
    togglePlayback();
  }
});

window.setInterval(() => {
  if (document.visibilityState !== "visible" || state.recovering) return;
  const now = performance.now();
  if (now - state.lastPong > 1_800) {
    state.recovering = true;
    startWorker({ recovered: true });
    window.setTimeout(() => {
      state.recovering = false;
    }, 500);
    return;
  }
  post({ type: "ping", nonce: now });
}, 500);

state.params = copyParameters(state.scenario);
state.source = state.scenario.source;
state.appliedSource = state.scenario.source;
ui.populationValue.textContent = String(state.population);
loadScenario(state.scenario, { preserveSeed: false });
