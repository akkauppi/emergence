import assert from "node:assert/strict";
import test from "node:test";

import {
  circleOverlapsRect,
  circlesOverlap,
  createBlockGrid,
  gatePlacementConflict,
  generateBlockGrid,
  normalizeGate,
  normalizeLayoutRect,
  placementConflict,
  pointInCircle,
  pointInRect,
  rectsOverlap,
} from "../src/layout-tools.js";

test("drag rectangles normalize in every direction and clamp to the world", () => {
  assert.deepEqual(
    normalizeLayoutRect(
      { start: { x: 90, y: 70 }, end: { x: 20, y: -10 }, dragged: true },
      { width: 100, height: 80, minSize: 8 },
    ),
    { x: 20, y: 0, width: 70, height: 70 },
  );
  assert.equal(
    normalizeLayoutRect(
      { start: { x: 10, y: 10 }, end: { x: 14, y: 40 }, dragged: true },
      { width: 100, height: 80, minSize: 8 },
    ),
    null,
  );
  assert.equal(normalizeLayoutRect({ start: { x: Number.NaN, y: 10 }, dragged: false }), null);
});

test("click rectangles use defaults, centre on the pointer, and stay in bounds", () => {
  assert.deepEqual(
    normalizeLayoutRect(
      { start: { x: 5, y: 95 }, end: { x: 5, y: 95 }, dragged: false },
      { width: 200, height: 100, defaultWidth: 60, defaultHeight: 40 },
    ),
    { x: 0, y: 60, width: 60, height: 40 },
  );
  assert.deepEqual(
    normalizeLayoutRect(
      { start: { x: 50, y: 30 }, dragged: false },
      { width: 70, height: 50, defaultWidth: 120, defaultHeight: 100 },
    ),
    { x: 0, y: 0, width: 70, height: 50 },
  );
});

test("gate clicks and radial drags normalize to bounded circles", () => {
  assert.deepEqual(
    normalizeGate(
      { start: { x: 5, y: 95 }, dragged: false },
      { width: 200, height: 100 },
    ),
    { x: 34, y: 66, radius: 34 },
  );
  assert.deepEqual(
    normalizeGate(
      { start: { x: 100, y: 100 }, end: { x: 200, y: 100 }, dragged: true },
      { width: 300, height: 300 },
    ),
    { x: 100, y: 100, radius: 70 },
  );
  assert.deepEqual(
    normalizeGate(
      { start: { x: 100, y: 100 }, end: { x: 105, y: 100 }, dragged: true },
      { width: 300, height: 300 },
    ),
    { x: 100, y: 100, radius: 18 },
  );
  assert.equal(normalizeGate({ start: { x: 10, y: Infinity }, dragged: false }), null);
});

test("block grids are row-major with exact gaps and reject impossible cells", () => {
  assert.deepEqual(
    generateBlockGrid(
      { x: 10, y: 20, width: 220, height: 110 },
      { rows: 2, columns: 3, gap: 10, minSize: 8 },
    ),
    [
      { x: 10, y: 20, width: 200 / 3, height: 50 },
      { x: 10 + 230 / 3, y: 20, width: 200 / 3, height: 50 },
      { x: 10 + 460 / 3, y: 20, width: 200 / 3, height: 50 },
      { x: 10, y: 80, width: 200 / 3, height: 50 },
      { x: 10 + 230 / 3, y: 80, width: 200 / 3, height: 50 },
      { x: 10 + 460 / 3, y: 80, width: 200 / 3, height: 50 },
    ],
  );
  assert.deepEqual(generateBlockGrid(
    { x: 0, y: 0, width: 30, height: 30 },
    { rows: 3, columns: 3, gap: 10, minSize: 8 },
  ), []);
  assert.deepEqual(generateBlockGrid({ x: 0, y: 0, width: 100, height: 100 }, { rows: 0 }), []);
});

test("createBlockGrid adds stable ids and empty labels", () => {
  assert.deepEqual(
    createBlockGrid(
      { x: 0, y: 0, width: 50, height: 20 },
      { rows: 1, columns: 2, gap: 10, idPrefix: "quarter", minSize: 8 },
    ),
    [
      { id: "quarter-1", x: 0, y: 0, width: 20, height: 20, label: "" },
      { id: "quarter-2", x: 30, y: 0, width: 20, height: 20, label: "" },
    ],
  );
});

