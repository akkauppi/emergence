import assert from "node:assert/strict";
import test from "node:test";

import { calculateViewport, clientToWorld } from "../src/canvas-renderer.js";

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
