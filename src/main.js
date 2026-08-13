import { CanvasRenderer } from "./canvas-renderer.js";
import { copyParameters, getScenario, scenarios } from "./scenarios.js";

const element = (id) => document.getElementById(id);
const ui = {
  scenario: element("scenario-select"),
  seed: element("seed-value"),
  newSeed: element("new-seed-button"),
  tick: element("tick-value"),
  canvasStatus: element("canvas-status"),
  canvasInstruction: element("canvas-instruction"),
  canvasDelay: element("canvas-delay"),
  canvasLegend: element("canvas-legend"),
  legendAItem: element("legend-a-item"),
  legendALabel: element("legend-a-label"),
  legendBItem: element("legend-b-item"),
  legendBLabel: element("legend-b-label"),
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
  primaryMetricLabel: element("primary-metric-label"),
  primaryMetricDetail: element("primary-metric-detail"),
  nearest: element("nearest-value"),
  secondaryMetricLabel: element("secondary-metric-label"),
  secondaryMetricDetail: element("secondary-metric-detail"),
  match: element("match-value"),
  metricLabel: element("metric-label"),
  matchLabel: element("match-label"),
  trendLabel: element("trend-label"),
  metricChart: element("metric-chart"),
  metricLine: element("metric-line"),
  lessonKicker: element("lesson-kicker"),
  labStage: element("lab-stage"),
  lessonNumber: element("lesson-number"),
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
  pendingSourceRevision: null,
  worldRevision: 0,
  running: false,
  frame: null,
  metricHistory: [],
  lastMetricTick: -1,
  worker: null,
  workerGeneration: 0,
  pendingPing: null,
  recovering: false,
  dragWasRunning: false,
  interventionSequence: 0,
  pendingResumeSequence: null,
  interventions: [],
  perturbed: false,
};

const renderer = new CanvasRenderer(element("world-canvas"), {
  onSelect: () => updateCanvasDescription(true),
  onDragStart: beginPerturbation,
  onPerturb: submitPerturbation,
  onDragCancel: cancelPerturbation,
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
    environment: state.scenario.environment ?? null,
    tempo: Number(ui.tempo.value),
  };
}

function startWorker({ recovered = false } = {}) {
  state.worker?.terminate();
  const worker = new Worker(new URL("./simulation/engine.worker.js", import.meta.url), { type: "module" });
  const generation = state.workerGeneration + 1;
  state.workerGeneration = generation;
  state.worker = worker;
  state.pendingPing = null;
  state.running = false;
  updateRunningUi();
  worker.addEventListener("message", (event) => handleWorkerMessage(event, generation));
  worker.addEventListener("error", (event) => {
    if (generation !== state.workerGeneration) return;
    showDiagnostic(`Worker error: ${event.message || "the simulation stopped unexpectedly"}`);
    state.running = false;
    updateRunningUi();
  });
  post({
    type: "initialize",
    config: workerConfiguration(),
    worldRevision: state.worldRevision,
  });

  if (recovered) {
    clearInterventionState();
    showDiagnostic("The last rule stopped responding. The simulation worker was restarted at tick 0; edit the rule before running it again.");
  }
}

function post(message) {
  state.worker?.postMessage(message);
}

function postToCurrentWorld(message) {
  post({ ...message, worldRevision: state.worldRevision });
}

function postWorldMutation(message) {
  state.worldRevision += 1;
  post({ ...message, worldRevision: state.worldRevision });
  return state.worldRevision;
}

function handleWorkerMessage(event, generation) {
  if (generation !== state.workerGeneration) return;
  const message = event.data || {};

  // A replaced world may still have frames/status events queued on the main
  // thread. Only heartbeat replies are meaningful across world revisions.
  const isPendingCompileResult = message.type === "compileResult"
    && message.worldRevision === state.pendingSourceRevision;
  if (message.type !== "pong" && message.worldRevision !== state.worldRevision && !isPendingCompileResult) return;

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
    case "interventionResult":
      handleInterventionResult(message);
      break;
    case "pong":
      if (!state.pendingPing || message.nonce === state.pendingPing.nonce) state.pendingPing = null;
      break;
    default:
      break;
  }
}

