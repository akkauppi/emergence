import assert from "node:assert/strict";
import test from "node:test";

import {
  circulationCongestionColor,
  circulationCongestionRatio,
  circulationRegionFill,
  circulationRegionStroke,
  circulationSurfaceColor,
  drawCirculationRoute,
  drawTerritory,
  drawTerritoryLayers,
  landCellAtPoint,
  landCellBounds,
  normalizeCirculationHierarchy,
  normalizeCirculationStatus,
  ownerColor,
  parcelBoundarySegments,
  resolveCirculation,
  resolveCirculationRoute,
  resolveLandGrid,
} from "../src/territory-renderer.js";

function recordingContext() {
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
  return { context, operations };
}

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
    events: [{ type: "road-land-conflict", landId: "land-1-0", winner: "private" }],
  };
}

function sampleCirculation() {
  return {
    enabled: true,
    kind: "emergent-cell-network",
    cells: [
      { id: "land-1-0", role: "open", use: 7, load: 1, claimed: false },
      { id: "land-1-2", role: "road-reserved", use: 12, load: 2, claimed: false },
      { id: "land-0-2", role: "road", use: 31, load: 3, claimed: false },
    ],
    regions: [
      {
        id: "reserve-land-1-2",
        landId: "land-1-2",
        x: 60,
        y: 45,
        width: 25,
        height: 25,
        hierarchy: "path",
        role: "road-reserved",
        use: 12,
        reservedBy: 5,
        contested: true,
      },
      {
        id: "road-land-0-2",
        landId: "land-0-2",
        x: 60,
        y: 20,
        width: 25,
        height: 25,
        hierarchy: "secondary",
        role: "road",
        use: 31,
        committedAt: 18,
      },
    ],
    nodes: [
      { id: "north", x: 72.5, y: 32.5 },
      { id: "south", x: 72.5, y: 57.5 },
    ],
    edges: [
      { id: "main", from: "north", to: "south", width: 8, hierarchy: "path", load: 15, capacity: 12 },
      { id: "broken", from: "missing", to: "also-missing", width: 10 },
    ],
    entries: [{ id: "gate", x: 72.5, y: 20 }, { id: "bad-entry", x: Infinity, y: 2 }],
    metrics: { roadCells: 1, roadReservations: 1, roadLandConflicts: 1 },
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

test("circulation resolves emergent cell states, node-backed edges, and malformed entries safely", () => {
  const resolved = resolveCirculation({ land: sampleLand(), circulation: sampleCirculation() });
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.circulationKind, "emergent-cell-network");
  assert.deepEqual(resolved.regions.map((region) => region.status), ["reserved", "road", "trace"]);
  assert.deepEqual(resolved.regions.map((region) => region.use), [12, 31, 7]);
  assert.equal(resolved.regions[0].reservedBy, 5);
  assert.equal(resolved.regions[0].contested, true);
  assert.equal(resolved.regions[2].landId, "land-1-0");
  assert.equal(resolved.regions[2].contested, true);
  assert.deepEqual(
    [resolved.regions[2].x, resolved.regions[2].y, resolved.regions[2].width, resolved.regions[2].height],
    [10, 45, 25, 25],
  );
  assert.equal(resolved.nodes.length, 2);
  assert.equal(resolved.edges.length, 1);
  assert.deepEqual(
    [resolved.edges[0].x1, resolved.edges[0].y1, resolved.edges[0].x2, resolved.edges[0].y2],
    [72.5, 32.5, 72.5, 57.5],
  );
  assert.equal(resolved.edges[0].congestion, 15 / 12);
  assert.equal(resolved.entries.length, 1);
  assert.equal(resolveCirculation(resolved), resolved);
  assert.equal(resolveCirculation(null), null);
  assert.equal(resolveCirculation({ kind: "resolved-circulation" }), null);
  assert.doesNotThrow(() => resolveCirculation({ circulation: { regions: [null, { width: -2 }] } }));

  const cellAlias = resolveCirculation({
    circulation: {
      cells: [{ id: "cell-a", bounds: { x: 1, y: 2, width: 3, height: 4 }, state: "candidate", usage: 9 }],
    },
  });
  assert.equal(cellAlias.regions[0].status, "trace");
  assert.equal(cellAlias.regions[0].use, 9);
});

test("circulation status, trace strength, hierarchy, and congestion colors are stable", () => {
  assert.equal(normalizeCirculationHierarchy("arterial"), "primary");
  assert.equal(normalizeCirculationHierarchy("lane"), "secondary");
  assert.equal(normalizeCirculationHierarchy("unknown"), "path");
  assert.equal(normalizeCirculationStatus("candidate"), "trace");
  assert.equal(normalizeCirculationStatus("pending"), "reserved");
  assert.equal(normalizeCirculationStatus("road-reserved"), "reserved");
  assert.equal(normalizeCirculationStatus("public-way"), "road");
  assert.equal(normalizeCirculationStatus(undefined), "road");
  assert.equal(circulationSurfaceColor("arterial"), circulationSurfaceColor("primary"));
  assert.notEqual(circulationRegionFill({ status: "trace", use: 1 }), circulationRegionFill({ status: "trace", use: 30 }));
  assert.notEqual(circulationRegionFill({ status: "reserved" }), circulationRegionFill({ status: "road" }));
  assert.notEqual(circulationRegionStroke({ status: "road" }), circulationRegionStroke({ status: "road", contested: true }));
  assert.equal(circulationCongestionRatio(0, 0), 0);
  assert.equal(circulationCongestionRatio(8, 0), 1);
  assert.equal(circulationCongestionRatio(300, 100), 2);
  assert.equal(circulationCongestionRatio(0, 0, 0.75), 0.75);
  assert.equal(circulationCongestionRatio(0, 0, 8), 2);
  assert.equal(circulationCongestionColor(20, 100), "rgba(112, 214, 181, 0)");
  assert.equal(circulationCongestionColor(100, 100), "rgba(242, 96, 80, 0.88)");
});

test("travel traces, road reservations, and roads draw before plots with conflict and load cues", () => {
  const { context, operations } = recordingContext();
  const frame = { land: sampleLand(), circulation: sampleCirculation() };
  const result = drawTerritoryLayers(context, frame, { scale: 2, selectedLandId: "land-0-2" });
  assert.equal(result.circulation.edges.length, 1);
  assert.equal(result.land.cellCount, 6);

  const roadColorIndex = operations.findIndex(
    ([operation, value]) => operation === "set:fillStyle" && value === circulationRegionFill({ status: "road", hierarchy: "secondary" }),
  );
  const ownerColorIndex = operations.findIndex(
    ([operation, value]) => operation === "set:fillStyle" && value === ownerColor(2),
  );
  assert.ok(roadColorIndex >= 0);
  assert.ok(ownerColorIndex > roadColorIndex);
  assert.ok(operations.some(([operation, value]) => (
    operation === "set:fillStyle" && value === circulationRegionFill({ status: "reserved" })
  )));
  assert.ok(operations.some(([operation, value]) => (
    operation === "set:strokeStyle" && value === circulationCongestionColor(15, 12)
  )));
  assert.ok(operations.some(([operation, value]) => (
    operation === "set:strokeStyle" && value === circulationRegionStroke({ contested: true })
  )));
  assert.ok(operations.some(([operation, dash]) => (
    operation === "setLineDash" && Array.isArray(dash) && dash.length === 2
  )));
});

test("hiding tenure preserves traces and public ways without ownership decoration", () => {
  const { context, operations } = recordingContext();
  drawTerritoryLayers(
    context,
    { land: sampleLand(), circulation: sampleCirculation() },
    { scale: 1, selectedLandId: "b", tenureVisible: false },
  );
  assert.ok(operations.some(([operation]) => operation === "fillRect"));
  assert.equal(operations.some(([operation, value]) => operation === "set:fillStyle" && value === ownerColor(2)), false);
  assert.ok(operations.some(([operation, value]) => (
    operation === "set:fillStyle" && value === circulationRegionFill({ status: "road", hierarchy: "secondary" })
  )));
});

test("selected claimant routes tolerate absent data and draw only valid point sequences", () => {
  assert.equal(resolveCirculationRoute(null), null);
  assert.equal(resolveCirculationRoute({ circulationRoute: { points: [{ x: 1, y: 2 }] } }), null);
  const agent = {
    circulationRoute: {
      landId: "b",
      status: "reserved",
      cellIds: ["land-1-0", "land-0-2"],
      points: [{ x: 5, y: 8 }, { x: "bad", y: 12 }, { x: 25, y: 18 }],
    },
  };
  const resolved = resolveCirculationRoute(agent);
  assert.deepEqual(resolved.points, [{ x: 5, y: 8 }, { x: 25, y: 18 }]);
  assert.equal(resolved.landId, "b");
  assert.deepEqual(resolved.cellIds, ["land-1-0", "land-0-2"]);

  const { context, operations } = recordingContext();
  assert.equal(drawCirculationRoute(context, null), null);
  assert.equal(drawCirculationRoute(context, agent, { scale: 2 }).status, "reserved");
  assert.ok(operations.some(([operation]) => operation === "closePath"));
  assert.ok(operations.filter(([operation]) => operation === "stroke").length >= 2);
});

test("territory drawing emits fills, reservation hatch, conflict, and parcel outlines safely", () => {
  const { context, operations } = recordingContext();

  const result = drawTerritory(context, { land: sampleLand() }, { scale: 2, selectedLandId: "b" });
  assert.equal(result.cellCount, 6);
  assert.ok(operations.some(([operation]) => operation === "fillRect"));
  assert.ok(operations.some(([operation]) => operation === "rect"));
  assert.ok(operations.some(([operation]) => operation === "clip"));
  assert.ok(operations.some(([operation]) => operation === "strokeRect"));
  assert.equal(drawTerritory(context, { land: { geometry: { cellSize: 0 } } }), null);
});
