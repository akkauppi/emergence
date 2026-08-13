export const SQRT_THREE_OVER_TWO = Math.sqrt(3) / 2;

/**
 * Return an equilateral apex for the ordered base A → B.
 * Canvas coordinates point downward, so +1 is the visually clockwise side.
 */
export function equilateralApex(a, b, chirality = 1) {
  const side = Number(chirality) < 0 ? -1 : 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return {
    x: (a.x + b.x) / 2 + side * -dy * SQRT_THREE_OVER_TWO,
    y: (a.y + b.y) / 2 + side * dx * SQRT_THREE_OVER_TWO,
  };
}

export function nearestEquilateralApex(self, a, b, tieBreaker = 1) {
  const clockwise = equilateralApex(a, b, 1);
  const counterclockwise = equilateralApex(a, b, -1);
  const clockwiseDistance = Math.hypot(self.x - clockwise.x, self.y - clockwise.y);
  const counterclockwiseDistance = Math.hypot(self.x - counterclockwise.x, self.y - counterclockwise.y);

  if (Math.abs(clockwiseDistance - counterclockwiseDistance) < 1e-9) {
    return tieBreaker < 0 ? counterclockwise : clockwise;
  }
  return clockwiseDistance < counterclockwiseDistance ? clockwise : counterclockwise;
}

export function clampWorldPoint(point, radius, width, height) {
  return {
    x: Math.max(radius, Math.min(width - radius, point.x)),
    y: Math.max(radius, Math.min(height - radius, point.y)),
  };
}
