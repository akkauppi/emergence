const MAX_LAND_CELLS = 262_144;

const OWNER_COLORS = [
  "#70a4f4",
  "#ef9661",
  "#75cda5",
  "#d38bdd",
  "#e2c45f",
  "#ed788d",
  "#6ec9d4",
  "#afa4f2",
  "#9bc568",
  "#e39abc",
  "#77b5e1",
  "#dba56b",
];

const VALID_STATES = new Set(["unclaimed", "reserved", "claimed"]);

function finiteNumber(value, fallback = null) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  } catch {
    return fallback;
  }
}

function identityKey(value) {
  return String(value);
}

function sameIdentity(first, second) {
  if (first === null || first === undefined || second === null || second === undefined) return false;
  return identityKey(first) === identityKey(second);
}

function sourceLand(value) {
  if (!value || typeof value !== "object") return null;
  if (value.kind === "resolved-land-grid") return value;
  if (value.land && typeof value.land === "object") return value.land;
  return value.geometry && typeof value.geometry === "object" ? value : null;
}

function normalizeParcels(parcels) {
  if (!Array.isArray(parcels)) return [];
  return parcels.flatMap((parcel) => {
    if (!parcel || typeof parcel !== "object" || parcel.id === null || parcel.id === undefined) return [];
    const cellIds = Array.isArray(parcel.cellIds)
      ? parcel.cellIds
      : Array.isArray(parcel.cells)
        ? parcel.cells
        : [];
    return [{
      ...parcel,
      id: parcel.id,
      ownerId: parcel.ownerId ?? null,
      cellIds: [...cellIds],
    }];
  });
}

/**
 * Resolve a frame.land value into a dense, safe grid descriptor. Sparse or
 * malformed cell entries become ordinary unclaimed cells; malformed geometry
 * rejects the complete layer so a bad frame cannot disrupt the main canvas.
 */
export function resolveLandGrid(value) {
  const land = sourceLand(value);
  if (!land) return null;
  if (land.kind === "resolved-land-grid") return land;

  const geometry = land.geometry;
  if (!geometry || typeof geometry !== "object") return null;
  const x = finiteNumber(geometry.x ?? geometry.origin?.x, 0);
  const y = finiteNumber(geometry.y ?? geometry.origin?.y, 0);
  const cellSize = finiteNumber(geometry.cellSize);
  const gap = Math.max(0, finiteNumber(geometry.gap, 0));
  const columns = Math.floor(finiteNumber(geometry.columns, 0));
  const rows = Math.floor(finiteNumber(geometry.rows, 0));
  const cellCount = columns * rows;
  if (
    x === null
    || y === null
    || cellSize === null
    || cellSize <= 0
    || columns <= 0
    || rows <= 0
    || cellCount > MAX_LAND_CELLS
    || !Number.isFinite(x + columns * cellSize)
    || !Number.isFinite(y + rows * cellSize)
  ) return null;

  const parcels = normalizeParcels(land.parcels);
  const parcelByCellId = new Map();
  for (const parcel of parcels) {
    for (const cellId of parcel.cellIds) {
      parcelByCellId.set(identityKey(cellId), parcel.id);
    }
  }

  const suppliedByIndex = new Map();
  for (const candidate of Array.isArray(land.cells) ? land.cells : []) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = Math.floor(finiteNumber(candidate.row, -1));
    const column = Math.floor(finiteNumber(candidate.column, -1));
    if (row < 0 || row >= rows || column < 0 || column >= columns) continue;
    const index = row * columns + column;
    if (!suppliedByIndex.has(index)) suppliedByIndex.set(index, candidate);
  }

  const cells = Array.from({ length: cellCount }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const supplied = suppliedByIndex.get(index);
    const id = supplied?.id ?? `land-${row}-${column}`;
    const state = VALID_STATES.has(supplied?.state) ? supplied.state : "unclaimed";
    return {
      ...(supplied || {}),
      id,
      row,
      column,
      state,
      ownerId: supplied?.ownerId ?? null,
      reservedBy: supplied?.reservedBy ?? null,
      contested: supplied?.contested === true,
      parcelId: supplied?.parcelId ?? parcelByCellId.get(identityKey(id)) ?? null,
      implicit: !supplied,
    };
  });
  const cellById = new Map(cells.map((cell) => [identityKey(cell.id), cell]));

  return {
    kind: "resolved-land-grid",
    source: land,
    geometry: { x, y, cellSize, gap, columns, rows },
    x,
    y,
    cellSize,
    gap,
    columns,
    rows,
    width: columns * cellSize,
    height: rows * cellSize,
    cellCount,
    cells,
    cellById,
    parcels,
    policy: land.policy && typeof land.policy === "object" ? land.policy : null,
    events: Array.isArray(land.events) ? land.events : [],
  };
}

