const MAX_LAND_CELLS = 262_144;
const MAX_CIRCULATION_FEATURES = 16_384;
const MAX_ROUTE_POINTS = 4_096;

const CIRCULATION_SURFACES = Object.freeze({
  primary: "#31445a",
  secondary: "#2b3b4d",
  path: "#405064",
});

const CIRCULATION_WIDTHS = Object.freeze({
  primary: 22,
  secondary: 13,
  path: 7,
});

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

function boundedCollection(value) {
  return Array.isArray(value) ? value.slice(0, MAX_CIRCULATION_FEATURES) : [];
}

export function normalizeCirculationHierarchy(value) {
  const hierarchy = String(value ?? "").toLowerCase();
  if (["primary", "arterial", "main", "1"].includes(hierarchy)) return "primary";
  if (["secondary", "collector", "lane", "2"].includes(hierarchy)) return "secondary";
  return "path";
}

export function circulationSurfaceColor(hierarchy) {
  return CIRCULATION_SURFACES[normalizeCirculationHierarchy(hierarchy)];
}

export function normalizeCirculationStatus(value) {
  const status = String(value ?? "").toLowerCase();
  if (["reserved", "reservation", "pending", "road-reserved", "road_reserved"].includes(status)) return "reserved";
  if (["road", "street", "committed", "public-way", "public_way"].includes(status)) return "road";
  if (["trace", "candidate", "used", "preferred"].includes(status)) return "trace";
  // Status-free regions are treated as established roads for compatibility
  // with older frames; an explicitly unknown status is only a tentative trace.
  return value === null || value === undefined || status === "" ? "road" : "trace";
}

export function circulationRegionFill(region = {}) {
  const status = normalizeCirculationStatus(region.status ?? region.role ?? region.state ?? region.designation);
  if (status === "road") return circulationSurfaceColor(region.hierarchy);
  if (status === "reserved") return "rgba(76, 172, 190, 0.34)";
  const use = Math.max(0, finiteNumber(region.use ?? region.usage ?? region.footfall, 0));
  const alpha = Math.min(0.32, 0.055 + Math.log1p(use) * 0.055);
  return `rgba(112, 214, 181, ${alpha.toFixed(3)})`;
}

export function circulationRegionStroke(region = {}) {
  const status = normalizeCirculationStatus(region.status ?? region.role ?? region.state ?? region.designation);
  if (region.contested === true || region.conflict === true) return "rgba(255, 112, 82, 0.98)";
  if (status === "reserved") return "rgba(115, 231, 225, 0.9)";
  if (status === "trace") return "rgba(112, 214, 181, 0.46)";
  return "rgba(194, 209, 239, 0.38)";
}

export function circulationCongestionRatio(load, capacity, congestion = null) {
  if (congestion !== null && congestion !== undefined) {
    const explicit = finiteNumber(congestion);
    if (explicit !== null) return Math.max(0, Math.min(2, explicit));
  }
  const numericLoad = Math.max(0, finiteNumber(load, 0));
  const numericCapacity = finiteNumber(capacity, 0);
  if (numericLoad <= 0) return 0;
  if (numericCapacity <= 0) return 1;
  return Math.min(2, numericLoad / numericCapacity);
}

export function circulationCongestionColor(load, capacity, congestion = null) {
  const ratio = circulationCongestionRatio(load, capacity, congestion);
  if (ratio < 0.5) return "rgba(112, 214, 181, 0)";
  if (ratio < 0.85) return "rgba(230, 178, 71, 0.48)";
  if (ratio < 1) return "rgba(242, 139, 78, 0.68)";
  return "rgba(242, 96, 80, 0.88)";
}

function isResolvedCirculation(value) {
  return value?.kind === "resolved-circulation"
    && Array.isArray(value.regions)
    && Array.isArray(value.nodes)
    && value.nodeById instanceof Map
    && Array.isArray(value.edges)
    && Array.isArray(value.entries);
}

