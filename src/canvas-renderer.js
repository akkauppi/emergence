import { clampWorldPoint, equilateralApex, nearestEquilateralApex } from "./simulation/geometry.js";

const COLORS = {
  background: "#142137",
  grid: "rgba(194, 209, 239, 0.055)",
  gridStrong: "rgba(194, 209, 239, 0.085)",
  agent: "#d9e4ff",
  agentCore: "#7291e7",
  selected: "#f27a50",
  personA: "#91a9ff",
  personB: "#f3c35c",
  target: "#f4ede0",
  destination: "#70d6b5",
  obstacle: "#0c1728",
};

const DRAG_THRESHOLD_CSS_PIXELS = 6;
const MAX_FIELD_CELLS = 4_194_304;

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeFieldValue(value, maxValue) {
  const numericValue = finiteNumber(value, 0);
  const numericMaximum = finiteNumber(maxValue, 0);
  if (numericValue <= 0 || numericMaximum <= 0) return 0;
  return Math.min(1, numericValue / numericMaximum);
}

function writeScalarFieldColor(target, offset, value, maxValue) {
  const normalized = normalizeFieldValue(value, maxValue);
  if (normalized === 0) {
    target[offset] = 0;
    target[offset + 1] = 0;
    target[offset + 2] = 0;
    target[offset + 3] = 0;
    return;
  }

  // A perceptual lift keeps faint, early paths visible without letting hot cells
  // obscure the agents that move across them.
  const intensity = Math.sqrt(normalized);
  target[offset] = Math.round(67 + (245 - 67) * intensity);
  target[offset + 1] = Math.round(142 + (184 - 142) * intensity);
  target[offset + 2] = Math.round(186 + (82 - 186) * intensity);
  target[offset + 3] = Math.round(18 + 142 * intensity);
}

export function scalarFieldColor(value, maxValue) {
  const color = [0, 0, 0, 0];
  writeScalarFieldColor(color, 0, value, maxValue);
  return color;
}

export function resolveObstacleRect(obstacle) {
  if (!obstacle || typeof obstacle !== "object") return null;
  const width = finiteNumber(obstacle.width ?? obstacle.w ?? obstacle.size?.width);
  const height = finiteNumber(obstacle.height ?? obstacle.h ?? obstacle.size?.height);
  if (width === null || height === null || width <= 0 || height <= 0) return null;

  const explicitX = finiteNumber(obstacle.x ?? obstacle.position?.x);
  const explicitY = finiteNumber(obstacle.y ?? obstacle.position?.y);
  const centreX = finiteNumber(obstacle.centerX ?? obstacle.centreX);
  const centreY = finiteNumber(obstacle.centerY ?? obstacle.centreY);
  const x = explicitX ?? (centreX === null ? null : centreX - width / 2);
  const y = explicitY ?? (centreY === null ? null : centreY - height / 2);
  if (x === null || y === null) return null;
  return { x, y, width, height };
}

export function resolveDestination(destination) {
  if (!destination || typeof destination !== "object") return null;
  const x = finiteNumber(destination.x ?? destination.position?.x);
  const y = finiteNumber(destination.y ?? destination.position?.y);
  if (x === null || y === null) return null;
  return {
    x,
    y,
    radius: Math.max(1, finiteNumber(destination.radius ?? destination.r, 18)),
  };
}

export function resolveScalarField(frame) {
  const field = frame?.field ?? frame?.environment?.field;
  if (!field || typeof field !== "object") return null;
  const columns = Math.floor(finiteNumber(field.columns ?? field.cols ?? field.width, 0));
  const rows = Math.floor(finiteNumber(field.rows ?? field.height, 0));
  const values = field.values ?? field.data;
  const cellCount = columns * rows;
  if (
    columns <= 0
    || rows <= 0
    || cellCount > MAX_FIELD_CELLS
    || !values
    || typeof values.length !== "number"
    || values.length < cellCount
  ) return null;

  let maxValue = finiteNumber(field.maxValue ?? field.max ?? field.maximum, 0);
  if (maxValue <= 0) {
    maxValue = 0;
    for (let index = 0; index < cellCount; index += 1) {
      maxValue = Math.max(maxValue, finiteNumber(values[index], 0));
    }
  }
  return { field, columns, rows, values, cellCount, maxValue };
}