function handleCompileResult(message) {
  if (!message.ok) {
    state.pendingSource = null;
    state.pendingSourceRevision = null;
    showDiagnostic(message.message || "The rule could not be compiled.");
    ui.codeState.textContent = "Needs attention";
    ui.codeState.classList.add("is-dirty");
    ui.apply.disabled = ui.editor.value === state.appliedSource;
    return;
  }

  if (!message.initial && message.worldRevision === state.pendingSourceRevision && state.pendingSource !== null) {
    state.appliedSource = state.pendingSource;
    state.pendingSource = null;
    state.pendingSourceRevision = null;
    state.source = ui.editor.value;
    if (message.worldRevision === state.worldRevision) clearInterventionState();
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
    const trendValue = Number(frame.metrics[state.scenario.trend.key]);
    if (Number.isFinite(trendValue)) {
      state.metricHistory.push(trendValue);
      if (state.metricHistory.length > 90) state.metricHistory.shift();
    }
    state.lastMetricTick = frame.tick;
  }
  renderer.update(frame);
  renderMetrics(frame);
  updateCanvasDescription(frame.tick % 15 === 0 || reset);
}

function renderMetrics(frame) {
  ui.tick.textContent = String(frame.tick);
  ui.seed.textContent = String(frame.seed);
  const [primaryMetric, secondaryMetric] = state.scenario.summaryMetrics;
  ui.spread.textContent = formatMetric(frame.metrics[primaryMetric.key], primaryMetric);
  ui.nearest.textContent = formatMetric(frame.metrics[secondaryMetric.key], secondaryMetric);
  const metric = state.scenario.metric;
  const metricValue = frame.metrics[metric.key];
  ui.match.textContent = formatMetric(metricValue, metric);
  if (ui.canvasDelay) {
    const configuredDelay = frame.configuredDelayTicks ?? frame.delayTicks ?? 0;
    const observationAge = frame.observationAge ?? frame.delayTicks ?? 0;
    ui.canvasDelay.hidden = configuredDelay === 0;
    ui.canvasDelay.textContent = configuredDelay === 0
      ? ""
      : observationAge < configuredDelay
        ? `delay ${configuredDelay}t · warming ${observationAge}t`
        : `delay ${configuredDelay}t`;
  }
  drawMetricHistory();
}

function formatMetric(value, definition) {
  if (!Number.isFinite(value)) return definition.fallback || "—";
  if (definition.format === "fraction-percent") return `${Math.round(value * 100)}%`;
  if (definition.format === "percent") return `${Math.round(value)}%`;
  if (definition.format === "units") return `${Math.round(value)} u`;
  return String(Math.round(value));
}

function drawMetricHistory() {
  if (state.metricHistory.length < 2) {
    ui.metricLine.setAttribute("points", "");
    return;
  }
  const minimum = Math.min(...state.metricHistory);
  const maximum = Math.max(...state.metricHistory);
  const range = Math.max(state.scenario.trend.minimumRange ?? 8, maximum - minimum);
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
  const selectedDestination = state.frame.environment?.destinations?.find(
    (destination) => destination.id === selected?.destinationId,
  );
  const selection = selected
    ? state.scenario.environment?.journeys?.enabled
      ? ` Selected person ${selected.id} is travelling toward ${
        selectedDestination?.label || selected.destinationId || "the opposite destination"
      }.`
      : ` Selected person ${selected.id} follows people ${selected.chosen[0]} and ${selected.chosen[1]}.`
    : "";
  const configuredDelay = state.frame.configuredDelayTicks ?? state.frame.delayTicks ?? 0;
  const observationAge = state.frame.observationAge ?? state.frame.delayTicks ?? 0;
  const warmup = configuredDelay > observationAge ? `, currently ${observationAge} ticks of history` : "";
  const scenarioMeasurement = state.scenario.environment?.field?.enabled
    ? ` Trail concentration ${formatMetric(state.frame.metrics.trailConcentration, state.scenario.metric)}; ${
      state.frame.metrics.trips ?? 0
    } completed trips.`
    : ` Group spread ${Math.round(state.frame.metrics.spread)}. Reaction delay ${
      configuredDelay
    } ticks${warmup}.`;
  ui.canvasDescription.textContent = `${state.scenario.shortTitle}. ${state.population} people. ${
    state.running ? "Running" : "Paused"
  } at tick ${state.frame.tick}.${scenarioMeasurement}${selection}${state.perturbed ? " A manual perturbation has been applied." : ""}`;
}

