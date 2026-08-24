import { CanvasRenderer } from "./canvas-renderer.js";
import {
  createBlockGrid,
  gatePlacementConflict,
  normalizeGate,
  normalizeLayoutRect,
  placementConflict,
} from "./layout-tools.js";
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
  legendSelfItem: element("legend-self-item"),
  legendSelfLabel: element("legend-self-label"),
  legendAItem: element("legend-a-item"),
  legendALabel: element("legend-a-label"),
  legendBItem: element("legend-b-item"),
  legendBLabel: element("legend-b-label"),
  legendCItem: element("legend-c-item"),
  legendCLabel: element("legend-c-label"),
  canvasDescription: element("canvas-description"),
  layoutEditor: element("layout-editor"),
  layoutStatus: element("layout-status"),
  layoutTools: [...document.querySelectorAll("[data-layout-tool]")],
  layoutGridOptions: element("layout-grid-options"),
  layoutGridRows: element("layout-grid-rows"),
  layoutGridColumns: element("layout-grid-columns"),
  layoutGridGap: element("layout-grid-gap"),
  gateList: element("gate-list"),
  layoutUndo: element("layout-undo"),
  layoutClear: element("layout-clear"),
  layoutRestore: element("layout-restore"),
  territoryInspector: element("territory-inspector"),
  territoryParcelSelect: element("territory-parcel-select"),
  territoryCell: element("territory-cell-value"),
  territoryTenure: element("territory-tenure-value"),
  territoryHolder: element("territory-holder-value"),
  territoryTiming: element("territory-timing-value"),
  territoryArea: element("territory-area-value"),
  territoryCompactness: element("territory-compactness-value"),
  territoryFrontage: element("territory-frontage-value"),
  territoryCirculation: element("territory-circulation-value"),
  territoryPolicy: element("territory-policy"),
  play: element("play-button"),
  playIcon: element("play-icon"),
  playLabel: element("play-label"),
  step: element("step-button"),
  reset: element("reset-button"),
  tempo: element("speed-select"),
  population: element("population-input"),
  populationValue: element("population-value"),
  populationLabel: element("population-label"),
  trailsControl: element("trails-control"),
  trails: element("trails-toggle"),
  relationsControl: element("relations-control"),
  relations: element("relations-toggle"),
  landControl: element("land-control"),
  land: element("land-toggle"),
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
  environment: null,
  layoutUndo: [],
  layoutTool: "inspect",
  layoutSettings: { rows: 3, columns: 4, gap: 36 },
  selectedLandId: null,
  territoryOptionsSignature: "",
};

const renderer = new CanvasRenderer(element("world-canvas"), {
  onSelect: handleAgentSelection,
  onDragStart: beginPerturbation,
  onPerturb: submitPerturbation,
  onDragCancel: cancelPerturbation,
  onLayoutGesture: handleLayoutGesture,
  onEnvironmentErase: handleEnvironmentErase,
  onLandSelect: handleLandSelection,
});

for (const scenario of scenarios) {
  const option = document.createElement("option");
  option.value = scenario.id;
  option.textContent = scenario.title;
  ui.scenario.append(option);
}

const WORLD_WIDTH = 1_000;
const WORLD_HEIGHT = 650;
const MAX_LAYOUT_UNDO = 30;
const DESTINATION_CLEARANCE = 18;
const DEFAULT_GATE_RADIUS = 34;
const MIN_GATE_RADIUS = 18;
const MAX_GATE_RADIUS = 70;
const MINIMUM_GATE_COUNT = 2;

function cloneEnvironment(environment) {
  if (!environment) return null;
  if (typeof structuredClone === "function") return structuredClone(environment);
  return JSON.parse(JSON.stringify(environment));
}

function editableLayoutAvailable(scenario = state.scenario) {
  return Boolean(scenario.editableLayout);
}

function territoryAvailable(scenario = state.scenario) {
  return Boolean(scenario.environment?.land?.enabled);
}

function frameLand(frame = state.frame) {
  return frame?.land || frame?.environment?.land || null;
}

function frameCirculation(frame = state.frame) {
  return frame?.circulation || null;
}

function circulationStatus(feature) {
  if (!feature) return null;
  const value = String(feature.status ?? feature.role ?? feature.state ?? feature.designation ?? "").toLowerCase();
  if (["road", "street", "committed", "public-way", "public_way"].includes(value)) return "road";
  if (["reserved", "reservation", "pending", "road-reserved", "road_reserved"].includes(value)) return "reserved";
  if (["trace", "candidate", "used", "preferred"].includes(value)) return "trace";
  if (value === "open" && circulationUse(feature) > 0) return "trace";
  return feature.road === true ? "road" : feature.reservedBy !== null && feature.reservedBy !== undefined
    ? "reserved"
    : null;
}