export function landCellBounds(value, cell) {
  const grid = resolveLandGrid(value);
  if (!grid || !cell) return null;
  const row = Math.floor(finiteNumber(cell.row, -1));
  const column = Math.floor(finiteNumber(cell.column, -1));
  if (row < 0 || row >= grid.rows || column < 0 || column >= grid.columns) return null;
  const explicitX = finiteNumber(cell.x);
  const explicitY = finiteNumber(cell.y);
  const explicitWidth = finiteNumber(cell.width);
  const explicitHeight = finiteNumber(cell.height);
  if (
    explicitX !== null
    && explicitY !== null
    && explicitWidth !== null
    && explicitHeight !== null
    && explicitWidth > 0
    && explicitHeight > 0
  ) {
    return { x: explicitX, y: explicitY, width: explicitWidth, height: explicitHeight };
  }
  const inset = Math.min(grid.cellSize / 2, grid.gap / 2);
  const size = Math.max(0.0001, grid.cellSize - inset * 2);
  return {
    x: grid.x + column * grid.cellSize + inset,
    y: grid.y + row * grid.cellSize + inset,
    width: size,
    height: size,
  };
}

/** Return the half-open grid cell containing a world-space point. */
export function landCellAtPoint(value, point) {
  const grid = resolveLandGrid(value);
  if (!grid || !point || typeof point !== "object") return null;
  const x = finiteNumber(point.x);
  const y = finiteNumber(point.y);
  if (x === null || y === null) return null;
  for (const cell of grid.cells) {
    const bounds = landCellBounds(grid, cell);
    if (
      bounds
      && x >= bounds.x
      && x < bounds.x + bounds.width
      && y >= bounds.y
      && y < bounds.y + bounds.height
    ) return cell;
  }
  return null;
}

/** A deterministic owner color that is stable for numeric and string IDs. */
export function ownerColor(ownerId) {
  if (ownerId === null || ownerId === undefined) return "#aebbd0";
  const input = identityKey(ownerId);
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return OWNER_COLORS[(hash >>> 0) % OWNER_COLORS.length];
}

/**
 * Return only parcel perimeter segments. Shared edges between cells in the
 * same parcel are omitted, keeping contiguous claims visually legible.
 */
export function parcelBoundarySegments(value, onlyParcelId = null) {
  const grid = resolveLandGrid(value);
  if (!grid) return [];
  const segments = [];
  const directions = [
    { row: -1, column: 0, edge: "top" },
    { row: 0, column: 1, edge: "right" },
    { row: 1, column: 0, edge: "bottom" },
    { row: 0, column: -1, edge: "left" },
  ];

  for (const cell of grid.cells) {
    if (cell.parcelId === null || cell.parcelId === undefined) continue;
    if (onlyParcelId !== null && !sameIdentity(cell.parcelId, onlyParcelId)) continue;
    const bounds = landCellBounds(grid, cell);
    for (const direction of directions) {
      const neighbourRow = cell.row + direction.row;
      const neighbourColumn = cell.column + direction.column;
      const neighbour = neighbourRow >= 0
        && neighbourRow < grid.rows
        && neighbourColumn >= 0
        && neighbourColumn < grid.columns
        ? grid.cells[neighbourRow * grid.columns + neighbourColumn]
        : null;
      if (neighbour && sameIdentity(neighbour.parcelId, cell.parcelId)) continue;

      let segment;
      if (direction.edge === "top") {
        segment = { x1: bounds.x, y1: bounds.y, x2: bounds.x + bounds.width, y2: bounds.y };
      } else if (direction.edge === "right") {
        segment = {
          x1: bounds.x + bounds.width,
          y1: bounds.y,
          x2: bounds.x + bounds.width,
          y2: bounds.y + bounds.height,
        };
      } else if (direction.edge === "bottom") {
        segment = {
          x1: bounds.x + bounds.width,
          y1: bounds.y + bounds.height,
          x2: bounds.x,
          y2: bounds.y + bounds.height,
        };
      } else {
        segment = { x1: bounds.x, y1: bounds.y + bounds.height, x2: bounds.x, y2: bounds.y };
      }
      segments.push({
        ...segment,
        parcelId: cell.parcelId,
        ownerId: cell.ownerId,
        cellId: cell.id,
      });
    }
  }
  return segments;
}

