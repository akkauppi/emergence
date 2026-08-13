const DEFAULT_MIN_SIZE = 8;
const DEFAULT_BLOCK_WIDTH = 96;
const DEFAULT_BLOCK_HEIGHT = 72;
const DEFAULT_GATE_RADIUS = 34;
const DEFAULT_MIN_GATE_RADIUS = 18;
const DEFAULT_MAX_GATE_RADIUS = 70;
const MAX_GRID_AXIS = 100;

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finitePoint(point) {
  if (!point || typeof point !== "object") return null;
  const x = finiteNumber(point.x);
  const y = finiteNumber(point.y);
  return x === null || y === null ? null : { x, y };
}

function positiveSize(value, fallback) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function canonicalRect(rect) {
  if (!rect || typeof rect !== "object") return null;
  const x = finiteNumber(rect.x ?? rect.position?.x);
  const y = finiteNumber(rect.y ?? rect.position?.y);
  const width = finiteNumber(rect.width ?? rect.w ?? rect.size?.width);
  const height = finiteNumber(rect.height ?? rect.h ?? rect.size?.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function canonicalCircle(circle) {
  if (!circle || typeof circle !== "object") return null;
  const centre = finitePoint(circle.position ?? circle);
  const radius = finiteNumber(circle.radius ?? circle.r);
  if (!centre || radius === null || radius <= 0) return null;
  return { ...centre, radius };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Converts a pointer gesture into a canonical, top-left rectangle.
 *
 * A click (`dragged: false`) creates a default-sized rectangle centred on the
 * pointer. A drag uses its two corners. When finite world dimensions are
 * supplied, the result is kept wholly inside the world.
 */
export function normalizeLayoutRect(detail, {
  width,
  height,
  defaultWidth = DEFAULT_BLOCK_WIDTH,
  defaultHeight = DEFAULT_BLOCK_HEIGHT,
  minSize = DEFAULT_MIN_SIZE,
} = {}) {
  const start = finitePoint(detail?.start);
  const end = finitePoint(detail?.end ?? detail?.start);
  if (!start || !end) return null;

  const minimum = positiveSize(minSize, DEFAULT_MIN_SIZE);
  const worldWidth = positiveSize(width, null);
  const worldHeight = positiveSize(height, null);
  if ((width !== undefined && worldWidth === null) || (height !== undefined && worldHeight === null)) return null;

  let rect;
  if (detail.dragged === false) {
    let rectWidth = positiveSize(defaultWidth, DEFAULT_BLOCK_WIDTH);
    let rectHeight = positiveSize(defaultHeight, DEFAULT_BLOCK_HEIGHT);
    if (worldWidth !== null) rectWidth = Math.min(rectWidth, worldWidth);
    if (worldHeight !== null) rectHeight = Math.min(rectHeight, worldHeight);
    rect = {
      x: start.x - rectWidth / 2,
      y: start.y - rectHeight / 2,
      width: rectWidth,
      height: rectHeight,
    };
    if (worldWidth !== null) rect.x = clamp(rect.x, 0, worldWidth - rect.width);
    if (worldHeight !== null) rect.y = clamp(rect.y, 0, worldHeight - rect.height);
  } else {
    const first = {
      x: worldWidth === null ? start.x : clamp(start.x, 0, worldWidth),
      y: worldHeight === null ? start.y : clamp(start.y, 0, worldHeight),
    };
    const second = {
      x: worldWidth === null ? end.x : clamp(end.x, 0, worldWidth),
      y: worldHeight === null ? end.y : clamp(end.y, 0, worldHeight),
    };
    rect = {
      x: Math.min(first.x, second.x),
      y: Math.min(first.y, second.y),
      width: Math.abs(second.x - first.x),
      height: Math.abs(second.y - first.y),
    };
  }

  if (rect.width < minimum || rect.height < minimum) return null;
  return rect;
}

/**
 * Converts a click or radial drag into a circular destination gate.
 * The gesture starts at the centre; its drag distance sets the radius.
 */
export function normalizeGate(detail, {
  width,
  height,
  defaultRadius = DEFAULT_GATE_RADIUS,
  minRadius = DEFAULT_MIN_GATE_RADIUS,
  maxRadius = DEFAULT_MAX_GATE_RADIUS,
} = {}) {
  const start = finitePoint(detail?.start);
  const end = finitePoint(detail?.end ?? detail?.start);
  if (!start || !end) return null;

  const worldWidth = positiveSize(width, null);
  const worldHeight = positiveSize(height, null);
  if ((width !== undefined && worldWidth === null) || (height !== undefined && worldHeight === null)) return null;

  let minimum = positiveSize(minRadius, DEFAULT_MIN_GATE_RADIUS);
  let maximum = positiveSize(maxRadius, DEFAULT_MAX_GATE_RADIUS);
  if (worldWidth !== null) maximum = Math.min(maximum, worldWidth / 2);
  if (worldHeight !== null) maximum = Math.min(maximum, worldHeight / 2);
  if (maximum <= 0) return null;
  minimum = Math.min(minimum, maximum);

  const requestedRadius = detail.dragged === false
    ? positiveSize(defaultRadius, DEFAULT_GATE_RADIUS)
    : Math.hypot(end.x - start.x, end.y - start.y);
  const radius = clamp(requestedRadius, minimum, maximum);
  return {
    x: worldWidth === null ? start.x : clamp(start.x, radius, worldWidth - radius),
    y: worldHeight === null ? start.y : clamp(start.y, radius, worldHeight - radius),
    radius,
  };
}

/** Splits bounds into a row-major grid of canonical rectangles. */
export function generateBlockGrid(bounds, {
  rows = 2,
  columns = 2,
  gap = 12,
  minSize = DEFAULT_MIN_SIZE,
} = {}) {
  const rect = canonicalRect(bounds);
  const rowCount = Math.floor(finiteNumber(rows, 0));
  const columnCount = Math.floor(finiteNumber(columns, 0));
  const spacing = finiteNumber(gap, -1);
  const minimum = positiveSize(minSize, DEFAULT_MIN_SIZE);
  if (
    !rect
    || rowCount < 1
    || columnCount < 1
    || rowCount > MAX_GRID_AXIS
    || columnCount > MAX_GRID_AXIS
    || spacing < 0
  ) return [];

  const cellWidth = (rect.width - spacing * (columnCount - 1)) / columnCount;
  const cellHeight = (rect.height - spacing * (rowCount - 1)) / rowCount;
  if (cellWidth < minimum || cellHeight < minimum) return [];

  const cells = [];
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      cells.push({
        x: rect.x + column * (cellWidth + spacing),
        y: rect.y + row * (cellHeight + spacing),
        width: cellWidth,
        height: cellHeight,
      });
    }
  }
  return cells;
}

/** Creates row-major obstacle records ready for an environment definition. */
export function createBlockGrid(bounds, {
  rows = 2,
  columns = 2,
  gap = 12,
  idPrefix = "block",
  minSize = DEFAULT_MIN_SIZE,
} = {}) {
  const prefix = String(idPrefix || "block");
  return generateBlockGrid(bounds, { rows, columns, gap, minSize }).map((rect, index) => ({
    id: `${prefix}-${index + 1}`,
    ...rect,
    label: "",
  }));
}

export function pointInRect(point, rect) {
  const candidate = finitePoint(point);
  const bounds = canonicalRect(rect);
  return Boolean(candidate && bounds
    && candidate.x >= bounds.x
    && candidate.x <= bounds.x + bounds.width
    && candidate.y >= bounds.y
    && candidate.y <= bounds.y + bounds.height);
}

export function pointInCircle(point, circle) {
  const candidate = finitePoint(point);
  const bounds = canonicalCircle(circle);
  return Boolean(candidate && bounds
    && Math.hypot(candidate.x - bounds.x, candidate.y - bounds.y) <= bounds.radius);
}

export function rectsOverlap(firstRect, secondRect, padding = 0) {
  const first = canonicalRect(firstRect);
  const second = canonicalRect(secondRect);
  const clearance = Math.max(0, finiteNumber(padding, 0));
  if (!first || !second) return false;
  return first.x < second.x + second.width + clearance
    && first.x + first.width + clearance > second.x
    && first.y < second.y + second.height + clearance
    && first.y + first.height + clearance > second.y;
}

export function circleOverlapsRect(circle, rect, padding = 0) {
  const boundsCircle = canonicalCircle(circle);
  const bounds = canonicalRect(rect);
  const clearance = Math.max(0, finiteNumber(padding, 0));
  if (!boundsCircle || !bounds) return false;
  const nearestX = clamp(boundsCircle.x, bounds.x, bounds.x + bounds.width);
  const nearestY = clamp(boundsCircle.y, bounds.y, bounds.y + bounds.height);
  return Math.hypot(boundsCircle.x - nearestX, boundsCircle.y - nearestY) < boundsCircle.radius + clearance;
}

export function circlesOverlap(firstCircle, secondCircle, padding = 0) {
  const first = canonicalCircle(firstCircle);
  const second = canonicalCircle(secondCircle);
  const clearance = Math.max(0, finiteNumber(padding, 0));
  if (!first || !second) return false;
  return Math.hypot(first.x - second.x, first.y - second.y)
    < first.radius + second.radius + clearance;
}

/** Finds the first existing obstacle or destination made invalid by a placement. */
export function placementConflict(candidateRects, {
  obstacles = [],
  destinations = [],
  destinationClearance = 0,
  minimumDestinationRadius = 0,
  ignoreIds = [],
} = {}) {
  const candidates = (Array.isArray(candidateRects) ? candidateRects : [candidateRects])
    .map(canonicalRect);
  if (candidates.length === 0 || candidates.some((rect) => rect === null)) {
    return { type: "invalid", id: null };
  }

  const ignored = new Set(Array.from(ignoreIds || [], (id) => String(id)));
  for (const obstacle of Array.isArray(obstacles) ? obstacles : []) {
    if (ignored.has(String(obstacle?.id))) continue;
    if (candidates.some((candidate) => rectsOverlap(candidate, obstacle))) {
      return { type: "obstacle", id: obstacle?.id ?? null };
    }
  }

  for (const destination of Array.isArray(destinations) ? destinations : []) {
    if (ignored.has(String(destination?.id))) continue;
    const gate = canonicalCircle(destination);
    if (!gate) continue;
    const effectiveGate = {
      ...gate,
      radius: Math.max(gate.radius, Math.max(0, finiteNumber(minimumDestinationRadius, 0))),
    };
    if (candidates.some((candidate) => circleOverlapsRect(effectiveGate, candidate, destinationClearance))) {
      return { type: "destination", id: destination?.id ?? null };
    }
  }
  return null;
}

/** Finds the first block or existing gate made invalid by new circular gates. */
export function gatePlacementConflict(candidateGates, {
  obstacles = [],
  destinations = [],
  obstacleClearance = 0,
  gateClearance = 0,
  minimumGateRadius = 0,
  ignoreIds = [],
} = {}) {
  const candidates = (Array.isArray(candidateGates) ? candidateGates : [candidateGates])
    .map(canonicalCircle);
  if (candidates.length === 0 || candidates.some((circle) => circle === null)) {
    return { type: "invalid", id: null };
  }

  const ignored = new Set(Array.from(ignoreIds || [], (id) => String(id)));
  for (const obstacle of Array.isArray(obstacles) ? obstacles : []) {
    if (ignored.has(String(obstacle?.id))) continue;
    if (candidates.some((candidate) => circleOverlapsRect(candidate, obstacle, obstacleClearance))) {
      return { type: "obstacle", id: obstacle?.id ?? null };
    }
  }

  for (const destination of Array.isArray(destinations) ? destinations : []) {
    if (ignored.has(String(destination?.id))) continue;
    const existing = canonicalCircle(destination);
    if (!existing) continue;
    const minimumRadius = Math.max(0, finiteNumber(minimumGateRadius, 0));
    const effectiveExisting = { ...existing, radius: Math.max(existing.radius, minimumRadius) };
    if (candidates.some((candidate) => circlesOverlap(
      { ...candidate, radius: Math.max(candidate.radius, minimumRadius) },
      effectiveExisting,
      gateClearance,
    ))) {
      return { type: "destination", id: destination?.id ?? null };
    }
  }
  return null;
}
