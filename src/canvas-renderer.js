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
};

export class CanvasRenderer {
  constructor(canvas, { onSelect } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.onSelect = onSelect;
    this.frame = null;
    this.lastTick = -1;
    this.lastSeed = null;
    this.selectedId = 0;
    this.trailsEnabled = true;
    this.relationsEnabled = true;
    this.relationMode = "midpoint";
    this.params = {};
    this.trails = new Map();
    this.viewport = { scale: 1, offsetX: 0, offsetY: 0, cssWidth: 0, cssHeight: 0 };

    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(canvas.parentElement);
    canvas.addEventListener("pointerdown", (event) => this.#handlePointer(event));
  }

  setScenario(relationMode, params) {
    this.relationMode = relationMode;
    this.params = { ...params };
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

  update(frame) {
    const reset = frame.tick === 0 || frame.seed !== this.lastSeed || frame.tick < this.lastTick;
    if (reset) this.trails.clear();

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

  #calculateViewport(cssWidth, cssHeight) {
    const worldWidth = this.frame?.width || 1_000;
    const worldHeight = this.frame?.height || 650;
    const padding = 8;
    const scale = Math.min((cssWidth - padding * 2) / worldWidth, (cssHeight - padding * 2) / worldHeight);
    return {
      scale,
      offsetX: (cssWidth - worldWidth * scale) / 2,
      offsetY: (cssHeight - worldHeight * scale) / 2,
      cssWidth,
      cssHeight,
    };
  }

  draw() {
    const { width: cssWidth, height: cssHeight } = this.#resizeBackingStore();
    const context = this.context;
    this.viewport = this.#calculateViewport(cssWidth, cssHeight);

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
    this.#drawGrid(context);
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

  #drawRelations(context) {
    const self = this.frame.agents.find((agent) => agent.id === this.selectedId);
    if (!self) return;
    const first = this.frame.agents[self.chosen[0]];
    const second = this.frame.agents[self.chosen[1]];
    if (!first || !second) return;

    const width = 1.3 / this.viewport.scale;
    context.save();
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
    context.strokeStyle = "rgba(232, 238, 251, 0.18)";
    context.lineWidth = 0.8 / this.viewport.scale;
    context.beginPath();
    context.moveTo(first.x, first.y);
    context.lineTo(second.x, second.y);
    context.stroke();

    const target = this.#relationshipTarget(self, first, second);
    if (target) this.#drawTarget(context, target);
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
    return null;
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
    const selected = this.frame.agents.find((agent) => agent.id === this.selectedId);
    const firstId = selected?.chosen[0];
    const secondId = selected?.chosen[1];

    for (const agent of this.frame.agents) {
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
      const first = this.frame.agents[firstId];
      const second = this.frame.agents[secondId];
      this.#drawLabel(context, selected, "YOU", COLORS.selected);
      if (first) this.#drawLabel(context, first, "A", COLORS.personA);
      if (second) this.#drawLabel(context, second, "B", COLORS.personB);
    }
  }

  #drawLabel(context, agent, text, color) {
    const fontSize = 9 / this.viewport.scale;
    const offset = (agent.radius + 10 / this.viewport.scale);
    context.save();
    context.font = `700 ${fontSize}px ui-monospace, monospace`;
    context.textAlign = "center";
    context.textBaseline = "bottom";
    context.fillStyle = color;
    context.fillText(text, agent.x, agent.y - offset);
    context.restore();
  }

  #handlePointer(event) {
    if (!this.frame) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left - this.viewport.offsetX) / this.viewport.scale;
    const y = (event.clientY - rect.top - this.viewport.offsetY) / this.viewport.scale;
    let nearest = null;
    let distance = Infinity;

    for (const agent of this.frame.agents) {
      const candidate = Math.hypot(agent.x - x, agent.y - y);
      if (candidate < distance) {
        distance = candidate;
        nearest = agent;
      }
    }

    if (nearest && distance * this.viewport.scale < 34) {
      this.selectedId = nearest.id;
      this.onSelect?.(nearest.id);
      this.draw();
    }
  }
}
