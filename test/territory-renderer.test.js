import assert from "node:assert/strict";
import test from "node:test";

import {
  drawTerritory,
  landCellAtPoint,
  landCellBounds,
  ownerColor,
  parcelBoundarySegments,
  resolveLandGrid,
} from "../src/territory-renderer.js";

function sampleLand() {
  return {
    geometry: { x: 10, y: 20, cellSize: 25, columns: 3, rows: 2 },
    cells: [
      { id: "a", row: 0, column: 0, state: "reserved", reservedBy: 7 },
      { id: "b", row: 0, column: 1, state: "claimed", ownerId: 2 },
      { id: "c", row: 1, column: 1, state: "claimed", ownerId: 2, contested: true },
      { id: "outside", row: 9, column: 9, state: "claimed", ownerId: 9 },
    ],
    parcels: [{ id: "parcel-2", ownerId: 2, cellIds: ["b", "c"] }],
  };
}

test("land grids resolve to a dense safe contract and inherit parcel membership", () => {
  const source = sampleLand();
  const grid = resolveLandGrid({ land: source });

  assert.deepEqual(grid.geometry, { x: 10, y: 20, cellSize: 25, gap: 0, columns: 3, rows: 2 });
  assert.equal(grid.cellCount, 6);
  assert.equal(grid.width, 75);
  assert.equal(grid.height, 50);
  assert.equal(grid.cells[0].id, "a");
  assert.equal(grid.cells[0].state, "reserved");
  assert.equal(grid.cells[0].reservedBy, 7);
  assert.equal(grid.cells[1].parcelId, "parcel-2");
  assert.equal(grid.cells[4].parcelId, "parcel-2");
  assert.equal(grid.cells[2].state, "unclaimed");
  assert.equal(grid.cells[2].implicit, true);
  assert.equal(grid.cells.some((cell) => cell.id === "outside"), false);
  assert.equal(resolveLandGrid(grid), grid);
});

test("malformed land geometry is rejected while malformed cells degrade to unclaimed", () => {
  assert.equal(resolveLandGrid(null), null);
  assert.equal(resolveLandGrid({ land: {} }), null);
  assert.equal(resolveLandGrid({ geometry: { cellSize: 0, columns: 3, rows: 2 } }), null);
  assert.equal(resolveLandGrid({ geometry: { cellSize: 20, columns: -1, rows: 2 } }), null);
  assert.equal(resolveLandGrid({ geometry: { cellSize: 1, columns: 1_000, rows: 1_000 } }), null);

  const grid = resolveLandGrid({
    geometry: { x: 0, y: 0, cellSize: 20, columns: 1, rows: 1 },
    cells: [{ id: "bad-state", row: 0, column: 0, state: "leased" }],
  });
  assert.equal(grid.cells[0].state, "unclaimed");
});

test("world points hit half-open cells and expose their world bounds", () => {
  const grid = resolveLandGrid(sampleLand());
  assert.equal(landCellAtPoint(grid, { x: 10, y: 20 }).id, "a");
  assert.equal(landCellAtPoint(grid, { x: 34.999, y: 44.999 }).id, "a");
  assert.equal(landCellAtPoint(grid, { x: 35, y: 20 }).id, "b");
  assert.equal(landCellAtPoint(grid, { x: 84.999, y: 69.999 }).row, 1);
  assert.equal(landCellAtPoint(grid, { x: 85, y: 30 }), null);
  assert.equal(landCellAtPoint(grid, { x: 20, y: 70 }), null);
  assert.equal(landCellAtPoint(grid, { x: Number.NaN, y: 30 }), null);
  assert.deepEqual(landCellBounds(grid, grid.cells[4]), { x: 35, y: 45, width: 25, height: 25 });
});

test("explicit cell rectangles preserve visual gaps and are authoritative for hit testing", () => {
  const grid = resolveLandGrid({
    geometry: { origin: { x: 10, y: 10 }, cellSize: 20, gap: 2, columns: 2, rows: 1 },
    cells: [
      { id: "left", row: 0, column: 0, x: 11, y: 11, width: 18, height: 18, state: "unclaimed" },
      { id: "right", row: 0, column: 1, x: 31, y: 11, width: 18, height: 18, state: "claimed", ownerId: 1 },
    ],
    policy: { reservationTicks: 12 },
    events: [{ type: "claim", landId: "right" }],
  });
  assert.equal(grid.geometry.x, 10);
  assert.equal(grid.geometry.gap, 2);
  assert.deepEqual(landCellBounds(grid, grid.cells[0]), { x: 11, y: 11, width: 18, height: 18 });
  assert.equal(landCellAtPoint(grid, { x: 29.5, y: 20 }), null);
  assert.equal(landCellAtPoint(grid, { x: 31, y: 20 }).id, "right");
  assert.equal(grid.policy.reservationTicks, 12);
  assert.equal(grid.events[0].type, "claim");
});

test("owner colors are deterministic and parcel boundaries omit shared edges", () => {
  assert.equal(ownerColor(12), ownerColor(12));
  assert.match(ownerColor("household-a"), /^#[0-9a-f]{6}$/i);
  assert.equal(ownerColor(null), "#aebbd0");

  const grid = resolveLandGrid({
    geometry: { x: 0, y: 0, cellSize: 20, columns: 2, rows: 1 },
    cells: [
      { id: "left", row: 0, column: 0, state: "claimed", ownerId: 4 },
      { id: "right", row: 0, column: 1, state: "claimed", ownerId: 4 },
    ],
    parcels: [{ id: "joined", ownerId: 4, cellIds: ["left", "right"] }],
  });
  const segments = parcelBoundarySegments(grid);
  assert.equal(segments.length, 6);
  assert.equal(
    segments.some((segment) => segment.x1 === 20 && segment.x2 === 20 && segment.y1 !== segment.y2),
    false,
  );
  assert.equal(parcelBoundarySegments(grid, "missing").length, 0);
});

test("territory drawing emits fills, reservation hatch, conflict, and parcel outlines safely", () => {
  const operations = [];
  const context = new Proxy({}, {
    get(target, property) {
      if (!(property in target)) {
        target[property] = (...args) => operations.push([property, ...args]);
      }
      return target[property];
    },
    set(target, property, value) {
      operations.push([`set:${String(property)}`, value]);
      target[property] = value;
      return true;
    },
  });

  const result = drawTerritory(context, { land: sampleLand() }, { scale: 2, selectedLandId: "b" });
  assert.equal(result.cellCount, 6);
  assert.ok(operations.some(([operation]) => operation === "fillRect"));
  assert.ok(operations.some(([operation]) => operation === "rect"));
  assert.ok(operations.some(([operation]) => operation === "clip"));
  assert.ok(operations.some(([operation]) => operation === "strokeRect"));
  assert.equal(drawTerritory(context, { land: { geometry: { cellSize: 0 } } }), null);
});
