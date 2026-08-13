import assert from "node:assert/strict";
import test from "node:test";

import {
  CanvasRenderer,
  calculateViewport,
  clientToWorld,
  normalizeFieldValue,
  resolveDestination,
  resolveObstacleRect,
  resolveScalarField,
  scalarFieldColor,
} from "../src/canvas-renderer.js";

function createRendererHarness(callbacks = {}) {
  const listeners = new Map();
  const gradient = { addColorStop() {} };
  const context = new Proxy({}, {
    get(target, property) {
      if (property === "createRadialGradient") return () => gradient;
      if (!(property in target)) target[property] = () => {};
      return target[property];
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  });
  const captured = new Set();
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    parentElement: {},
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1_016, height: 666 }),
    addEventListener: (type, listener) => listeners.set(type, listener),
    setPointerCapture: (id) => captured.add(id),
    hasPointerCapture: (id) => captured.has(id),
    releasePointerCapture: (id) => captured.delete(id),
  };
  const originalWindow = globalThis.window;
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.ResizeObserver = class {
    observe() {}
  };
  const renderer = new CanvasRenderer(canvas, callbacks);
  renderer.update({
    width: 1_000,
    height: 650,
    tick: 0,
    seed: 1,
    eventCursor: 0,
    agents: [{ id: 0, x: 100, y: 100, vx: 0, vy: 0, angle: 0, radius: 7, chosen: [] }],
    environment: {
      obstacles: [{ id: "market", x: 300, y: 200, width: 100, height: 80 }],
      destinations: [{ id: "west-gate", x: 700, y: 300, radius: 34 }],
    },
  });
  return {
    renderer,
    canvas,
    dispatch(type, properties) {
      listeners.get(type)?.({
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        preventDefault() {},
        ...properties,
      });
    },
    restore() {
      globalThis.window = originalWindow;
      globalThis.ResizeObserver = originalResizeObserver;
    },
  };
}

test("client coordinates map through a landscape letterbox without DPR scaling", () => {
  const rect = { left: 37, top: 19, width: 1_200, height: 800 };
  const viewport = calculateViewport(rect.width, rect.height, 1_000, 650);
  const expected = { x: 413.25, y: 287.5 };
  const clientX = rect.left + viewport.offsetX + expected.x * viewport.scale;
  const clientY = rect.top + viewport.offsetY + expected.y * viewport.scale;

  const result = clientToWorld(clientX, clientY, rect, viewport);
  assert.ok(Math.abs(result.x - expected.x) < 1e-9);
  assert.ok(Math.abs(result.y - expected.y) < 1e-9);
  assert.equal(viewport.offsetX, 8);
  assert.ok(viewport.offsetY > 8);
});

test("portrait letterboxing maps the world corners correctly", () => {
  const rect = { left: 11, top: 23, width: 400, height: 700 };
  const viewport = calculateViewport(rect.width, rect.height, 1_000, 650);
  const topLeft = clientToWorld(
    rect.left + viewport.offsetX,
    rect.top + viewport.offsetY,
    rect,
    viewport,
  );
  const bottomRight = clientToWorld(
    rect.left + viewport.offsetX + 1_000 * viewport.scale,
    rect.top + viewport.offsetY + 650 * viewport.scale,
    rect,
    viewport,
  );

  assert.deepEqual(topLeft, { x: 0, y: 0 });
  assert.ok(Math.abs(bottomRight.x - 1_000) < 1e-9);
  assert.ok(Math.abs(bottomRight.y - 650) < 1e-9);
  assert.ok(viewport.offsetY > viewport.offsetX);
});

test("field values normalize safely and clamp hot cells", () => {
  assert.equal(normalizeFieldValue(0, 10), 0);
  assert.equal(normalizeFieldValue(-2, 10), 0);
  assert.equal(normalizeFieldValue(4, 8), 0.5);
  assert.equal(normalizeFieldValue(12, 8), 1);
  assert.equal(normalizeFieldValue(4, 0), 0);
  assert.equal(normalizeFieldValue("not a number", 8), 0);
});

test("field colors are transparent at rest and perceptually ordered", () => {
  const empty = scalarFieldColor(0, 10);
  const faint = scalarFieldColor(1, 10);
  const hot = scalarFieldColor(10, 10);

  assert.deepEqual(empty, [0, 0, 0, 0]);
  assert.deepEqual(hot, [245, 184, 82, 160]);
  assert.ok(faint[3] > 0);
  assert.ok(faint[3] < hot[3]);
  assert.ok(faint.every((channel) => Number.isInteger(channel)));
});

test("environment geometry accepts canonical and tolerant coordinate shapes", () => {
  assert.deepEqual(
    resolveObstacleRect({ x: 20, y: 30, width: 80, height: 45 }),
    { x: 20, y: 30, width: 80, height: 45 },
  );
  assert.deepEqual(
    resolveObstacleRect({ centerX: 100, centerY: 75, size: { width: 40, height: 30 } }),
    { x: 80, y: 60, width: 40, height: 30 },
  );
  assert.equal(resolveObstacleRect({ x: 10, y: 10, width: -2, height: 30 }), null);

  assert.deepEqual(
    resolveDestination({ position: { x: 300, y: 120 }, r: 24 }),
    { x: 300, y: 120, radius: 24 },
  );
  assert.deepEqual(resolveDestination({ x: 0, y: 0 }), { x: 0, y: 0, radius: 18 });
  assert.equal(resolveDestination({ label: "missing coordinates" }), null);
});