export function calculateViewport(cssWidth, cssHeight, worldWidth = 1_000, worldHeight = 650, padding = 8) {
  const availableWidth = Math.max(1, cssWidth - padding * 2);
  const availableHeight = Math.max(1, cssHeight - padding * 2);
  const scale = Math.max(0.0001, Math.min(availableWidth / worldWidth, availableHeight / worldHeight));
  return {
    scale,
    offsetX: (cssWidth - worldWidth * scale) / 2,
    offsetY: (cssHeight - worldHeight * scale) / 2,
    cssWidth,
    cssHeight,
  };
}

export function clientToWorld(clientX, clientY, rect, viewport) {
  return {
    x: (clientX - rect.left - viewport.offsetX) / viewport.scale,
    y: (clientY - rect.top - viewport.offsetY) / viewport.scale,
  };
}

export class CanvasRenderer {
  constructor(canvas, { onSelect, onDragStart, onPerturb, onDragCancel } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.onSelect = onSelect;
    this.onDragStart = onDragStart;
    this.onPerturb = onPerturb;
    this.onDragCancel = onDragCancel;
    this.frame = null;
    this.lastTick = -1;
    this.lastSeed = null;
    this.lastEventCursor = 0;
    this.selectedId = 0;
    this.trailsEnabled = true;
    this.relationsEnabled = true;
    this.relationMode = "midpoint";
    this.params = {};
    this.trails = new Map();
    this.drag = null;
    this.pendingPerturbation = null;
    this.fieldCache = null;
    this.viewport = { scale: 1, offsetX: 0, offsetY: 0, cssWidth: 0, cssHeight: 0 };

    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", (event) => this.#handlePointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.#handlePointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.#handlePointerUp(event));
    canvas.addEventListener("pointercancel", (event) => this.#handlePointerCancel(event));
    canvas.addEventListener("pointerleave", () => {
      if (!this.drag) canvas.style.cursor = "default";
    });
  }

  setScenario(relationMode, params) {
    this.relationMode = relationMode;
    this.params = { ...params };
    this.cancelPerturbationPreview();
    this.draw();
  }

  setSelected(id) {
    this.selectedId = id;
    this.draw();
  }

  setTrails(enabled) {
    this.trailsEnabled = enabled;
    if (!enabled) this.trails.clear();
    this.draw();
  }

  setRelations(enabled) {
    this.relationsEnabled = enabled;
    this.draw();
  }

  cancelPerturbationPreview() {
    this.drag = null;
    this.pendingPerturbation = null;
    this.canvas.style.cursor = "default";
    this.draw();
  }

  update(frame) {
    const reset = frame.tick === 0 || frame.seed !== this.lastSeed || frame.tick < this.lastTick;
    if (reset) this.trails.clear();

    if (frame.eventCursor !== this.lastEventCursor && frame.lastIntervention) {
      const moved = frame.agents.find((agent) => agent.id === frame.lastIntervention.agentId);
      if (moved) this.trails.set(moved.id, [{ x: moved.x, y: moved.y }]);
      this.pendingPerturbation = null;
    }

    if (this.trailsEnabled && frame.tick !== this.lastTick) {
      for (const agent of frame.agents) {
        const trail = this.trails.get(agent.id) || [];
        trail.push({ x: agent.x, y: agent.y });
        if (trail.length > 38) trail.shift();
        this.trails.set(agent.id, trail);
      }
    }

    this.frame = frame;
    this.lastTick = frame.tick;
    this.lastSeed = frame.seed;
    this.lastEventCursor = frame.eventCursor || 0;
    if (!frame.agents.some((agent) => agent.id === this.selectedId)) this.selectedId = 0;
    this.draw();
  }

  #resizeBackingStore() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width: rect.width, height: rect.height };
  }

