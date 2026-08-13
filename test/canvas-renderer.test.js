import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateViewport,
  clientToWorld,
  normalizeFieldValue,
  resolveDestination,
  resolveObstacleRect,
  resolveScalarField,
  scalarFieldColor,
} from "../src/canvas-renderer.js";

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