function updateCanvasInstruction(mode = "default") {
  if (mode === "dragging") {
    ui.canvasInstruction.textContent = "Move this person, then release to watch the disturbance spread.";
  } else if (state.perturbed) {
    ui.canvasInstruction.textContent = "Manual perturbation applied · reset to reproduce the seeded run.";
  } else {
    ui.canvasInstruction.textContent = "Click a person to inspect · drag a person to perturb the group.";
  }
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
  ui.apply.disabled = !dirty || state.pendingSource !== null;
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
    output.textContent = formatParameter(state.params[definition.key], definition);
    let input;
    if (definition.type === "select") {
      input = document.createElement("select");
      input.className = "parameter-select";
      for (const optionDefinition of definition.options) {
        const option = document.createElement("option");
        option.value = String(optionDefinition.value);
        option.textContent = optionDefinition.label;
        input.append(option);
      }
      input.value = String(state.params[definition.key]);
      output.textContent = definition.options.find(
        (option) => String(option.value) === String(state.params[definition.key]),
      )?.label || String(state.params[definition.key]);
    } else {
      input = document.createElement("input");
      input.type = "range";
      input.min = String(definition.min);
      input.max = String(definition.max);
      input.step = String(definition.step);
      input.value = String(state.params[definition.key]);
      if (definition.unit === "tick") {
        input.title = `${formatParameter(state.params[definition.key], definition)} · ${(
          Number(state.params[definition.key]) / 30
        ).toFixed(2)} seconds`;
      }
    }
    input.id = id;
    const updateParameter = () => {
      const numericValue = Number(input.value);
      state.params[definition.key] = Number.isFinite(numericValue) ? numericValue : input.value;
      output.textContent = definition.type === "select"
        ? input.selectedOptions[0]?.textContent || input.value
        : formatParameter(state.params[definition.key], definition);
      if (definition.unit === "tick") {
        input.title = `${formatParameter(state.params[definition.key], definition)} · ${(
          Number(state.params[definition.key]) / 30
        ).toFixed(2)} seconds`;
      }
      renderer.setScenario(state.scenario.relationMode, state.params);
    };
    if (definition.type !== "select") input.addEventListener("input", updateParameter);
    input.addEventListener("change", () => {
      updateParameter();
      clearInterventionState();
      postWorldMutation({
        type: "reconfigure",
        population: state.population,
        params: { ...state.params },
      });
    });
    wrapper.append(label, output, input);
    ui.parameters.append(wrapper);
  }
}

function formatParameter(value, definition = {}) {
  if (definition.unit === "tick") return `${value} ${Number(value) === 1 ? "tick" : "ticks"}`;
  if (definition.format === "percent") return `${(Number(value) * 100).toFixed(1)}%`;
  if (definition.format === "decimal-2") return Number(value).toFixed(2);
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(1);
}

function loadScenario(scenario, { preserveSeed = true } = {}) {
  state.scenario = scenario;
  document.body.dataset.scenario = scenario.id;
  state.params = copyParameters(scenario);
  state.source = scenario.source;
  state.appliedSource = scenario.source;
  state.pendingSource = null;
  state.pendingSourceRevision = null;
  state.worldRevision += 1;
  if (!preserveSeed) state.seed = 2026;
  state.metricHistory = [];
  state.lastMetricTick = -1;
  clearInterventionState();

  ui.scenario.value = scenario.id;
  ui.labStage.textContent = scenario.stage.label;
  ui.lessonNumber.textContent = scenario.stage.number;
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
  const [primaryMetric, secondaryMetric] = scenario.summaryMetrics;
  ui.primaryMetricLabel.textContent = primaryMetric.label;
  ui.primaryMetricDetail.textContent = primaryMetric.detail;
  ui.secondaryMetricLabel.textContent = secondaryMetric.label;
  ui.secondaryMetricDetail.textContent = secondaryMetric.detail;
  ui.metricLabel.textContent = scenario.metric.label;
  ui.matchLabel.textContent = scenario.metric.detail || scenario.matchLabel;
  ui.trendLabel.textContent = scenario.trend.label;
  ui.metricChart.setAttribute("aria-label", scenario.trend.ariaLabel);
  const hasJourneys = Boolean(scenario.environment?.journeys?.enabled);
  const hasSocialRelations = scenario.relationMode !== "none";
  ui.legendAItem.hidden = !hasJourneys && !hasSocialRelations;
  ui.legendBItem.hidden = !hasJourneys && !hasSocialRelations;
  ui.legendALabel.textContent = hasJourneys ? "destination" : "person A";
  ui.legendBLabel.textContent = hasJourneys ? "footfall" : "person B";
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
  if (state.running) postToCurrentWorld({ type: "pause" });
  else postToCurrentWorld({ type: "play" });
}