function circulationFeaturesByLandId(frame) {
  const circulation = frameCirculation(frame);
  const result = new Map();
  for (const feature of Array.isArray(circulation?.regions) ? circulation.regions : []) {
    const id = feature?.landId ?? feature?.cellId ?? feature?.id;
    if (id !== null && id !== undefined) result.set(String(id), feature);
  }
  for (const feature of Array.isArray(circulation?.cells) ? circulation.cells : []) {
    const id = feature?.landId ?? feature?.cellId ?? feature?.id;
    if (id !== null && id !== undefined && !result.has(String(id))) result.set(String(id), feature);
  }
  return result;
}

function circulationFeatureForCell(frame, cell, features = null) {
  if (!cell) return null;
  if (cell.circulation && typeof cell.circulation === "object") {
    return { landId: cell.id, ...cell.circulation };
  }
  return (features || circulationFeaturesByLandId(frame)).get(String(cell.id)) || null;
}

function circulationUse(feature) {
  const value = Number(feature?.use ?? feature?.usage ?? feature?.footfall ?? feature?.load);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function circulationLabel(frame, cell, features) {
  const feature = circulationFeatureForCell(frame, cell, features);
  if (feature?.easement === true) {
    const pressure = Number(feature.pressure);
    return `public easement${Number.isFinite(pressure) ? ` · pressure ${Math.round(pressure)}` : ""}`;
  }
  const status = circulationStatus(feature);
  if (!status) {
    const adjacent = Array.isArray(cell?.roadNeighbors)
      ? cell.roadNeighbors.length
      : Number(cell?.roadFrontageEdges ?? cell?.roadFrontage ?? 0);
    return adjacent > 0 ? `${adjacent} public-way edge${adjacent === 1 ? "" : "s"}` : "no active route";
  }
  const use = circulationUse(feature);
  const label = status === "road"
    ? "public way"
    : status === "reserved"
      ? "public-way reservation"
      : "travel trace";
  const holder = status === "reserved" && feature.reservedBy !== null && feature.reservedBy !== undefined
    ? ` · person ${feature.reservedBy}`
    : "";
  const eventConflict = (frameLand(frame)?.events || []).some((event) => (
    event?.type === "road-land-conflict" && String(event.landId) === String(cell.id)
  ));
  const conflict = feature.contested === true || feature.conflict === true || eventConflict
    ? " · road/plot conflict"
    : "";
  return `${label} · use ${Math.round(use)}${holder}${conflict}`;
}

function roadFrontage(frame, land, cell, parcel, features) {
  const selectedStatus = circulationStatus(circulationFeatureForCell(frame, cell, features));
  if (!cell || selectedStatus === "road" || selectedStatus === "reserved") return null;
  const byId = new Map((land?.cells || []).map((candidate) => [String(candidate.id), candidate]));
  const cells = (parcel?.cellIds || [cell.id]).map((id) => byId.get(String(id))).filter(Boolean);
  let edges = 0;
  let length = 0;
  for (const parcelCell of cells) {
    for (const neighborId of Array.isArray(parcelCell.neighborIds) ? parcelCell.neighborIds : []) {
      const neighbor = byId.get(String(neighborId));
      const status = circulationStatus(circulationFeatureForCell(frame, neighbor, features));
      if (status !== "road" && status !== "reserved") continue;
      edges += 1;
      const horizontalEdge = Number(parcelCell.column) !== Number(neighbor?.column);
      const fallback = Number(land?.geometry?.cellSize) || 0;
      length += horizontalEdge
        ? Number(parcelCell.height) || fallback
        : Number(parcelCell.width) || fallback;
    }
  }
  return { edges, length };
}

function landCellState(cell) {
  if (!cell) return "unclaimed";
  if (cell.state) return cell.state;
  if (cell.ownerId !== null && cell.ownerId !== undefined) return "claimed";
  if (cell.reservedBy !== null && cell.reservedBy !== undefined) return "reserved";
  return "unclaimed";
}

function selectedLandCell(frame = state.frame) {
  if (!state.selectedLandId) return null;
  return frameLand(frame)?.cells?.find((cell) => String(cell.id) === String(state.selectedLandId)) || null;
}

function parcelForCell(land, cell) {
  if (!land || !cell) return null;
  if (cell.parcelId !== null && cell.parcelId !== undefined) {
    const direct = land.parcels?.find((parcel) => String(parcel.id) === String(cell.parcelId));
    if (direct) return direct;
  }
  return land.parcels?.find((parcel) => parcel.cellIds?.some((id) => String(id) === String(cell.id))) || null;
}

function landHolder(cell) {
  const stateName = landCellState(cell);
  if (stateName === "claimed") return cell.ownerId;
  if (stateName === "reserved") return cell.reservedBy;
  return null;
}

function handleLandSelection(landId) {
  state.selectedLandId = landId === null || landId === undefined ? null : String(landId);
  renderer.setSelectedLand?.(state.selectedLandId);
  renderTerritoryInspector(state.frame);
  updateCanvasDescription(true);
}

function handleAgentSelection() {
  if (territoryAvailable()) {
    state.selectedLandId = null;
    renderer.setSelectedLand?.(null);
    renderTerritoryInspector(state.frame);
  }
  updateCanvasDescription(true);
}

function renderTerritoryOptions(land, frame, circulationFeatures) {
  const active = (land?.cells || []).filter(
    (cell) => {
      const roadStatus = circulationStatus(circulationFeatureForCell(frame, cell, circulationFeatures));
      return landCellState(cell) !== "unclaimed"
        || roadStatus === "road"
        || roadStatus === "reserved"
        || String(cell.id) === String(state.selectedLandId);
    },
  );
  const signature = active.map((cell) => {
    const feature = circulationFeatureForCell(frame, cell, circulationFeatures);
    return `${cell.id}:${landCellState(cell)}:${landHolder(cell)}:${
      circulationStatus(feature)
    }:${feature?.reservedBy ?? ""}`;
  }).join("|");
  if (signature === state.territoryOptionsSignature) {
    ui.territoryParcelSelect.value = state.selectedLandId || "";
    return;
  }

  state.territoryOptionsSignature = signature;
  const prompt = document.createElement("option");
  prompt.value = "";
  prompt.textContent = active.length === 0 ? "No claims or roads yet" : "Choose on the map";
  ui.territoryParcelSelect.replaceChildren(prompt);
  for (const cell of active) {
    const option = document.createElement("option");
    option.value = String(cell.id);
    const feature = circulationFeatureForCell(frame, cell, circulationFeatures);
    const roadStatus = circulationStatus(feature);
    const holder = roadStatus === "reserved" ? feature?.reservedBy ?? null : landHolder(cell);
    const stateLabel = roadStatus === "road"
      ? "Public way"
      : roadStatus === "reserved"
        ? "Public-way reservation"
        : landCellState(cell) === "claimed"
          ? "Claim"
          : landCellState(cell) === "reserved"
            ? "Reservation"
            : roadStatus === "trace"
              ? "Travel trace"
              : "Available cell";
    option.textContent = `${stateLabel} ${cell.id}${
      holder === null ? "" : ` · person ${holder}`
    }`;
    ui.territoryParcelSelect.append(option);
  }
  ui.territoryParcelSelect.value = state.selectedLandId || "";
}

function renderTerritoryInspector(frame) {
  if (!territoryAvailable()) return;
  const land = frameLand(frame);
  const circulationFeatures = circulationFeaturesByLandId(frame);
  renderTerritoryOptions(land, frame, circulationFeatures);
  const cell = selectedLandCell(frame);
  const parcel = parcelForCell(land, cell);
  if (!cell) {
    ui.territoryCell.textContent = "—";
    ui.territoryTenure.textContent = "Choose a cell";
    ui.territoryHolder.textContent = "—";
    ui.territoryTiming.textContent = "—";
    ui.territoryArea.textContent = "—";
    ui.territoryCompactness.textContent = "—";
    ui.territoryFrontage.textContent = "—";
    ui.territoryCirculation.textContent = "—";
  } else {
    const tenure = landCellState(cell);
    const holder = landHolder(cell);
    ui.territoryCell.textContent = String(cell.id);
    ui.territoryTenure.textContent = `${tenure}${cell.contested ? " · contested" : ""}`;
    ui.territoryHolder.textContent = holder === null ? "—" : `person ${holder}`;
    ui.territoryTiming.textContent = tenure === "reserved"
      ? `claim t${cell.claimableAt ?? "—"} · expires t${cell.expiresAt ?? "—"}`
      : tenure === "claimed"
        ? `claimed t${cell.claimedAt ?? "—"}`
        : "available";
    ui.territoryArea.textContent = Number.isFinite(parcel?.area) ? `${Math.round(parcel.area)} u²` : "—";
    ui.territoryCompactness.textContent = Number.isFinite(parcel?.compactness)
      ? `${Math.round(parcel.compactness * 100)}%`
      : "—";
    const frontage = roadFrontage(frame, land, cell, parcel, circulationFeatures);
    ui.territoryFrontage.textContent = frontage === null
      ? "public-way cell"
      : frontage.edges > 0
        ? `${Math.round(frontage.length)} u · ${frontage.edges} edge${frontage.edges === 1 ? "" : "s"}`
        : "none";
    ui.territoryCirculation.textContent = circulationLabel(frame, cell, circulationFeatures);
  }

  const policy = land?.policy || {};
  const maturity = Number(policy.reservationTicks ?? policy.holdTicks);
  const expiry = Number(policy.expiryTicks ?? policy.reservationExpiryTicks);
  ui.territoryPolicy.textContent = `One active plot reservation per person · highest priority wins · seeded tie-breaks${
    Number.isFinite(maturity) ? ` · matures after ${maturity} ticks` : ""
  }${Number.isFinite(expiry) ? ` · expires after ${expiry} ticks` : ""} · settlement follows busy frontage · sustained blocked demand can open a public easement.`;
}

function boundedInteger(input, minimum, maximum, fallback) {
  const value = Math.round(Number(input.value));
  const bounded = Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
  input.value = String(bounded);
  return bounded;
}

function updateLayoutSettings() {
  state.layoutSettings = {
    rows: boundedInteger(ui.layoutGridRows, 2, 8, state.layoutSettings.rows),
    columns: boundedInteger(ui.layoutGridColumns, 2, 8, state.layoutSettings.columns),
    gap: boundedInteger(ui.layoutGridGap, 6, 60, state.layoutSettings.gap),
  };
  renderer.setLayoutTool(state.layoutTool, state.layoutSettings);
}

function setLayoutStatus(message, warning = false) {
  ui.layoutStatus.textContent = message;
  ui.layoutStatus.classList.toggle("is-warning", warning);
}

function setLayoutTool(tool) {
  const nextTool = ["inspect", "block", "grid", "gate", "erase"].includes(tool) ? tool : "inspect";
  state.layoutTool = nextTool;
  for (const button of ui.layoutTools) {
    const active = button.dataset.layoutTool === nextTool;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  ui.layoutGridOptions.disabled = nextTool !== "grid";
  updateLayoutSettings();
  updateCanvasInstruction();
}

function updateLayoutUi() {
  const available = editableLayoutAvailable();
  ui.layoutEditor.hidden = !available;
  ui.layoutUndo.disabled = state.layoutUndo.length === 0;
  ui.layoutClear.disabled = !available || (state.environment?.obstacles?.length ?? 0) === 0;
  ui.layoutRestore.disabled = !available;
  renderGateEditors();
  if (!available) setLayoutTool("inspect");
}

function rememberLayout() {
  state.layoutUndo.push(cloneEnvironment(state.environment));
  if (state.layoutUndo.length > MAX_LAYOUT_UNDO) state.layoutUndo.shift();
}

function nextObstaclePrefix() {
  const used = new Set((state.environment?.obstacles || []).map((obstacle) => String(obstacle.id)));
  let serial = 1;
  while (used.has(`layout-${serial}`) || [...used].some((id) => id.startsWith(`layout-${serial}-`))) serial += 1;
  return `layout-${serial}`;
}

function nextGateIdentity() {
  const destinations = state.environment?.destinations || [];
  const usedIds = new Set(destinations.map((destination) => String(destination.id)));
  const usedLabels = new Set(destinations.map((destination) => String(destination.label).toLocaleLowerCase()));
  let serial = 1;
  while (usedIds.has(`gate-${serial}`) || usedLabels.has(`gate ${serial}`)) serial += 1;
  return { id: `gate-${serial}`, label: `Gate ${serial}` };
}

function clampGateWeight(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(0, Math.min(10, Math.round(numeric)));
}

function destinationWeight(destination) {
  return clampGateWeight(destination?.weight ?? 1);
}

function renderGateEditors() {
  ui.gateList.replaceChildren();
  if (!editableLayoutAvailable()) return;
  for (const destination of state.environment?.destinations || []) {
    const row = document.createElement("div");
    row.className = "gate-row";

    const marker = document.createElement("span");
    marker.className = "gate-marker";
    marker.setAttribute("aria-hidden", "true");

    const label = document.createElement("label");
    label.className = "gate-field gate-label-field";
    const labelCaption = document.createElement("span");
    labelCaption.textContent = "Label";
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.maxLength = 28;
    labelInput.value = destination.label || String(destination.id);
    labelInput.setAttribute("aria-label", `Label for ${labelInput.value}`);
    labelInput.addEventListener("change", () => {
      const nextLabel = labelInput.value.trim() || destination.label || String(destination.id);
      updateDestination(destination.id, { label: nextLabel }, `Renamed gate to ${nextLabel}.`);
    });
    label.append(labelCaption, labelInput);

    const weight = document.createElement("label");
    weight.className = "gate-field gate-weight-field";
    const weightCaption = document.createElement("span");
    weightCaption.textContent = "Likelihood";
    const weightInput = document.createElement("input");
    weightInput.type = "number";
    weightInput.inputMode = "numeric";
    weightInput.min = "0";
    weightInput.max = "10";
    weightInput.step = "1";
    weightInput.value = String(destinationWeight(destination));
    weightInput.setAttribute("aria-label", `Likelihood for ${labelInput.value}, zero to ten`);
    weightInput.addEventListener("change", () => {
      const nextWeight = clampGateWeight(weightInput.value);
      weightInput.value = String(nextWeight);
      updateDestination(destination.id, { weight: nextWeight }, `${labelInput.value} likelihood set to ${nextWeight}.`);
    });
    weight.append(weightCaption, weightInput);

    const coordinates = document.createElement("span");
    coordinates.className = "gate-coordinates";
    coordinates.textContent = `${Math.round(destination.x)}, ${Math.round(destination.y)}`;
    coordinates.title = "Gate position in world units";

    row.append(marker, label, weight, coordinates);
    ui.gateList.append(row);
  }
}

function updateDestination(id, patch, message) {
  const environment = cloneEnvironment(state.environment);
  const destination = environment?.destinations?.find((candidate) => String(candidate.id) === String(id));
  if (!destination) {
    setLayoutStatus("That gate is no longer in the layout.", true);
    renderGateEditors();
    return;
  }
  const changed = Object.entries(patch).some(([key, value]) => destination[key] !== value);
  if (!changed) {
    renderGateEditors();
    return;
  }
  rememberLayout();
  Object.assign(destination, patch);
  commitLayout(environment, message);
}

function commitLayout(environment, message, warning = false) {
  state.environment = cloneEnvironment(environment);
  clearInterventionState();
  hideDiagnostic();
  postWorldMutation({
    type: "reconfigure",
    population: state.population,
    params: { ...state.params },
    environment: cloneEnvironment(state.environment),
  });
  updateLayoutUi();
  setLayoutStatus(message, warning);
}

function layoutConflict(blocks, ignoredIds = []) {
  return placementConflict(blocks, {
    obstacles: state.environment?.obstacles || [],
    destinations: state.environment?.destinations || [],
    destinationClearance: DESTINATION_CLEARANCE,
    minimumDestinationRadius: Number(state.environment?.journeys?.arrivalRadius) || 0,
    ignoreIds: ignoredIds,
  });
}

function describeConflict(conflict) {
  if (!conflict) return "That layout cannot be placed here.";
  if (conflict.type === "destination") return "Placement rejected: keep the destination gates clear.";
  if (conflict.type === "obstacle") return "Placement rejected: blocks may touch, but cannot overlap.";
  return "Placement rejected: choose a clear part of the walking ground.";
}

function findGatePlacementConflict(gate) {
  const arrivalRadius = Number(state.environment?.journeys?.arrivalRadius) || 0;
  return gatePlacementConflict(gate, {
    obstacles: state.environment?.obstacles || [],
    destinations: state.environment?.destinations || [],
    obstacleClearance: Math.max(0, arrivalRadius - gate.radius),
    minimumGateRadius: arrivalRadius,
  });
}

function handleLayoutGesture(detail = {}) {
  if (!editableLayoutAvailable() || !["block", "grid", "gate"].includes(detail.tool)) return;
  if (detail.tool === "gate") {
    const normalized = normalizeGate(detail, {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      defaultRadius: DEFAULT_GATE_RADIUS,
      minRadius: MIN_GATE_RADIUS,
      maxRadius: MAX_GATE_RADIUS,
    });
    if (!normalized) {
      setLayoutStatus("Gate placement rejected: choose a point inside the world.", true);
      return;
    }
    const identity = nextGateIdentity();
    const gate = {
      ...identity,
      ...normalized,
      weight: 1,
    };
    const conflict = findGatePlacementConflict(gate);
    if (conflict) {
      const message = conflict.type === "obstacle"
        ? "Gate placement rejected: gates cannot overlap a block."
        : "Gate placement rejected: leave space between the gates’ arrival zones.";
      setLayoutStatus(message, true);
      return;
    }
    rememberLayout();
    const environment = cloneEnvironment(state.environment);
    environment.destinations = [...(environment.destinations || []), gate];
    commitLayout(environment, `Added ${gate.label} with likelihood 1.`);
    return;
  }

  updateLayoutSettings();
  const isGrid = detail.tool === "grid";
  const bounds = normalizeLayoutRect(detail, {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    defaultWidth: isGrid ? 360 : 120,
    defaultHeight: isGrid ? 270 : 100,
    minSize: isGrid ? 60 : 24,
  });
  if (!bounds) {
    setLayoutStatus("Placement rejected: draw a larger area.", true);
    return;
  }

  const prefix = nextObstaclePrefix();
  const blocks = isGrid
    ? createBlockGrid(bounds, { ...state.layoutSettings, idPrefix: prefix })
    : [{ id: prefix, ...bounds, label: "" }];
  if (blocks.length === 0) {
    setLayoutStatus("Placement rejected: enlarge the area or reduce the grid density.", true);
    return;
  }
  const conflict = layoutConflict(blocks);
  if (conflict) {
    setLayoutStatus(describeConflict(conflict), true);
    return;
  }

  rememberLayout();
  const environment = cloneEnvironment(state.environment);
  environment.obstacles = [...(environment.obstacles || []), ...blocks];
  const narrowGrid = isGrid && state.layoutSettings.gap < 36;
  commitLayout(
    environment,
    isGrid
      ? narrowGrid
        ? `Added ${blocks.length} blocks · narrow streets may gridlock at this population.`
        : `Added ${blocks.length} blocks with ${state.layoutSettings.gap}-unit streets.`
      : "Added one block.",
    narrowGrid,
  );
}

function eraseObstacle(id) {
  if (!editableLayoutAvailable()) return;
  const obstacles = state.environment?.obstacles || [];
  const remaining = obstacles.filter((obstacle) => String(obstacle.id) !== String(id));
  if (remaining.length === obstacles.length) {
    setLayoutStatus("No block was removed.", true);
    return;
  }
  rememberLayout();
  const environment = cloneEnvironment(state.environment);
  environment.obstacles = remaining;
  commitLayout(environment, "Removed one block.");
}

function eraseDestination(id) {
  if (!editableLayoutAvailable()) return;
  const destinations = state.environment?.destinations || [];
  if (destinations.length <= MINIMUM_GATE_COUNT) {
    setLayoutStatus("Keep at least two gates so people still have a journey.", true);
    return;
  }
  const removed = destinations.find((destination) => String(destination.id) === String(id));
  if (!removed) {
    setLayoutStatus("No gate was removed.", true);
    return;
  }
  rememberLayout();
  const environment = cloneEnvironment(state.environment);
  environment.destinations = destinations.filter((destination) => String(destination.id) !== String(id));
  commitLayout(environment, `Removed ${removed.label || "one gate"}.`);
}

function handleEnvironmentErase(detail = {}) {
  if (detail.type === "destination") eraseDestination(detail.id);
  else if (detail.type === "obstacle") eraseObstacle(detail.id);
}

function undoLayout() {
  const previous = state.layoutUndo.pop();
  if (!previous) return;
  commitLayout(previous, "Undid the last layout edit.");
}

function clearLayout() {
  if (!editableLayoutAvailable() || (state.environment?.obstacles?.length ?? 0) === 0) return;
  rememberLayout();
  const environment = cloneEnvironment(state.environment);
  environment.obstacles = [];
  commitLayout(environment, "Cleared all blocks.");
}

function restoreLayout() {
  if (!editableLayoutAvailable()) return;
  const preset = cloneEnvironment(state.scenario.environment);
  if (JSON.stringify(preset) === JSON.stringify(state.environment)) {
    setLayoutStatus("The preset layout is already restored.");
    return;
  }
  rememberLayout();
  commitLayout(preset, "Restored the preset layout.");
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
    environment: cloneEnvironment(state.environment),
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
  renderTerritoryInspector(frame);
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
  if (definition.format === "area") return `${Math.round(value)} u²`;
  if (definition.format === "decimal-2") return Number(value).toFixed(2);
  return String(Math.round(value));
}

function drawMetricHistory() {
  if (state.metricHistory.length < 2) {
    ui.metricLine.setAttribute("points", "");
    return;
  }
  const domain = state.scenario.trend.domain;
  const minimum = Array.isArray(domain) ? Number(domain[0]) : Math.min(...state.metricHistory);
  const maximum = Array.isArray(domain) ? Number(domain[1]) : Math.max(...state.metricHistory);
  const range = Math.max(state.scenario.trend.minimumRange ?? 8, maximum - minimum);
  const points = state.metricHistory.map((value, index) => {
    const x = 2 + (index / Math.max(1, state.metricHistory.length - 1)) * 128;
    const y = 38 - ((value - minimum) / range) * 34;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  ui.metricLine.setAttribute("points", points.join(" "));
  const first = state.metricHistory[0];
  const current = state.metricHistory.at(-1);
  const trendDefinition = [state.scenario.metric, ...state.scenario.summaryMetrics]
    .find((definition) => definition.key === state.scenario.trend.key)
    || state.scenario.metric;
  ui.metricChart.setAttribute(
    "aria-label",
    `${state.scenario.trend.ariaLabel}: ${formatMetric(first, trendDefinition)} to ${formatMetric(current, trendDefinition)}.`,
  );
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
  const selectedCell = selectedLandCell(state.frame);
  const selectedCirculation = selectedCell
    ? circulationLabel(state.frame, selectedCell, circulationFeaturesByLandId(state.frame))
    : null;
  const selectedDestination = state.frame.environment?.destinations?.find(
    (destination) => destination.id === selected?.destinationId,
  );
  const selection = territoryAvailable() && selectedCell
    ? ` Selected land cell ${selectedCell.id} is ${landCellState(selectedCell)}${
      landHolder(selectedCell) === null ? "" : ` by person ${landHolder(selectedCell)}`
    }; circulation: ${selectedCirculation}.`
    : selected
      ? state.scenario.environment?.journeys?.enabled
      ? ` Selected person ${selected.id} is travelling toward ${
        selectedDestination?.label || selected.destinationId || "the opposite destination"
      }.`
        : state.scenario.relationMode !== "none"
          ? ` Selected person ${selected.id} follows people ${selected.chosen[0]} and ${selected.chosen[1]}.`
          : ` Selected person ${selected.id}.`
      : "";
  const configuredDelay = state.frame.configuredDelayTicks ?? state.frame.delayTicks ?? 0;
  const observationAge = state.frame.observationAge ?? state.frame.delayTicks ?? 0;
  const warmup = configuredDelay > observationAge ? `, currently ${observationAge} ticks of history` : "";
  const roadCells = state.frame.metrics.roadCells ?? state.frame.metrics.publicWayCells ?? 0;
  const roadReservedCells = state.frame.metrics.roadReservedCells
    ?? state.frame.metrics.roadReservations
    ?? 0;
  const activeMovementCells = state.frame.metrics.activeMovementCells ?? 0;
  const roadLandConflicts = state.frame.metrics.roadLandConflicts
    ?? state.frame.metrics.circulationConflicts
    ?? 0;
  const scenarioMeasurement = territoryAvailable()
    ? ` ${formatMetric(state.frame.metrics.claimedShare, { format: "fraction-percent" })} of land cells claimed; ${
      state.frame.metrics.reservedCells ?? 0
    } active reservations; ${state.frame.metrics.landConflicts ?? 0} resolved conflicts; ${
      state.frame.metrics.landOwners ?? 0
    } landholders; ${roadCells} public-way cells${roadReservedCells > 0 ? `, ${roadReservedCells} pending` : ""}; ${
      activeMovementCells
    } actively used route cells; ${
      roadLandConflicts
    } road/plot conflicts.`
    : state.scenario.environment?.field?.enabled
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
  } else if (editableLayoutAvailable() && state.layoutTool === "block") {
    ui.canvasInstruction.textContent = "Drag to draw a block · click for a default-sized block · Esc to inspect.";
  } else if (editableLayoutAvailable() && state.layoutTool === "grid") {
    ui.canvasInstruction.textContent = "Drag district bounds to fill with blocks and streets · Esc to inspect.";
  } else if (editableLayoutAvailable() && state.layoutTool === "gate") {
    ui.canvasInstruction.textContent = "Click to add a gate · drag outward to choose its size · Esc to inspect.";
  } else if (editableLayoutAvailable() && state.layoutTool === "erase") {
    ui.canvasInstruction.textContent = "Click a block or gate to erase it · at least two gates must remain.";
  } else if (state.perturbed) {
    ui.canvasInstruction.textContent = "Manual perturbation applied · reset to reproduce the seeded run.";
  } else if (territoryAvailable()) {
    ui.canvasInstruction.textContent = "Click a person or parcel to inspect · continuous traces become paths · pressure can open easements.";
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
        environment: cloneEnvironment(state.environment),
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
  state.environment = cloneEnvironment(scenario.environment);
  state.layoutUndo = [];
  state.layoutTool = "inspect";
  state.selectedLandId = null;
  state.territoryOptionsSignature = "";
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
  const hasLand = territoryAvailable(scenario);
  ui.legendSelfLabel.textContent = hasLand ? "trace → public way" : "selected";
  ui.legendAItem.hidden = !hasLand && !hasJourneys && !hasSocialRelations;
  ui.legendBItem.hidden = !hasLand && !hasJourneys && !hasSocialRelations;
  ui.legendCItem.hidden = !hasLand;
  ui.legendALabel.textContent = hasLand ? "reserved" : hasJourneys ? "destination" : "person A";
  ui.legendBLabel.textContent = hasLand ? "claimed" : hasJourneys ? "footfall" : "person B";
  ui.legendCLabel.textContent = hasLand ? "road / plot conflict" : "conflict";
  ui.territoryInspector.hidden = !hasLand;
  ui.trailsControl.hidden = hasLand;
  ui.relationsControl.hidden = hasLand;
  ui.landControl.hidden = !hasLand;
  ui.populationLabel.textContent = hasLand ? "Claimants" : "People";
  ui.editor.value = scenario.source;
  renderer.setScenario(scenario.relationMode, state.params);
  renderer.setSelectedLand?.(null);
  if (renderer.setTenureVisible) renderer.setTenureVisible(ui.land.checked);
  else renderer.setLandVisible?.(ui.land.checked);
  setLayoutTool("inspect");
  renderer.setSelected(0);
  updateLineNumbers();
  updateDirtyState();
  renderParameterControls();
  updateLayoutUi();
  setLayoutStatus(editableLayoutAvailable() ? "Preset layout" : "Layout editing unavailable");
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
  postWorldMutation({
    type: "reset",
    seed: state.seed,
    population: state.population,
    params: { ...state.params },
    environment: cloneEnvironment(state.environment),
  });
});
ui.newSeed.addEventListener("click", () => {
  state.seed = (state.seed + 7_919) % 100_000;
  clearInterventionState();
  postWorldMutation({
    type: "reset",
    seed: state.seed,
    population: state.population,
    params: { ...state.params },
    environment: cloneEnvironment(state.environment),
  });
});
ui.tempo.addEventListener("change", () => postToCurrentWorld({ type: "setTempo", tempo: Number(ui.tempo.value) }));
ui.population.addEventListener("input", () => {
  state.population = Number(ui.population.value);
  ui.populationValue.textContent = String(state.population);
});
ui.population.addEventListener("change", () => {
  clearInterventionState();
  postWorldMutation({
    type: "reconfigure",
    population: state.population,
    params: { ...state.params },
    environment: cloneEnvironment(state.environment),
  });
});
ui.trails.addEventListener("change", () => renderer.setTrails(ui.trails.checked));
ui.relations.addEventListener("change", () => renderer.setRelations(ui.relations.checked));
ui.land.addEventListener("change", () => {
  if (renderer.setTenureVisible) renderer.setTenureVisible(ui.land.checked);
  else renderer.setLandVisible?.(ui.land.checked);
});
ui.territoryParcelSelect.addEventListener("change", () => {
  handleLandSelection(ui.territoryParcelSelect.value || null);
});
for (const button of ui.layoutTools) {
  button.addEventListener("click", () => setLayoutTool(button.dataset.layoutTool));
}
for (const input of [ui.layoutGridRows, ui.layoutGridColumns, ui.layoutGridGap]) {
  input.addEventListener("input", updateLayoutSettings);
  input.addEventListener("change", updateLayoutSettings);
}
ui.layoutUndo.addEventListener("click", undoLayout);
ui.layoutClear.addEventListener("click", clearLayout);
ui.layoutRestore.addEventListener("click", restoreLayout);
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
  if (enabled) setLayoutTool("inspect");
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
  if (event.key === "Escape" && state.layoutTool !== "inspect") {
    setLayoutTool("inspect");
    setLayoutStatus("Inspect tool selected.");
    return;
  }

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