function strokeSegments(context, segments) {
  context.beginPath();
  for (const segment of segments) {
    context.moveTo(segment.x1, segment.y1);
    context.lineTo(segment.x2, segment.y2);
  }
  context.stroke();
}

function drawReservationHatch(context, bounds, scale) {
  const gap = 8 / scale;
  context.save();
  context.beginPath();
  context.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  context.clip();
  context.beginPath();
  for (let offset = -bounds.height; offset <= bounds.width; offset += gap) {
    context.moveTo(bounds.x + offset, bounds.y + bounds.height);
    context.lineTo(bounds.x + offset + bounds.height, bounds.y);
  }
  context.strokeStyle = "rgba(247, 200, 91, 0.72)";
  context.lineWidth = 1 / scale;
  context.stroke();
  context.restore();
}

/** Draw a resolved frame.land layer in world coordinates. */
export function drawTerritory(context, value, { scale = 1, selectedLandId = null } = {}) {
  const grid = resolveLandGrid(value);
  if (!grid || !context) return null;
  const safeScale = Math.max(0.0001, finiteNumber(scale, 1));
  const hairline = 1 / safeScale;

  context.save();
  for (const cell of grid.cells) {
    const bounds = landCellBounds(grid, cell);
    if (cell.state === "reserved") {
      context.fillStyle = "rgba(223, 168, 59, 0.16)";
      context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
      drawReservationHatch(context, bounds, safeScale);
    } else if (cell.state === "claimed") {
      context.save();
      context.globalAlpha = 0.48;
      context.fillStyle = ownerColor(cell.ownerId);
      context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
      context.restore();
    } else {
      context.fillStyle = "rgba(221, 231, 250, 0.035)";
      context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    }
  }

  context.strokeStyle = "rgba(220, 231, 251, 0.18)";
  context.lineWidth = hairline;
  for (const cell of grid.cells) {
    const bounds = landCellBounds(grid, cell);
    context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }

  const boundaries = parcelBoundarySegments(grid);
  if (boundaries.length > 0) {
    context.strokeStyle = "rgba(247, 241, 227, 0.84)";
    context.lineWidth = hairline * 2.2;
    strokeSegments(context, boundaries);
  }

  for (const cell of grid.cells) {
    if (!cell.contested) continue;
    const bounds = landCellBounds(grid, cell);
    const inset = 3 / safeScale;
    context.strokeStyle = "rgba(242, 122, 80, 0.98)";
    context.lineWidth = hairline * 1.8;
    context.strokeRect(
      bounds.x + inset,
      bounds.y + inset,
      Math.max(0, bounds.width - inset * 2),
      Math.max(0, bounds.height - inset * 2),
    );
    context.beginPath();
    context.moveTo(bounds.x + inset, bounds.y + inset);
    context.lineTo(bounds.x + bounds.width - inset, bounds.y + bounds.height - inset);
    context.moveTo(bounds.x + bounds.width - inset, bounds.y + inset);
    context.lineTo(bounds.x + inset, bounds.y + bounds.height - inset);
    context.stroke();
  }

  const selected = selectedLandId === null || selectedLandId === undefined
    ? null
    : grid.cellById.get(identityKey(selectedLandId));
  if (selected) {
    context.strokeStyle = "rgba(255, 255, 255, 0.98)";
    context.lineWidth = hairline * 3;
    if (selected.parcelId !== null && selected.parcelId !== undefined) {
      strokeSegments(context, parcelBoundarySegments(grid, selected.parcelId));
    } else {
      const bounds = landCellBounds(grid, selected);
      context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    }
  }
  context.restore();
  return grid;
}