  #refreshViewport(rect = this.canvas.getBoundingClientRect()) {
    this.viewport = calculateViewport(
      rect.width,
      rect.height,
      this.frame?.width || 1_000,
      this.frame?.height || 650,
    );
    return this.viewport;
  }

  draw() {
    const { width: cssWidth, height: cssHeight } = this.#resizeBackingStore();
    const context = this.context;
    this.viewport = calculateViewport(
      cssWidth,
      cssHeight,
      this.frame?.width || 1_000,
      this.frame?.height || 650,
    );

    const gradient = context.createRadialGradient(
      cssWidth * 0.48,
      cssHeight * 0.44,
      0,
      cssWidth * 0.48,
      cssHeight * 0.44,
      Math.max(cssWidth, cssHeight) * 0.76,
    );
    gradient.addColorStop(0, "#1a2b47");
    gradient.addColorStop(1, COLORS.background);
    context.fillStyle = gradient;
    context.fillRect(0, 0, cssWidth, cssHeight);

    if (!this.frame) return;

    context.save();
    context.translate(this.viewport.offsetX, this.viewport.offsetY);
    context.scale(this.viewport.scale, this.viewport.scale);
    this.#drawScalarField(context);
    this.#drawGrid(context);
    this.#drawEnvironment(context);
    this.#drawTrails(context);
    if (this.relationsEnabled) this.#drawRelations(context);
    this.#drawAgents(context);
    context.restore();
  }

  #drawGrid(context) {
    const { width, height } = this.frame;
    const thin = 1 / this.viewport.scale;
    context.lineWidth = thin;

    for (let x = 0; x <= width; x += 50) {
      context.strokeStyle = x % 200 === 0 ? COLORS.gridStrong : COLORS.grid;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
    for (let y = 0; y <= height; y += 50) {
      context.strokeStyle = y % 200 === 0 ? COLORS.gridStrong : COLORS.grid;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }

    context.strokeStyle = "rgba(226, 235, 255, 0.14)";
    context.lineWidth = thin * 1.4;
    context.strokeRect(0, 0, width, height);
  }

  #createFieldSurface(columns, rows) {
    let surface = null;
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
      surface = document.createElement("canvas");
      surface.width = columns;
      surface.height = rows;
    } else if (typeof OffscreenCanvas !== "undefined") {
      surface = new OffscreenCanvas(columns, rows);
    }
    if (!surface) return null;
    const context = surface.getContext("2d", { alpha: true });
    return context ? { surface, context } : null;
  }

  #drawScalarField(context) {
    const descriptor = resolveScalarField(this.frame);
    if (!descriptor) {
      this.fieldCache = null;
      return;
    }

    const { field, columns, rows, values, cellCount, maxValue } = descriptor;
    const reusable = this.fieldCache
      && this.fieldCache.columns === columns
      && this.fieldCache.rows === rows;
    const cache = reusable ? this.fieldCache : this.#createFieldSurface(columns, rows);
    if (!cache) return;

    if (cache.frame !== this.frame || cache.field !== field) {
      const image = cache.image || cache.context.createImageData(columns, rows);
      for (let index = 0; index < cellCount; index += 1) {
        writeScalarFieldColor(image.data, index * 4, values[index], maxValue);
      }
      cache.context.clearRect(0, 0, columns, rows);
      cache.context.putImageData(image, 0, 0);
      cache.frame = this.frame;
      cache.field = field;
      cache.columns = columns;
      cache.rows = rows;
      cache.image = image;
      this.fieldCache = cache;
    }

    context.save();
    context.imageSmoothingEnabled = true;
    context.drawImage(cache.surface, 0, 0, this.frame.width, this.frame.height);
    context.restore();
  }

  #drawEnvironment(context) {
    const environment = this.frame.environment;
    if (!environment || typeof environment !== "object") return;

    const obstacles = Array.isArray(environment.obstacles) ? environment.obstacles : [];
    const destinations = Array.isArray(environment.destinations) ? environment.destinations : [];
    const hairline = 1 / this.viewport.scale;

    for (const obstacle of obstacles) {
      const rect = resolveObstacleRect(obstacle);
      if (!rect) continue;
      context.save();
      context.fillStyle = COLORS.obstacle;
      context.strokeStyle = "rgba(242, 122, 80, 0.72)";
      context.lineWidth = hairline * 1.4;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
      context.strokeRect(rect.x, rect.y, rect.width, rect.height);
      context.beginPath();
      context.moveTo(rect.x, rect.y);
      context.lineTo(rect.x + rect.width, rect.y + rect.height);
      context.moveTo(rect.x + rect.width, rect.y);
      context.lineTo(rect.x, rect.y + rect.height);
      context.globalAlpha = 0.32;
      context.stroke();
      context.restore();
      this.#drawEnvironmentLabel(
        context,
        obstacle.label ?? obstacle.name,
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        "rgba(245, 187, 167, 0.88)",
      );
    }

    for (const destination of destinations) {
      const node = resolveDestination(destination);
      if (!node) continue;
      context.save();
      const halo = context.createRadialGradient(node.x, node.y, 0, node.x, node.y, node.radius * 1.7);
      halo.addColorStop(0, "rgba(112, 214, 181, 0.36)");
      halo.addColorStop(0.5, "rgba(112, 214, 181, 0.13)");
      halo.addColorStop(1, "rgba(112, 214, 181, 0)");
      context.fillStyle = halo;
      context.beginPath();
      context.arc(node.x, node.y, node.radius * 1.7, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "rgba(20, 52, 57, 0.9)";
      context.strokeStyle = COLORS.destination;
      context.lineWidth = hairline * 1.7;
      context.beginPath();
      context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.beginPath();
      context.moveTo(node.x - node.radius * 0.42, node.y);
      context.lineTo(node.x + node.radius * 0.42, node.y);
      context.moveTo(node.x, node.y - node.radius * 0.42);
      context.lineTo(node.x, node.y + node.radius * 0.42);
      context.stroke();
      context.restore();
      this.#drawEnvironmentLabel(
        context,
        destination.label ?? destination.name,
        node.x,
        node.y - node.radius - 8 / this.viewport.scale,
        COLORS.destination,
      );
    }
  }

  #drawEnvironmentLabel(context, label, x, y, color) {
    if (label === undefined || label === null || label === "") return;
    context.save();
    context.font = `700 ${8 / this.viewport.scale}px ui-monospace, monospace`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = color;
    context.fillText(String(label), x, y);
    context.restore();
  }

  #drawTrails(context) {
    if (!this.trailsEnabled) return;
    const normalWidth = 0.85 / this.viewport.scale;
    const selectedWidth = 1.65 / this.viewport.scale;

    for (const [id, trail] of this.trails) {
      if (trail.length < 2) continue;
      context.beginPath();
      trail.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.strokeStyle = id === this.selectedId ? "rgba(242, 122, 80, 0.5)" : "rgba(115, 146, 229, 0.16)";
      context.lineWidth = id === this.selectedId ? selectedWidth : normalWidth;
      context.stroke();
    }
  }

  #agentById(id, collection = this.frame.agents) {
    return collection.find((agent) => agent.id === id);
  }

  #displayAgent(agent) {
    const preview = this.drag?.active && this.drag.agentId === agent.id
      ? this.drag.position
      : this.pendingPerturbation?.agentId === agent.id
        ? this.pendingPerturbation.position
        : null;
    return preview ? { ...agent, x: preview.x, y: preview.y, vx: 0, vy: 0 } : agent;
  }

  #drawRelations(context) {
    const canonicalSelf = this.#agentById(this.selectedId);
    if (!canonicalSelf) return;
    const self = this.#displayAgent(canonicalSelf);

    if (this.relationMode === "none") {
      const destination = (this.frame.environment?.destinations || [])
        .find((candidate) => candidate.id === canonicalSelf.destinationId);
      const target = resolveDestination(destination);
      if (!target) return;
      context.save();
      context.setLineDash([5 / this.viewport.scale, 6 / this.viewport.scale]);
      context.lineWidth = 1.35 / this.viewport.scale;
      context.strokeStyle = "rgba(112, 214, 181, 0.62)";
      context.beginPath();
      context.moveTo(self.x, self.y);
      context.lineTo(target.x, target.y);
      context.stroke();
      context.restore();
      return;
    }

    const currentFirst = this.#agentById(canonicalSelf.chosen[0]);
    const currentSecond = this.#agentById(canonicalSelf.chosen[1]);
    if (!currentFirst || !currentSecond) return;

    const observed = this.frame.observedAgents || this.frame.agents;
    const firstObservation = this.#agentById(currentFirst.id, observed) || currentFirst;
    const secondObservation = this.#agentById(currentSecond.id, observed) || currentSecond;
    const first = { ...currentFirst, x: firstObservation.x, y: firstObservation.y };
    const second = { ...currentSecond, x: secondObservation.x, y: secondObservation.y };
    const target = this.#relationshipTarget(self, first, second);
    const width = 1.3 / this.viewport.scale;

    context.save();
    const observationAge = this.frame.observationAge ?? this.frame.delayTicks ?? 0;
    if (observationAge > 0) {
      this.#drawObservationGhost(context, currentFirst, first, COLORS.personA, "A");
      this.#drawObservationGhost(context, currentSecond, second, COLORS.personB, "B");
    }

    if (target && (this.relationMode === "equilateral" || this.relationMode === "equilateral-nearest")) {
      context.fillStyle = "rgba(244, 237, 224, 0.035)";
      context.strokeStyle = "rgba(244, 237, 224, 0.24)";
      context.lineWidth = 1 / this.viewport.scale;
      context.beginPath();
      context.moveTo(first.x, first.y);
      context.lineTo(second.x, second.y);
      context.lineTo(target.x, target.y);
      context.closePath();
      context.fill();
      context.stroke();
    }

    context.setLineDash([5 / this.viewport.scale, 5 / this.viewport.scale]);
    context.lineWidth = width;
    context.strokeStyle = "rgba(145, 169, 255, 0.55)";
    context.beginPath();
    context.moveTo(self.x, self.y);
    context.lineTo(first.x, first.y);
    context.stroke();

    context.strokeStyle = "rgba(243, 195, 92, 0.58)";
    context.beginPath();
    context.moveTo(self.x, self.y);
    context.lineTo(second.x, second.y);
    context.stroke();

    context.setLineDash([]);
    context.strokeStyle = "rgba(232, 238, 251, 0.24)";
    context.lineWidth = 0.9 / this.viewport.scale;
    context.beginPath();
    context.moveTo(first.x, first.y);
    context.lineTo(second.x, second.y);
    context.stroke();

    if (this.relationMode === "equilateral") this.#drawDirectionArrow(context, first, second);
    if (target) this.#drawTarget(context, target);
    context.restore();
  }

  #drawObservationGhost(context, current, historical, color, label) {
    const moved = Math.hypot(current.x - historical.x, current.y - historical.y);
    if (moved < 1) return;
    context.save();
    context.setLineDash([3 / this.viewport.scale, 4 / this.viewport.scale]);
    context.strokeStyle = color;
    context.globalAlpha = 0.24;
    context.lineWidth = 0.8 / this.viewport.scale;
    context.beginPath();
    context.moveTo(current.x, current.y);
    context.lineTo(historical.x, historical.y);
    context.stroke();
    context.setLineDash([]);
    context.strokeStyle = color;
    context.globalAlpha = 0.52;
    context.beginPath();
    context.arc(historical.x, historical.y, current.radius * 1.08, 0, Math.PI * 2);
    context.stroke();
    context.font = `700 ${8 / this.viewport.scale}px ui-monospace, monospace`;
    context.textAlign = "center";
    context.fillStyle = color;
    const observationAge = this.frame.observationAge ?? this.frame.delayTicks ?? 0;
    context.fillText(`${label} · t−${observationAge}`, historical.x, historical.y - current.radius - 7 / this.viewport.scale);
    context.restore();
  }

  #relationshipTarget(self, first, second) {
    if (this.relationMode === "midpoint") {
      return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    }
    if (this.relationMode === "shield") {
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      const extension = Number(this.params.extension) || 1;
      return { x: second.x + dx * extension, y: second.y + dy * extension };
    }
    if (this.relationMode === "bisector") {
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      const length = Math.hypot(dx, dy) || 1;
      const axis = { x: dx / length, y: dy / length };
      const offset = { x: self.x - midpoint.x, y: self.y - midpoint.y };
      const projection = offset.x * axis.x + offset.y * axis.y;
      return { x: self.x - axis.x * projection, y: self.y - axis.y * projection };
    }
    if (this.relationMode === "equilateral-nearest") {
      return nearestEquilateralApex(self, first, second, self.id % 2 === 0 ? 1 : -1);
    }
    if (this.relationMode === "equilateral") {
      return equilateralApex(first, second, this.params.chirality);
    }
    return null;
  }

  #drawDirectionArrow(context, first, second) {
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) return;
    const unitX = dx / length;
    const unitY = dy / length;
    const centreX = (first.x + second.x) / 2;
    const centreY = (first.y + second.y) / 2;
    const size = 7 / this.viewport.scale;
    context.fillStyle = "rgba(244, 237, 224, 0.76)";
    context.beginPath();
    context.moveTo(centreX + unitX * size, centreY + unitY * size);
    context.lineTo(centreX - unitX * size - unitY * size * 0.65, centreY - unitY * size + unitX * size * 0.65);
    context.lineTo(centreX - unitX * size + unitY * size * 0.65, centreY - unitY * size - unitX * size * 0.65);
    context.closePath();
    context.fill();
  }

  #drawTarget(context, target) {
    const radius = 8 / this.viewport.scale;
    context.strokeStyle = "rgba(244, 237, 224, 0.8)";
    context.lineWidth = 1.25 / this.viewport.scale;
    context.beginPath();
    context.arc(target.x, target.y, radius, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.moveTo(target.x - radius * 0.45, target.y);
    context.lineTo(target.x + radius * 0.45, target.y);
    context.moveTo(target.x, target.y - radius * 0.45);
    context.lineTo(target.x, target.y + radius * 0.45);
    context.stroke();
  }

  #drawAgents(context) {
    const canonicalSelected = this.#agentById(this.selectedId);
    const selected = canonicalSelected ? this.#displayAgent(canonicalSelected) : null;
    const hasSocialRelations = this.relationMode !== "none";
    const firstId = hasSocialRelations ? canonicalSelected?.chosen[0] : null;
    const secondId = hasSocialRelations ? canonicalSelected?.chosen[1] : null;

    for (const canonicalAgent of this.frame.agents) {
      const agent = this.#displayAgent(canonicalAgent);
      let outer = COLORS.agent;
      let core = COLORS.agentCore;
      if (agent.id === firstId) {
        outer = COLORS.personA;
        core = "#4969c6";
      }
      if (agent.id === secondId) {
        outer = COLORS.personB;
        core = "#aa7621";
      }
      if (agent.id === this.selectedId) {
        outer = COLORS.selected;
        core = "#a43e25";
      }

      context.save();
      context.translate(agent.x, agent.y);
      context.rotate(agent.angle);

      if (agent.id === this.selectedId) {
        context.fillStyle = "rgba(242, 122, 80, 0.14)";
        context.beginPath();
        context.arc(0, 0, agent.radius * 2.25, 0, Math.PI * 2);
        context.fill();
      }

      context.fillStyle = outer;
      context.beginPath();
      context.arc(0, 0, agent.radius, 0, Math.PI * 2);
      context.fill();

      context.fillStyle = core;
      context.beginPath();
      context.moveTo(agent.radius * 1.45, 0);
      context.lineTo(agent.radius * 0.25, -agent.radius * 0.44);
      context.lineTo(agent.radius * 0.25, agent.radius * 0.44);
      context.closePath();
      context.fill();
      context.restore();
    }

    if (selected) {
      const first = this.#agentById(firstId);
      const second = this.#agentById(secondId);
      this.#drawLabel(context, selected, "YOU", COLORS.selected);
      if (first) this.#drawLabel(context, first, "A", COLORS.personA);
      if (second) this.#drawLabel(context, second, "B", COLORS.personB);
    }
  }

  #drawLabel(context, agent, text, color) {
    const fontSize = 9 / this.viewport.scale;
    const offset = agent.radius + 10 / this.viewport.scale;
    context.save();
    context.font = `700 ${fontSize}px ui-monospace, monospace`;
    context.textAlign = "center";
    context.textBaseline = "bottom";
    context.fillStyle = color;
    context.fillText(text, agent.x, agent.y - offset);
    context.restore();
  }

  #eventPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    const viewport = this.#refreshViewport(rect);
    return clientToWorld(event.clientX, event.clientY, rect, viewport);
  }

  #hitTest(point) {
    let nearest = null;
    let distance = Infinity;
    for (const canonicalAgent of this.frame?.agents || []) {
      const agent = this.#displayAgent(canonicalAgent);
      const candidate = Math.hypot(agent.x - point.x, agent.y - point.y);
      if (candidate < distance) {
        distance = candidate;
        nearest = agent;
      }
    }
    return nearest && distance * this.viewport.scale < 34 ? nearest : null;
  }

  #handlePointerDown(event) {
    if (!this.frame || this.pendingPerturbation || (event.pointerType === "mouse" && event.button !== 0)) return;
    const point = this.#eventPoint(event);
    const agent = this.#hitTest(point);
    if (!agent) return;

    event.preventDefault();
    this.selectedId = agent.id;
    this.onSelect?.(agent.id);
    this.drag = {
      pointerId: event.pointerId,
      agentId: agent.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      position: { x: agent.x, y: agent.y },
      active: false,
    };
    try {
      this.canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic or already-cancelled pointers may not be capturable.
    }
    this.canvas.style.cursor = "grabbing";
    this.draw();
  }

  #handlePointerMove(event) {
    if (!this.frame) return;
    if (!this.drag || this.drag.pointerId !== event.pointerId) {
      const hovered = this.#hitTest(this.#eventPoint(event));
      this.canvas.style.cursor = hovered ? "grab" : "default";
      return;
    }

    event.preventDefault();
    const movement = Math.hypot(event.clientX - this.drag.startClientX, event.clientY - this.drag.startClientY);
    if (!this.drag.active && movement >= DRAG_THRESHOLD_CSS_PIXELS) {
      this.drag.active = true;
      this.onDragStart?.(this.drag.agentId);
    }
    if (!this.drag.active) return;

    const agent = this.#agentById(this.drag.agentId);
    if (!agent) return;
    this.drag.position = clampWorldPoint(this.#eventPoint(event), agent.radius, this.frame.width, this.frame.height);
    this.draw();
  }

  #handlePointerUp(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (this.drag.active) {
      this.pendingPerturbation = {
        agentId: this.drag.agentId,
        position: { ...this.drag.position },
        fromEventCursor: this.frame?.eventCursor || 0,
      };
      this.onPerturb?.(this.drag.agentId, { ...this.drag.position });
    }
    this.#finishPointer(event.pointerId);
    this.draw();
  }

  #handlePointerCancel(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    const wasActive = this.drag.active;
    this.#finishPointer(event.pointerId);
    if (wasActive) this.onDragCancel?.();
    this.draw();
  }

  #finishPointer(pointerId) {
    try {
      if (this.canvas.hasPointerCapture?.(pointerId)) this.canvas.releasePointerCapture(pointerId);
    } catch {
      // The browser may release capture before pointercancel is delivered.
    }
    this.drag = null;
    this.canvas.style.cursor = "grab";
  }
}