test("scalar fields resolve from both top-level and compact environment contracts", () => {
  const canonicalValues = [0, 1, 2, 3, 4, 5];
  const canonical = resolveScalarField({
    field: { columns: 3, rows: 2, values: canonicalValues, maxValue: 8 },
  });
  assert.equal(canonical.columns, 3);
  assert.equal(canonical.rows, 2);
  assert.equal(canonical.values, canonicalValues);
  assert.equal(canonical.maxValue, 8);

  const compactValues = new Float32Array([0, 2, 7, 1]);
  const compact = resolveScalarField({
    environment: { field: { cols: 2, rows: 2, values: compactValues, max: 7 } },
  });
  assert.equal(compact.columns, 2);
  assert.equal(compact.rows, 2);
  assert.equal(compact.values, compactValues);
  assert.equal(compact.maxValue, 7);
  assert.equal(resolveScalarField({ environment: { field: { cols: 2, rows: 2, values: [1] } } }), null);
});

test("layout block mode emits click and drag gestures in world coordinates", () => {
  const gestures = [];
  const harness = createRendererHarness({ onLayoutGesture: (detail) => gestures.push(detail) });
  try {
    harness.renderer.setLayoutTool("block", { rows: 3, columns: 4, gap: 16 });
    assert.equal(harness.canvas.style.cursor, "crosshair");
    harness.dispatch("pointerdown", { clientX: 108, clientY: 108 });
    harness.dispatch("pointerup", { clientX: 108, clientY: 108 });
    assert.deepEqual(gestures[0], {
      tool: "block",
      start: { x: 100, y: 100 },
      end: { x: 100, y: 100 },
      dragged: false,
    });

    harness.renderer.setLayoutTool("grid", { rows: 2, columns: 3, gap: 12 });
    harness.dispatch("pointerdown", { pointerId: 2, clientX: 58, clientY: 68 });
    harness.dispatch("pointermove", { pointerId: 2, clientX: 258, clientY: 218 });
    harness.dispatch("pointerup", { pointerId: 2, clientX: 258, clientY: 218 });
    assert.deepEqual(gestures[1], {
      tool: "grid",
      start: { x: 50, y: 60 },
      end: { x: 250, y: 210 },
      dragged: true,
    });
  } finally {
    harness.restore();
  }
});

test("erase mode highlights and removes only the obstacle released under the pointer", () => {
  const erased = [];
  const harness = createRendererHarness({ onObstacleErase: (id) => erased.push(id) });
  try {
    harness.renderer.setLayoutTool("erase");
    harness.dispatch("pointermove", { clientX: 358, clientY: 248 });
    assert.equal(harness.canvas.style.cursor, "pointer");
    harness.dispatch("pointerdown", { clientX: 358, clientY: 248 });
    harness.dispatch("pointerup", { clientX: 358, clientY: 248 });
    assert.deepEqual(erased, ["market"]);

    harness.dispatch("pointerdown", { pointerId: 2, clientX: 358, clientY: 248 });
    harness.dispatch("pointerup", { pointerId: 2, clientX: 158, clientY: 148 });
    assert.deepEqual(erased, ["market"]);
  } finally {
    harness.restore();
  }
});

test("gate mode emits the shared click and radial-drag gesture contract", () => {
  const gestures = [];
  const harness = createRendererHarness({ onLayoutGesture: (detail) => gestures.push(detail) });
  try {
    harness.renderer.setLayoutTool("gate", {
      gateDefaultRadius: 34,
      gateMinRadius: 18,
      gateMaxRadius: 70,
    });
    assert.equal(harness.canvas.style.cursor, "crosshair");
    harness.dispatch("pointerdown", { clientX: 508, clientY: 308 });
    harness.dispatch("pointerup", { clientX: 508, clientY: 308 });
    assert.deepEqual(gestures[0], {
      tool: "gate",
      start: { x: 500, y: 300 },
      end: { x: 500, y: 300 },
      dragged: false,
    });

    harness.dispatch("pointerdown", { pointerId: 2, clientX: 508, clientY: 308 });
    harness.dispatch("pointermove", { pointerId: 2, clientX: 568, clientY: 308 });
    harness.dispatch("pointerup", { pointerId: 2, clientX: 568, clientY: 308 });
    assert.deepEqual(gestures[1], {
      tool: "gate",
      start: { x: 500, y: 300 },
      end: { x: 560, y: 300 },
      dragged: true,
    });
  } finally {
    harness.restore();
  }
});

test("typed erase identifies destination gates separately from obstacles", () => {
  const erased = [];
  const harness = createRendererHarness({ onEnvironmentErase: (target) => erased.push(target) });
  try {
    harness.renderer.setLayoutTool("erase");
    harness.dispatch("pointermove", { clientX: 708, clientY: 308 });
    assert.equal(harness.canvas.style.cursor, "pointer");
    harness.dispatch("pointerdown", { clientX: 708, clientY: 308 });
    harness.dispatch("pointerup", { clientX: 708, clientY: 308 });
    assert.deepEqual(erased, [{ type: "destination", id: "west-gate" }]);
    assert.equal(harness.canvas.style.cursor, "crosshair");
  } finally {
    harness.restore();
  }
});

test("inspect mode preserves agent selection and does not emit layout gestures", () => {
  const selected = [];
  const gestures = [];
  const harness = createRendererHarness({
    onSelect: (id) => selected.push(id),
    onLayoutGesture: (detail) => gestures.push(detail),
  });
  try {
    harness.renderer.setLayoutTool("inspect");
    harness.dispatch("pointerdown", { clientX: 108, clientY: 108 });
    harness.dispatch("pointerup", { clientX: 108, clientY: 108 });
    assert.deepEqual(selected, [0]);
    assert.deepEqual(gestures, []);
  } finally {
    harness.restore();
  }
});