test("rectangle and destination gates permit tangency but reject overlap", () => {
  const block = { x: 20, y: 20, width: 40, height: 30 };
  assert.equal(pointInRect({ x: 20, y: 35 }, block), true);
  assert.equal(pointInRect({ x: 19.99, y: 35 }, block), false);
  assert.equal(rectsOverlap(block, { x: 60, y: 25, width: 10, height: 10 }), false);
  assert.equal(rectsOverlap(block, { x: 59.99, y: 25, width: 10, height: 10 }), true);
  assert.equal(circleOverlapsRect({ x: 10, y: 35, radius: 10 }, block), false);
  assert.equal(circleOverlapsRect({ x: 10.01, y: 35, radius: 10 }, block), true);
  assert.equal(circleOverlapsRect({ x: 5, y: 35, radius: 10 }, block, 5), false);
  assert.equal(circleOverlapsRect({ x: 5.01, y: 35, radius: 10 }, block, 5), true);
  assert.equal(pointInCircle({ x: 10, y: 0 }, { x: 0, y: 0, radius: 10 }), true);
  assert.equal(pointInCircle({ x: 10.01, y: 0 }, { x: 0, y: 0, radius: 10 }), false);
  assert.equal(circlesOverlap(
    { x: 0, y: 0, radius: 10 },
    { x: 25, y: 0, radius: 10 },
    5,
  ), false);
  assert.equal(circlesOverlap(
    { x: 0, y: 0, radius: 10 },
    { x: 24.99, y: 0, radius: 10 },
    5,
  ), true);
});

test("placementConflict reports existing blocks and destination clearance", () => {
  const options = {
    obstacles: [{ id: "old", x: 50, y: 50, width: 30, height: 30 }],
    destinations: [{ id: "gate", x: 150, y: 60, radius: 12 }],
    destinationClearance: 8,
  };
  assert.deepEqual(
    placementConflict([{ x: 70, y: 60, width: 30, height: 20 }], options),
    { type: "obstacle", id: "old" },
  );
  assert.deepEqual(
    placementConflict([{ x: 120.01, y: 50, width: 10, height: 20 }], options),
    { type: "destination", id: "gate" },
  );
  assert.equal(
    placementConflict([{ x: 120, y: 50, width: 10, height: 20 }], options),
    null,
  );
  assert.deepEqual(
    placementConflict(
      [{ x: 120.01, y: 50, width: 10, height: 20 }],
      { ...options, destinationClearance: 0, minimumDestinationRadius: 20 },
    ),
    { type: "destination", id: "gate" },
  );
  assert.equal(
    placementConflict(
      [{ x: 120, y: 50, width: 10, height: 20 }],
      { ...options, destinationClearance: 0, minimumDestinationRadius: 20 },
    ),
    null,
  );
  assert.equal(
    placementConflict(
      [{ x: 70, y: 60, width: 30, height: 20 }],
      { ...options, ignoreIds: ["old"] },
    ),
    null,
  );
  assert.deepEqual(placementConflict([{ x: 10, y: 10, width: -1, height: 2 }]), {
    type: "invalid",
    id: null,
  });
});

test("gatePlacementConflict reports blocks and other gates with tangent boundaries allowed", () => {
  const options = {
    obstacles: [{ id: "hall", x: 100, y: 100, width: 40, height: 40 }],
    destinations: [{ id: "old-gate", x: 220, y: 120, radius: 20 }],
    obstacleClearance: 5,
    gateClearance: 10,
  };
  assert.equal(
    gatePlacementConflict({ x: 75, y: 120, radius: 20 }, options),
    null,
  );
  assert.deepEqual(
    gatePlacementConflict({ x: 75.01, y: 120, radius: 20 }, options),
    { type: "obstacle", id: "hall" },
  );
  assert.equal(
    gatePlacementConflict({ x: 170, y: 120, radius: 20 }, options),
    null,
  );
  assert.deepEqual(
    gatePlacementConflict({ x: 170.01, y: 120, radius: 20 }, options),
    { type: "destination", id: "old-gate" },
  );
  assert.equal(
    gatePlacementConflict(
      { x: 220, y: 120, radius: 20 },
      { ...options, ignoreIds: ["old-gate"] },
    ),
    null,
  );
  assert.deepEqual(gatePlacementConflict({ x: 1, y: 2, radius: 0 }), {
    type: "invalid",
    id: null,
  });
});

test("gate placement keeps effective journey-arrival zones separate", () => {
  const options = {
    destinations: [{ id: "first", x: 100, y: 100, radius: 18 }],
    minimumGateRadius: 30,
  };
  assert.deepEqual(
    gatePlacementConflict({ x: 159.99, y: 100, radius: 18 }, options),
    { type: "destination", id: "first" },
  );
  assert.equal(gatePlacementConflict({ x: 160, y: 100, radius: 18 }, options), null);

  const obstacleOptions = {
    obstacles: [{ id: "wall", x: 100, y: 80, width: 30, height: 40 }],
    obstacleClearance: 12,
  };
  assert.deepEqual(
    gatePlacementConflict({ x: 70.01, y: 100, radius: 18 }, obstacleOptions),
    { type: "obstacle", id: "wall" },
  );
  assert.equal(gatePlacementConflict({ x: 70, y: 100, radius: 18 }, obstacleOptions), null);
});