function circulationSource(value) {
  if (!value || typeof value !== "object") return null;
  if (isResolvedCirculation(value)) return value;
  if (value.circulation && typeof value.circulation === "object") return value.circulation;
  if (
    Array.isArray(value.regions)
    || Array.isArray(value.cells)
    || Array.isArray(value.edges)
    || Array.isArray(value.nodes)
  ) return value;
  return null;
}

function resolveCirculationPoint(value) {
  if (!value || typeof value !== "object") return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  return x === null || y === null ? null : { x, y };
}

/** Resolve the optional top-level frame.circulation layer without trusting authored data. */
export function resolveCirculation(value) {
  const source = circulationSource(value);
  if (!source) return null;
  if (isResolvedCirculation(source)) return source;

  const nodes = boundedCollection(source.nodes).flatMap((node, index) => {
    const point = resolveCirculationPoint(node);
    if (!point) return [];
    return [{
      ...node,
      id: node?.id ?? `circulation-node-${index}`,
      ...point,
    }];
  });
  const nodeById = new Map(nodes.map((node) => [identityKey(node.id), node]));

  const explicitRegions = boundedCollection(source.regions);
  const roadLandConflicts = new Set([
    ...boundedCollection(value?.land?.events),
    ...boundedCollection(source.events),
  ].flatMap((event) => (
    event?.type === "road-land-conflict" && event.landId !== null && event.landId !== undefined
      ? [identityKey(event.landId)]
      : []
  )));
  const explicitLandIds = new Set(explicitRegions.flatMap((region) => {
    const id = region?.landId ?? region?.cellId;
    return id === null || id === undefined ? [] : [identityKey(id)];
  }));
  const landGrid = resolveLandGrid(value);
  const continuousFlow = source.kind === "emergent-flow-network";
  const tracedCells = (continuousFlow ? [] : boundedCollection(source.cells)).flatMap((cell) => {
    if (!cell || typeof cell !== "object") return [];
    const landId = cell.landId ?? cell.cellId ?? cell.id;
    if (landId === null || landId === undefined || explicitLandIds.has(identityKey(landId))) return [];
    const role = String(cell.role ?? cell.status ?? cell.state ?? "open").toLowerCase();
    const use = Math.max(0, finiteNumber(cell.use ?? cell.usage ?? cell.footfall, 0));
    if (role === "open" && use <= 0) return [];
    const landCell = landGrid?.cellById.get(identityKey(landId));
    const bounds = cell.bounds && typeof cell.bounds === "object"
      ? cell.bounds
      : landCell
        ? landCellBounds(landGrid, landCell)
        : cell;
    return [{ ...cell, landId, bounds }];
  });
  const regionInput = [...explicitRegions, ...tracedCells];
  const regions = boundedCollection(regionInput).flatMap((region, index) => {
    if (!region || typeof region !== "object") return [];
    const bounds = region.bounds && typeof region.bounds === "object" ? region.bounds : region;
    const x = finiteNumber(bounds.x);
    const y = finiteNumber(bounds.y);
    const width = finiteNumber(bounds.width);
    const height = finiteNumber(bounds.height);
    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return [];
    const status = normalizeCirculationStatus(region.status ?? region.role ?? region.state ?? region.designation);
    const landId = region.landId ?? region.cellId ?? null;
    return [{
      ...region,
      id: region.id ?? `circulation-region-${index}`,
      landId,
      x,
      y,
      width,
      height,
      hierarchy: normalizeCirculationHierarchy(region.hierarchy),
      status,
      use: Math.max(0, finiteNumber(region.use ?? region.usage ?? region.footfall, 0)),
      score: Math.max(0, finiteNumber(region.score ?? region.preference, 0)),
      reservedBy: region.reservedBy ?? null,
      committedAt: finiteNumber(region.committedAt ?? region.roadAt),
      contested: region.contested === true
        || region.conflict === true
        || (landId !== null && roadLandConflicts.has(identityKey(landId))),
    }];
  });

  const edges = boundedCollection(source.edges).flatMap((edge, index) => {
    if (!edge || typeof edge !== "object") return [];
    const fromNode = nodeById.get(identityKey(edge.from));
    const toNode = nodeById.get(identityKey(edge.to));
    const x1 = finiteNumber(edge.x1 ?? fromNode?.x);
    const y1 = finiteNumber(edge.y1 ?? fromNode?.y);
    const x2 = finiteNumber(edge.x2 ?? toNode?.x);
    const y2 = finiteNumber(edge.y2 ?? toNode?.y);
    if (x1 === null || y1 === null || x2 === null || y2 === null || Math.hypot(x2 - x1, y2 - y1) < 0.0001) return [];
    const hierarchy = normalizeCirculationHierarchy(edge.hierarchy);
    const width = Math.max(1, Math.min(256, finiteNumber(edge.width, CIRCULATION_WIDTHS[hierarchy])));
    const load = Math.max(0, finiteNumber(edge.load, 0));
    const capacity = Math.max(0, finiteNumber(edge.capacity, 0));
    return [{
      ...edge,
      id: edge.id ?? `circulation-edge-${index}`,
      from: edge.from ?? null,
      to: edge.to ?? null,
      x1,
      y1,
      x2,
      y2,
      width,
      hierarchy,
      status: normalizeCirculationStatus(edge.status ?? edge.role ?? edge.state),
      load,
      capacity,
      congestion: circulationCongestionRatio(load, capacity, edge.congestion),
    }];
  });

  const entries = boundedCollection(source.entries).flatMap((entry, index) => {
    const point = resolveCirculationPoint(entry);
    if (!point) return [];
    return [{ ...entry, id: entry?.id ?? `circulation-entry-${index}`, ...point }];
  });

  return {
    kind: "resolved-circulation",
    source,
    enabled: source.enabled !== false,
    circulationKind: typeof source.kind === "string" ? source.kind : null,
    regions,
    nodes,
    nodeById,
    edges,
    entries,
    metrics: source.metrics && typeof source.metrics === "object" ? source.metrics : {},
  };
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

function drawReservationHatch(context, bounds, scale, strokeStyle = "rgba(247, 200, 91, 0.72)") {
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
  context.strokeStyle = strokeStyle;
  context.lineWidth = 1 / scale;
  context.stroke();
  context.restore();
}

function hierarchyRank(value) {
  const hierarchy = normalizeCirculationHierarchy(value);
  return hierarchy === "primary" ? 3 : hierarchy === "secondary" ? 2 : 1;
}

function circulationStatusRank(value) {
  const status = normalizeCirculationStatus(value);
  return status === "road" ? 3 : status === "reserved" ? 2 : 1;
}

function markCirculationConflict(context, region, scale) {
  const inset = 3 / scale;
  const left = region.x + inset;
  const top = region.y + inset;
  const right = region.x + region.width - inset;
  const bottom = region.y + region.height - inset;
  context.strokeStyle = circulationRegionStroke({ ...region, contested: true });
  context.lineWidth = 1.8 / scale;
  context.strokeRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
  context.beginPath();
  context.moveTo(left, top);
  context.lineTo(right, bottom);
  context.moveTo(right, top);
  context.lineTo(left, bottom);
  context.stroke();
}

function strokeCirculationEdge(context, edge) {
  context.beginPath();
  context.moveTo(edge.x1, edge.y1);
  context.lineTo(edge.x2, edge.y2);
  context.stroke();
}

/** Draw movement traces and the public ways that grow from them. */
export function drawPublicRealm(context, value, { scale = 1, selectedLandId = null } = {}) {
  const circulation = resolveCirculation(value);
  if (!circulation || !context || !circulation.enabled) return circulation;
  const safeScale = Math.max(0.0001, finiteNumber(scale, 1));
  const hairline = 1 / safeScale;
  const regions = [...circulation.regions].sort(
    (first, second) => (
      circulationStatusRank(first.status) - circulationStatusRank(second.status)
      || hierarchyRank(first.hierarchy) - hierarchyRank(second.hierarchy)
    ),
  );
  const edges = [...circulation.edges].sort(
    (first, second) => second.width - first.width || hierarchyRank(second.hierarchy) - hierarchyRank(first.hierarchy),
  );

  context.save();
  for (const region of regions) {
    if (
      circulation.circulationKind === "emergent-flow-network"
      && region.status !== "reserved"
    ) continue;
    context.fillStyle = circulationRegionFill(region);
    context.fillRect(region.x, region.y, region.width, region.height);
    context.strokeStyle = circulationRegionStroke(region);
    context.lineWidth = (region.status === "reserved" ? 1.8 : 1) * hairline;
    context.setLineDash(region.status === "trace"
      ? [2 / safeScale, 5 / safeScale]
      : region.status === "reserved"
        ? [6 / safeScale, 4 / safeScale]
        : []);
    context.strokeRect(region.x, region.y, region.width, region.height);
    context.setLineDash([]);
    if (region.status === "reserved") {
      drawReservationHatch(context, region, safeScale, "rgba(115, 231, 225, 0.62)");
    }
    if (region.contested) markCirculationConflict(context, region, safeScale);
    if (
      selectedLandId !== null
      && selectedLandId !== undefined
      && sameIdentity(region.landId ?? region.id, selectedLandId)
    ) {
      context.strokeStyle = "rgba(255, 255, 255, 0.96)";
      context.lineWidth = 2.6 * hairline;
      context.strokeRect(region.x, region.y, region.width, region.height);
    }
  }

  context.lineCap = "round";
  context.lineJoin = "round";
  for (const edge of edges) {
    const status = normalizeCirculationStatus(edge.status);
    if (status === "road") {
      context.strokeStyle = "rgba(9, 17, 29, 0.72)";
      context.lineWidth = edge.width + hairline * 2.5;
      strokeCirculationEdge(context, edge);
    }
    context.strokeStyle = edge.easement
      ? "rgba(238, 204, 116, 0.9)"
      : circulationRegionFill({ ...edge, use: edge.use ?? edge.load });
    context.lineWidth = edge.width;
    context.setLineDash(status === "trace"
      ? [2.5 / safeScale, 4.5 / safeScale]
      : edge.easement
        ? [8 / safeScale, 3 / safeScale]
        : []);
    strokeCirculationEdge(context, edge);
    context.setLineDash([]);
  }

  const connectedByNode = new Map();
  for (const edge of edges) {
    for (const nodeId of [edge.from, edge.to]) {
      if (nodeId === null || nodeId === undefined) continue;
      const key = identityKey(nodeId);
      if (!connectedByNode.has(key)) connectedByNode.set(key, []);
      connectedByNode.get(key).push(edge);
    }
  }
  for (const node of circulation.nodes) {
    const connected = connectedByNode.get(identityKey(node.id)) || [];
    if (connected.length === 0) continue;
    const radius = Math.max(...connected.map((edge) => edge.width)) / 2;
    const hierarchy = connected.sort(
      (first, second) => hierarchyRank(second.hierarchy) - hierarchyRank(first.hierarchy),
    )[0].hierarchy;
    context.fillStyle = circulationRegionFill({
      hierarchy,
      status: connected[0].status,
      use: connected[0].load,
    });
    context.beginPath();
    context.arc(node.x, node.y, radius, 0, Math.PI * 2);
    context.fill();
  }

  for (const edge of edges) {
    const congestion = circulationCongestionRatio(edge.load, edge.capacity, edge.congestion);
    if (congestion >= 0.5) {
      context.strokeStyle = circulationCongestionColor(edge.load, edge.capacity, edge.congestion);
      context.lineWidth = Math.max(hairline * 2.2, edge.width * 0.28);
      context.setLineDash(congestion >= 1 ? [4 / safeScale, 3 / safeScale] : []);
      strokeCirculationEdge(context, edge);
      context.setLineDash([]);
    }
    if (edge.hierarchy === "primary") {
      context.strokeStyle = "rgba(235, 226, 195, 0.52)";
      context.lineWidth = hairline;
      context.setLineDash([10 / safeScale, 8 / safeScale]);
      strokeCirculationEdge(context, edge);
      context.setLineDash([]);
    }
  }
  context.restore();
  return circulation;
}

export function resolveCirculationRoute(agent) {
  const route = agent?.circulationRoute;
  if (!route) return null;
  const input = Array.isArray(route) ? route : route.points;
  if (!Array.isArray(input)) return null;
  const points = input.slice(0, MAX_ROUTE_POINTS).flatMap((point) => {
    const resolved = resolveCirculationPoint(point);
    return resolved ? [resolved] : [];
  });
  if (points.length < 2) return null;
  return {
    points,
    status: !Array.isArray(route) && typeof route.status === "string" ? route.status : null,
    landId: !Array.isArray(route) ? route.landId ?? null : null,
    cellIds: !Array.isArray(route) && Array.isArray(route.cellIds)
      ? route.cellIds.slice(0, MAX_ROUTE_POINTS)
      : [],
  };
}

/** Draw only the selected agent's engine-authored circulation route. */
export function drawCirculationRoute(context, agent, { scale = 1 } = {}) {
  const route = resolveCirculationRoute(agent);
  if (!route || !context) return null;
  const safeScale = Math.max(0.0001, finiteNumber(scale, 1));
  const points = route.points;
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.strokeStyle = "rgba(10, 18, 31, 0.72)";
  context.lineWidth = 4.8 / safeScale;
  context.stroke();
  context.strokeStyle = "rgba(242, 122, 80, 0.96)";
  context.lineWidth = 2 / safeScale;
  context.setLineDash([7 / safeScale, 5 / safeScale]);
  context.stroke();
  context.setLineDash([]);

  const end = points.at(-1);
  const previous = points.at(-2);
  const angle = Math.atan2(end.y - previous.y, end.x - previous.x);
  const arrow = 7 / safeScale;
  context.fillStyle = "rgba(242, 122, 80, 0.98)";
  context.beginPath();
  context.moveTo(end.x, end.y);
  context.lineTo(end.x - Math.cos(angle - 0.55) * arrow, end.y - Math.sin(angle - 0.55) * arrow);
  context.lineTo(end.x - Math.cos(angle + 0.55) * arrow, end.y - Math.sin(angle + 0.55) * arrow);
  context.closePath();
  context.fill();
  context.restore();
  return route;
}

/** Draw a resolved frame.land layer in world coordinates. */
export function drawTerritory(context, value, {
  scale = 1,
  selectedLandId = null,
  tenureVisible = true,
} = {}) {
  const grid = resolveLandGrid(value);
  if (!grid || !context) return null;
  const safeScale = Math.max(0.0001, finiteNumber(scale, 1));
  const hairline = 1 / safeScale;
  const continuousFlow = circulationSource(value)?.kind === "emergent-flow-network";

  context.save();
  for (const cell of grid.cells) {
    const bounds = landCellBounds(grid, cell);
    if (tenureVisible && cell.state === "reserved") {
      context.fillStyle = "rgba(223, 168, 59, 0.16)";
      context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
      drawReservationHatch(context, bounds, safeScale);
    } else if (tenureVisible && cell.state === "claimed") {
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

  if (!continuousFlow) {
    context.strokeStyle = "rgba(220, 231, 251, 0.18)";
    context.lineWidth = hairline;
    for (const cell of grid.cells) {
      const bounds = landCellBounds(grid, cell);
      context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    }
  }

  const boundaries = tenureVisible ? parcelBoundarySegments(grid) : [];
  if (boundaries.length > 0) {
    context.strokeStyle = "rgba(247, 241, 227, 0.84)";
    context.lineWidth = hairline * 2.2;
    strokeSegments(context, boundaries);
  }

  for (const cell of tenureVisible ? grid.cells : []) {
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

/** Movement/public-way cells first, then the independent plot/tenure layer. */
export function drawTerritoryLayers(context, value, options = {}) {
  const circulation = resolveCirculation(value);
  drawPublicRealm(context, circulation, options);
  const land = drawTerritory(context, value, options);
  return { circulation, land };
}