function applySource() {
  if (state.pendingSource !== null) return;
  state.pendingSource = ui.editor.value;
  ui.codeState.textContent = "Checking…";
  ui.codeState.classList.add("is-dirty");
  ui.apply.disabled = true;
  state.pendingSourceRevision = postWorldMutation({
    type: "applySource",
    source: state.pendingSource,
  });
}

function beginPerturbation() {
  state.dragWasRunning = state.running;
  if (state.running) postToCurrentWorld({ type: "pause" });
  updateCanvasInstruction("dragging");
}

function submitPerturbation(agentId, position) {
  const sequence = state.interventionSequence + 1;
  state.interventionSequence = sequence;
  state.pendingResumeSequence = state.dragWasRunning ? sequence : null;
  postWorldMutation({
    type: "perturbAgent",
    agentId,
    position,
    sequence,
  });
}

function cancelPerturbation() {
  if (state.dragWasRunning) postToCurrentWorld({ type: "play" });
  state.dragWasRunning = false;
  updateCanvasInstruction();
}

function handleInterventionResult(message) {
  // The worker returns the mutation and its exact frame in one message. Render
  // that frame before acknowledging the intervention by resuming playback.
  if (message.frame) receiveFrame(message.frame);

  if (!message.ok) {
    renderer.cancelPerturbationPreview();
    showDiagnostic(message.message || "The perturbation could not be applied.");
  } else {
    state.interventions.push(message.intervention);
    state.perturbed = true;
    hideDiagnostic();
  }

  if (state.pendingResumeSequence === message.sequence) postToCurrentWorld({ type: "play" });
  state.pendingResumeSequence = null;
  state.dragWasRunning = false;
  updateCanvasInstruction();
  updateCanvasDescription(true);
}

function clearInterventionState() {
  state.interventionSequence = 0;
  state.pendingResumeSequence = null;
  state.interventions = [];
  state.perturbed = false;
  state.dragWasRunning = false;
  renderer.cancelPerturbationPreview();
  updateCanvasInstruction();
}

ui.play.addEventListener("click", togglePlayback);
ui.step.addEventListener("click", () => postToCurrentWorld({ type: "step", count: 1 }));
ui.reset.addEventListener("click", () => {
  hideDiagnostic();
  clearInterventionState();
  postWorldMutation({ type: "reset", seed: state.seed, population: state.population, params: { ...state.params } });
});
ui.newSeed.addEventListener("click", () => {
  state.seed = (state.seed + 7_919) % 100_000;
  clearInterventionState();
  postWorldMutation({ type: "reset", seed: state.seed, population: state.population, params: { ...state.params } });
});
ui.tempo.addEventListener("change", () => postToCurrentWorld({ type: "setTempo", tempo: Number(ui.tempo.value) }));
ui.population.addEventListener("input", () => {
  state.population = Number(ui.population.value);
  ui.populationValue.textContent = String(state.population);
});
ui.population.addEventListener("change", () => {
  clearInterventionState();
  postWorldMutation({ type: "reconfigure", population: state.population, params: { ...state.params } });
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
  if (state.pendingPing && now - state.pendingPing.sentAt > 1_800) {
    state.recovering = true;
    startWorker({ recovered: true });
    window.setTimeout(() => {
      state.recovering = false;
    }, 500);
    return;
  }
  if (!state.pendingPing) {
    const nonce = `${state.workerGeneration}:${now}`;
    state.pendingPing = { nonce, sentAt: now };
    post({ type: "ping", nonce });
  }
}, 500);

document.addEventListener("visibilitychange", () => {
  state.pendingPing = null;
  if (document.visibilityState === "visible") {
    const nonce = `${state.workerGeneration}:${performance.now()}`;
    state.pendingPing = { nonce, sentAt: performance.now() };
    post({ type: "ping", nonce });
  }
});

state.params = copyParameters(state.scenario);
state.source = state.scenario.source;
state.appliedSource = state.scenario.source;
ui.populationValue.textContent = String(state.population);
loadScenario(state.scenario, { preserveSeed: false });
