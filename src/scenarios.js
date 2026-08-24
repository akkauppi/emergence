const convergeSource = `function behave({ self, params, vec, sense }) {
  const { chosen } = sense(params.delayTicks);
  const [personA, personB] = chosen;

  // Put yourself halfway between the same two people.
  const target = vec.midpoint(
    personA.position,
    personB.position
  );

  return {
    acceleration: vec.seek(
      self,
      target,
      params.strength
    )
  };
}`;

const shieldSource = `function behave({ self, params, vec, sense }) {
  const { chosen } = sense(params.delayTicks);
  const [person, shield] = chosen;

  // Stand beyond the shield, away from the person.
  const personToShield = vec.subtract(
    shield.position,
    person.position
  );
  const target = vec.add(
    shield.position,
    vec.scale(personToShield, params.extension)
  );

  return {
    acceleration: vec.seek(
      self,
      target,
      params.strength
    )
  };
}`;

const equidistantSource = `function behave({ self, params, vec, sense }) {
  const { chosen } = sense(params.delayTicks);
  const [personA, personB] = chosen;
  const midpoint = vec.midpoint(
    personA.position,
    personB.position
  );
  const axis = vec.unit(
    vec.subtract(personB.position, personA.position)
  );

  // Move only enough to become equally distant from A and B.
  const offset = vec.subtract(self.position, midpoint);
  const target = vec.subtract(
    self.position,
    vec.scale(axis, vec.dot(offset, axis))
  );

  return {
    acceleration: vec.seek(self, target, params.strength)
  };
}`;

const nearestTriangleSource = `function behave({ self, params, vec, sense }) {
  const { chosen } = sense(params.delayTicks);
  const [personA, personB] = chosen;

  // Two equilateral triangles fit the same base.
  // Choose whichever third corner is nearer to you.
  const target = vec.nearestEquilateral(
    self.position,
    personA.position,
    personB.position,
    self.id % 2 === 0 ? 1 : -1
  );

  return {
    acceleration: vec.seek(self, target, params.strength)
  };
}`;

const chiralTriangleSource = `function behave({ self, params, vec, sense }) {
  const { chosen } = sense(params.delayTicks);
  const [personA, personB] = chosen;

  // The order A → B matters. Everyone uses the same side.
  const target = vec.equilateral(
    personA.position,
    personB.position,
    params.chirality
  );

  return {
    acceleration: vec.seek(self, target, params.strength)
  };
}`;

const wanderSource = `function behave({ self, params, random }) {
  // A seeded null model: no person follows anybody else.
  const angle = random("turn") * Math.PI * 2;

  return {
    acceleration: {
      x: Math.cos(angle) * params.wanderForce,
      y: Math.sin(angle) * params.wanderForce
    }
  };
}`;

const desirePathSource = `function segmentCrossesBlock(from, to, block, padding) {
  // Clip the journey segment against a padded rectangle. Padding leaves room
  // for the walker's body rather than treating people as dimensionless dots.
  const bounds = {
    left: block.x - padding,
    right: block.x + block.width + padding,
    top: block.y - padding,
    bottom: block.y + block.height + padding
  };
  const delta = { x: to.x - from.x, y: to.y - from.y };
  let entry = 0;
  let exit = 1;

  for (const axis of ["x", "y"]) {
    const low = axis === "x" ? bounds.left : bounds.top;
    const high = axis === "x" ? bounds.right : bounds.bottom;
    if (Math.abs(delta[axis]) < 0.000001) {
      if (from[axis] < low || from[axis] > high) return false;
      continue;
    }
    const first = (low - from[axis]) / delta[axis];
    const second = (high - from[axis]) / delta[axis];
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (entry > exit) return false;
  }
  return exit >= 0 && entry <= 1;
}

function distanceToBlock(point, block) {
  const dx = Math.max(block.x - point.x, 0, point.x - block.x - block.width);
  const dy = Math.max(block.y - point.y, 0, point.y - block.y - block.height);
  return Math.hypot(dx, dy);
}

function distanceToSegment(point, from, to) {
  const segment = { x: to.x - from.x, y: to.y - from.y };
  const lengthSquared = segment.x * segment.x + segment.y * segment.y;
  if (lengthSquared < 0.000001) {
    return Math.hypot(point.x - from.x, point.y - from.y);
  }
  const projection = Math.max(0, Math.min(1,
    ((point.x - from.x) * segment.x +
      (point.y - from.y) * segment.y) / lengthSquared
  ));
  return Math.hypot(
    point.x - (from.x + segment.x * projection),
    point.y - (from.y + segment.y * projection)
  );
}

function behave({ self, destination, obstacles, field, params, vec, world }) {
  if (!destination) return { acceleration: { x: 0, y: 0 } };

  const goal = { x: destination.x, y: destination.y };
  const forward = vec.unit(vec.subtract(goal, self.position));

  let target = goal;
  // Detection looks slightly ahead of the physical body. Route visibility
  // uses the physical body so a person already touching a wall may leave it.
  const detectionPadding = self.radius + 3;
  const initialRoutePadding = Math.max(0, self.radius - 0.1);
  const routePadding = self.radius + 0.5;
  const waypointPadding = self.radius + 4;
  let threat = null;
  let threatScore = Infinity;

  // Find the nearest rectangle that blocks the direct route. A very close
  // rectangle also counts as a threat, which prevents clipping a corner when
  // the desired path changes between neighbouring blocks.
  for (const block of obstacles) {
    const centre = {
      x: block.x + block.width / 2,
      y: block.y + block.height / 2
    };
    const ahead = vec.dot(vec.subtract(centre, self.position), forward);
    const distance = distanceToBlock(self.position, block);
    const blocking = segmentCrossesBlock(
      self.position,
      goal,
      block,
      detectionPadding
    );
    const nearby = distance < waypointPadding * 1.35 && ahead > -waypointPadding;
    if (!blocking && !nearby) continue;

    // Direct blockers outrank incidental nearby blocks. IDs make an exact
    // geometric tie independent of the order in the obstacles array.
    const score = distance + (blocking ? 0 : waypointPadding * 4);
    const key = String(block.id);
    if (
      score < threatScore - 0.000001 ||
      (Math.abs(score - threatScore) <= 0.000001 && key < String(threat?.id))
    ) {
      threat = block;
      threatScore = score;
    }
  }

  if (threat) {
    const left = threat.x - waypointPadding;
    const right = threat.x + threat.width + waypointPadding;
    const top = threat.y - waypointPadding;
    const bottom = threat.y + threat.height + waypointPadding;
    const corners = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom }
    ];
    // Each pair is one side of the padded block: top, right, bottom, left.
    // Trying both orders lets the same code handle horizontal, vertical and
    // diagonal trips without naming a privileged direction.
    const sides = [[0, 1], [1, 2], [2, 3], [3, 0]];

    function insideWorld(point) {
      const margin = self.radius + 2;
      return point.x >= margin && point.x <= world.width - margin &&
        point.y >= margin && point.y <= world.height - margin;
    }

    function clearPoint(point) {
      if (!insideWorld(point)) return false;
      return obstacles.every((block) =>
        distanceToBlock(point, block) >= self.radius + 2
      );
    }

    function clearInitialSegment(to) {
      // Collision resolution leaves the centre exactly one radius from a
      // face. Test the first leg against the physical body, with a tiny
      // tolerance, so an outward/tangential route remains visible at contact
      // but a route through the block to a far-side corner never does.
      return !segmentCrossesBlock(
        self.position,
        to,
        threat,
        initialRoutePadding
      );
    }

    function clearSideSegment(from, to) {
      return !segmentCrossesBlock(from, to, threat, routePadding);
    }

    function clearsThreat(from, to) {
      return !segmentCrossesBlock(from, to, threat, routePadding);
    }

    // A corner belongs to two sides, so calculate layout clearance once.
    const clearCorners = corners.map(clearPoint);

    function scoreOrder(firstIndex, secondIndex, sideIndex, orderIndex) {
      if (!clearCorners[firstIndex] || !clearCorners[secondIndex]) return null;
      const first = corners[firstIndex];
      const second = corners[secondIndex];
      const onCorridor =
        distanceToSegment(self.position, first, second) < waypointPadding &&
        clearInitialSegment(second);
      const waypoint = onCorridor ? second : first;
      if (
        !clearInitialSegment(waypoint) ||
        (!onCorridor && !clearSideSegment(first, second)) ||
        !clearsThreat(second, goal)
      ) return null;

      const middle = vec.midpoint(first, second);
      const distance = vec.distance(self.position, waypoint) +
        (onCorridor ? 0 : vec.distance(first, second)) +
        vec.distance(second, goal);
      // field.sample() is normalized to 0–1, so this score stays meaningful
      // when the total number of walkers or the field's age changes.
      const trace = (
        field.sample(first) +
        field.sample(middle) +
        field.sample(second)
      ) / 3;
      return {
        waypoint,
        score: distance - trace * params.trailInfluence * 180,
        // This only decides near-exact ties. It splits walkers reproducibly
        // without depending on obstacle-array order or mutable memory.
        tieRank: ((sideIndex + self.id) % 4) * 2 + orderIndex
      };
    }

    let bestRoute = null;
    for (let sideIndex = 0; sideIndex < sides.length; sideIndex += 1) {
      const [firstIndex, secondIndex] = sides[sideIndex];
      const orders = [
        scoreOrder(firstIndex, secondIndex, sideIndex, 0),
        scoreOrder(secondIndex, firstIndex, sideIndex, 1)
      ];
      for (const route of orders) {
        if (!route) continue;
        const clearlyShorter = !bestRoute || route.score < bestRoute.score - 0.75;
        const tied = bestRoute && Math.abs(route.score - bestRoute.score) <= 0.75;
        if (clearlyShorter || (tied && route.tieRank < bestRoute.tieRank)) {
          bestRoute = route;
        }
      }
    }
    if (bestRoute) {
      target = bestRoute.waypoint;
    } else if (distanceToBlock(self.position, threat) <= routePadding + 0.5) {
      // A locally sealed or unusually narrow arrangement can invalidate the
      // full two-corner templates. Never respond by seeking the gate through
      // the contacted face. Follow one of that face's ends instead, which
      // gives collision resolution an outward/tangential acceleration and a
      // chance to re-plan from the next position.
      const faces = [
        { distance: Math.abs(self.position.y - threat.y), corners: [0, 1], normal: { x: 0, y: -1 } },
        { distance: Math.abs(self.position.x - (threat.x + threat.width)), corners: [1, 2], normal: { x: 1, y: 0 } },
        { distance: Math.abs(self.position.y - (threat.y + threat.height)), corners: [2, 3], normal: { x: 0, y: 1 } },
        { distance: Math.abs(self.position.x - threat.x), corners: [3, 0], normal: { x: -1, y: 0 } }
      ].sort((a, b) => a.distance - b.distance);
      const escapes = faces[0].corners
        .filter((index) => clearCorners[index] && clearInitialSegment(corners[index]))
        .map((index, order) => ({
          waypoint: corners[index],
          score: vec.distance(self.position, corners[index]) +
            vec.distance(corners[index], goal) -
            field.sample(corners[index]) * params.trailInfluence * 120,
          tieRank: (order + self.id) % 2
        }))
        .sort((a, b) => a.score - b.score || a.tieRank - b.tieRank);
      target = escapes[0]?.waypoint || {
        x: self.position.x + faces[0].normal.x * (routePadding + 2),
        y: self.position.y + faces[0].normal.y * (routePadding + 2)
      };
    }
  }

  return {
    acceleration: vec.seek(self, target, params.strength)
  };
}`;

const territoryGrowthSource = `function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function attribute(cell, key, fallback = 0) {
  const attributes = cell.attributes || cell.suitability || {};
  return finite(cell[key] ?? attributes[key], fallback);
}

function centreOf(cell) {
  const width = finite(cell.width ?? cell.size?.width ?? cell.cellSize, 0);
  const height = finite(cell.height ?? cell.size?.height ?? cell.cellSize, 0);
  return {
    x: finite(cell.center?.x ?? cell.position?.x, finite(cell.x) + width / 2),
    y: finite(cell.center?.y ?? cell.position?.y, finite(cell.y) + height / 2)
  };
}

function idOf(value) {
  if (value && typeof value === "object") {
    return String(value.landId ?? value.cellId ?? value.id ?? "");
  }
  return value === undefined || value === null ? "" : String(value);
}

function segmentCrossesBlock(from, to, block, padding) {
  const bounds = {
    left: finite(block.x) - padding,
    right: finite(block.x) + finite(block.width) + padding,
    top: finite(block.y) - padding,
    bottom: finite(block.y) + finite(block.height) + padding
  };
  const delta = { x: to.x - from.x, y: to.y - from.y };
  let entry = 0;
  let exit = 1;
  for (const axis of ["x", "y"]) {
    const low = axis === "x" ? bounds.left : bounds.top;
    const high = axis === "x" ? bounds.right : bounds.bottom;
    if (Math.abs(delta[axis]) < 0.000001) {
      if (from[axis] < low || from[axis] > high) return false;
      continue;
    }
    const first = (low - from[axis]) / delta[axis];
    const second = (high - from[axis]) / delta[axis];
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (entry > exit) return false;
  }
  return exit >= 0 && entry <= 1;
}

function distanceToBlock(point, block) {
  const dx = Math.max(
    finite(block.x) - point.x,
    0,
    point.x - finite(block.x) - finite(block.width)
  );
  const dy = Math.max(
    finite(block.y) - point.y,
    0,
    point.y - finite(block.y) - finite(block.height)
  );
  return Math.hypot(dx, dy);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function angleDifference(first, second) {
  return Math.atan2(Math.sin(first - second), Math.cos(first - second));
}

// Keep a rough global bearing, but make the next step from only a bounded
// forward view. This avoids giving every walker the same complete route around
// a parcel. Velocity supplies short, physical path memory; fading footfall is
// the shared local affordance left by earlier walkers.
function preferredWaypoint(self, goal, obstacles, field, params, world) {
  const position = self.position;
  const radius = Math.max(0, finite(self.radius, 0));
  const toGoal = { x: goal.x - position.x, y: goal.y - position.y };
  const goalDistance = Math.hypot(toGoal.x, toGoal.y);
  if (goalDistance <= Math.max(1, radius * 2)) return goal;

  const viewDepth = Math.min(
    goalDistance,
    Math.max(radius * 3, finite(params.viewDepth, 70))
  );
  const fullView = clamp(finite(params.viewAngle, 110), 45, 170) * Math.PI / 180;
  const halfView = fullView / 2;
  const goalAngle = Math.atan2(toGoal.y, toGoal.x);
  const velocity = self.velocity || { x: 0, y: 0 };
  const speed = Math.hypot(finite(velocity.x), finite(velocity.y));
  const motionAngle = speed > 0.5
    ? Math.atan2(finite(velocity.y), finite(velocity.x))
    : goalAngle;
  const momentumLimit = clamp(finite(params.routeMomentum, 0.55), 0, 0.85);
  const speedReference = Math.max(1, finite(params.maxSpeed, 80) * 0.35);
  const momentum = momentumLimit * clamp(speed / speedReference, 0, 1);
  const centreX = Math.cos(goalAngle) * (1 - momentum) + Math.cos(motionAngle) * momentum;
  const centreY = Math.sin(goalAngle) * (1 - momentum) + Math.sin(motionAngle) * momentum;
  const centreAngle = Math.atan2(centreY, centreX);
  const sample = typeof field?.sample === "function"
    ? (point) => clamp(finite(field.sample(point)), 0, 1)
    : () => 0;
  const margin = radius + 2;
  const insideWorld = (point) => point.x >= margin && point.x <= world.width - margin &&
    point.y >= margin && point.y <= world.height - margin;

  // Candidate segments cannot reach obstacles farther away than the bounded
  // view, so subsequent clearance checks inspect only this local subset.
  const localObstacles = obstacles.filter((block) =>
    distanceToBlock(position, block) <= viewDepth + radius + 6
  );
  const routePadding = Math.max(0, radius - 0.15);
  const clearsLocalObstacles = (point) => localObstacles.every((block) =>
    !segmentCrossesBlock(position, point, block, routePadding)
  );

  const stableRank = (Math.imul(Math.round(finite(self.id)) + 1, 2654435761) >>> 0) /
    4294967296;
  const handedness = stableRank < 0.5 ? -1 : 1;
  const trailInfluence = Math.max(0, finite(params.trailInfluence, 1));
  let best = null;

  function consider(point, rank, kind = "view") {
    if (!insideWorld(point) || !clearsLocalObstacles(point)) return;
    const stepX = point.x - position.x;
    const stepY = point.y - position.y;
    const stepLength = Math.hypot(stepX, stepY);
    if (stepLength < 0.000001) return;
    const angle = Math.atan2(stepY, stepX);
    const goalDelta = angleDifference(angle, goalAngle);
    const motionDelta = angleDifference(angle, motionAngle);
    const progress = (goalDistance - Math.hypot(goal.x - point.x, goal.y - point.y)) /
      stepLength;
    const directness = Math.cos(goalDelta);
    const continuity = speed > 0.5 ? Math.cos(motionDelta) : directness;
    const middle = {
      x: position.x + stepX * 0.55,
      y: position.y + stepY * 0.55
    };
    const trace = sample(middle) * 0.35 + sample(point) * 0.65;
    const sideAffinity = handedness * Math.sin(goalDelta) * 0.06;
    const score =
      progress * 2.4 +
      directness * 0.7 +
      continuity * 0.75 +
      trace * trailInfluence * 2.2 +
      sideAffinity -
      (kind === "corner" ? 0.08 : 0);
    const candidate = { point, score, rank };
    if (
      !best ||
      candidate.score > best.score + 0.000001 ||
      (Math.abs(candidate.score - best.score) <= 0.000001 && candidate.rank < best.rank)
    ) best = candidate;
  }

  // Thirteen deterministic rays are enough to distinguish local alternatives
  // without turning each agent step into a graph search.
  const candidateCount = 13;
  for (let index = 0; index < candidateCount; index += 1) {
    const offset = -halfView + fullView * index / (candidateCount - 1);
    const angle = centreAngle + offset;
    consider({
      x: position.x + Math.cos(angle) * viewDepth,
      y: position.y + Math.sin(angle) * viewDepth
    }, Math.abs(index - (candidateCount - 1) / 2) * 2 +
      (handedness < 0 ? index : candidateCount - index));
  }

  // A nearby blocking rectangle exposes only its padded corners as additional
  // local affordances. We do not inspect or score the complete route beyond it.
  let threat = null;
  let threatDistance = Infinity;
  for (const block of localObstacles) {
    if (!segmentCrossesBlock(position, goal, block, radius + 2)) continue;
    const distance = distanceToBlock(position, block);
    const key = String(block.id);
    if (
      distance < threatDistance - 0.000001 ||
      (Math.abs(distance - threatDistance) <= 0.000001 && key < String(threat?.id))
    ) {
      threat = block;
      threatDistance = distance;
    }
  }

  if (threat) {
    const cornerPadding = radius + 4;
    const corners = [
      { x: finite(threat.x) - cornerPadding, y: finite(threat.y) - cornerPadding },
      { x: finite(threat.x) + finite(threat.width) + cornerPadding, y: finite(threat.y) - cornerPadding },
      { x: finite(threat.x) + finite(threat.width) + cornerPadding, y: finite(threat.y) + finite(threat.height) + cornerPadding },
      { x: finite(threat.x) - cornerPadding, y: finite(threat.y) + finite(threat.height) + cornerPadding }
    ];
    for (let index = 0; index < corners.length; index += 1) {
      const corner = corners[index];
      const distance = Math.hypot(corner.x - position.x, corner.y - position.y);
      const offset = Math.abs(angleDifference(
        Math.atan2(corner.y - position.y, corner.x - position.x),
        centreAngle
      ));
      if (distance <= viewDepth * 1.35 && offset <= halfView + Math.PI / 9) {
        consider(corner, candidateCount * 2 + ((index + Math.round(self.id)) % 4), "corner");
      }
    }
  }

  if (best) return best.point;

  // At a sealed face, move outward before looking again on the next tick. This
  // is a local collision escape, not a hidden route planner.
  if (threat || localObstacles.length > 0) {
    const nearest = threat || [...localObstacles].sort((first, second) =>
      distanceToBlock(position, first) - distanceToBlock(position, second) ||
      String(first.id).localeCompare(String(second.id))
    )[0];
    const faces = [
      { distance: Math.abs(position.y - finite(nearest.y)), normal: { x: 0, y: -1 } },
      { distance: Math.abs(position.x - finite(nearest.x) - finite(nearest.width)), normal: { x: 1, y: 0 } },
      { distance: Math.abs(position.y - finite(nearest.y) - finite(nearest.height)), normal: { x: 0, y: 1 } },
      { distance: Math.abs(position.x - finite(nearest.x)), normal: { x: -1, y: 0 } }
    ].sort((first, second) => first.distance - second.distance);
    return {
      x: position.x + faces[0].normal.x * (radius + 3),
      y: position.y + faces[0].normal.y * (radius + 3)
    };
  }
  return goal;
}

function behave({ self, destination, obstacles, field, params, vec, world, land, circulation, tick = 0 }) {
  const stop = { acceleration: { x: 0, y: 0 } };
  const goalX = Number(destination?.x);
  const goalY = Number(destination?.y);
  const hasJourney = Number.isFinite(goalX) && Number.isFinite(goalY);
  const walkingTarget = hasJourney
    ? preferredWaypoint(
      self,
      { x: goalX, y: goalY },
      Array.isArray(obstacles) ? obstacles : [],
      field,
      params,
      world
    )
    : null;
  const movement = walkingTarget
    ? { acceleration: vec.seek(self, walkingTarget, params.strength) }
    : stop;

  // Land is optional while switching scenarios. Movement remains a complete
  // gate-to-gate rule even if the settlement layer is unavailable.
  if (!land?.enabled || !Array.isArray(land.cells)) return movement;

  // Establish the movement pattern before settlement starts competing for
  // cells. Early reservations otherwise pull edge-spawned walkers back to
  // whichever quiet parcel they happen to reach first.
  const settlementStartTick = Math.max(0, Math.round(finite(params.settlementStartTick, 0)));
  if (tick < settlementStartTick) return movement;

  function resolveCell(value) {
    const id = idOf(value);
    if (!id) return null;
    const resolved = typeof land.cell === "function" ? land.cell(id) : null;
    if (resolved) return resolved;
    if (value && typeof value === "object") return value;
    return land.cells.find((cell) => idOf(cell) === id) || null;
  }

  function circulationCell(cell) {
    const id = idOf(cell);
    const observed = typeof circulation?.cell === "function"
      ? circulation.cell(id)
      : null;
    const explicitlyPublic = typeof circulation?.isPublic === "function"
      ? circulation.isPublic(id) === true
      : false;
    const role = explicitlyPublic ? "road" : String(
      observed?.role ?? cell.circulation?.role ?? cell.role ?? "open"
    );
    const centre = centreOf(cell);
    const sampledUse = typeof field?.sample === "function"
      ? field.sample(centre)
      : 0;
    const observedUse = typeof circulation?.usage === "function"
      ? circulation.usage(id)
      : observed?.use;
    const useValue = observedUse && typeof observedUse === "object"
      ? observedUse.use
      : observedUse;
    return {
      role,
      use: Math.max(0, finite(useValue ?? cell.movementUse, sampledUse))
    };
  }

  const mineInput = typeof land.mine === "function" ? land.mine() : land.mine;
  const mine = (Array.isArray(mineInput) ? mineInput : [])
    .map(resolveCell)
    .filter(Boolean);
  const mineIds = new Set(mine.map(idOf));

  function frontageTraffic(cell) {
    if (!cell || typeof land.neighbors !== "function") return 0;
    return Math.max(0, ...(land.neighbors(idOf(cell)) || [])
      .map(resolveCell)
      .filter(Boolean)
      .map((neighbour) => {
        const publicState = circulationCell(neighbour);
        return publicState.role === "road" || publicState.role === "road-reserved"
          ? publicState.use
          : 0;
      }));
  }

  // A claimant approaches the public edge of an existing reservation, never
  // its centre. Until the reservation matures it remains part of the same
  // walkable open surface. A claim waits while anyone occupies the site, and
  // an active public route can still preempt the reservation.
  const reservation = land.reservation || null;
  if (reservation) {
    const reservedId = idOf(reservation);
    const route = typeof circulation?.route === "function"
      ? circulation.route(reservedId)
      : null;
    if (
      reservation.claimable === true &&
      reservation.occupied !== true &&
      route?.reachable !== false &&
      (route?.fronted === true || mine.length > 0) &&
      route?.arrived === true &&
      reservedId
    ) {
      return { ...movement, claimLand: { landId: reservedId } };
    }
    const waypointX = Number(route?.waypoint?.x);
    const waypointY = Number(route?.waypoint?.y);
    if (Number.isFinite(waypointX) && Number.isFinite(waypointY)) {
      return {
        acceleration: vec.seek(
          self,
          { x: waypointX, y: waypointY },
          params.strength
        )
      };
    }
    return movement;
  }

  const settlerShare = Math.max(0, Math.min(1, finite(params.settlerShare, 1)));
  const settlerRank = (Math.imul(Math.round(self.id), 2654435761) >>> 0) / 4294967296;
  if (mine.length === 0 && settlerRank >= settlerShare) return movement;

  const minimumParcelCells = Math.max(1, Math.round(finite(params.minimumParcelCells, 3)));
  const maximumParcelCells = Math.max(
    minimumParcelCells,
    Math.round(finite(params.maximumParcelCells, 7))
  );
  const targetParcelCells = minimumParcelCells +
    (self.id % (maximumParcelCells - minimumParcelCells + 1));
  if (mine.length >= targetParcelCells) return movement;

  function isAvailable(cell) {
    if (!cell || cell.buildable === false) return false;
    if (cell.occupied === true) return false;
    const owner = cell.ownerId ?? cell.owner ?? cell.claimedBy ??
      cell.tenure?.ownerId ?? cell.tenure?.owner;
    const reservedBy = cell.reservedBy ?? cell.reservation?.ownerId ??
      cell.tenure?.reservation?.ownerId;
    const state = cell.state ?? cell.tenure?.state;
    const publicState = circulationCell(cell);
    const privateLand = publicState.role !== "road" &&
      publicState.role !== "road-reserved" &&
      publicState.role !== "private";
    return privateLand && (owner === undefined || owner === null)
      ? (reservedBy === undefined || reservedBy === null) &&
        state !== "claimed" && state !== "reserved"
      : false;
  }

  // Once an owner has land, consider only cardinal neighbours of that parcel.
  // This makes connected growth an authored choice as well as an engine policy.
  const candidatesById = new Map();
  if (mine.length > 0 && typeof land.neighbors === "function") {
    for (const owned of mine) {
      for (const neighbour of land.neighbors(idOf(owned)) || []) {
        const cell = resolveCell(neighbour);
        if (isAvailable(cell)) {
          candidatesById.set(idOf(cell), cell);
        }
      }
    }
  } else {
    for (const entry of land.cells) {
      const cell = resolveCell(entry);
      if (isAvailable(cell) && distanceToBlock(self.position, cell) <= params.siteReach) {
        candidatesById.set(idOf(cell), cell);
      }
    }
  }

  const minimumSiteUse = Math.max(0, finite(params.minimumSiteUse, 0));
  const maximumSiteUse = Math.max(
    minimumSiteUse,
    finite(params.maximumSiteUse, Number.POSITIVE_INFINITY)
  );
  const candidates = [...candidatesById.values()].filter((cell) => (
    (mine.length > 0 || frontageTraffic(cell) >= minimumSiteUse) &&
    circulationCell(cell).use <= maximumSiteUse
  ));
  if (candidates.length === 0) return movement;

  const maximumFrontageTraffic = Math.max(
    minimumSiteUse,
    ...candidates.map(frontageTraffic),
  );

  const maximumCost = Math.max(
    1,
    ...land.cells.map((entry) => attribute(resolveCell(entry) || {}, "cost", 0))
  );
  let best = null;

  for (const cell of candidates) {
    const access = Math.max(0, Math.min(1, attribute(cell, "access")));
    const amenity = Math.max(0, Math.min(1, attribute(cell, "amenity")));
    const terrain = Math.max(0, Math.min(1, attribute(cell, "terrain")));
    const cost = Math.max(0, attribute(cell, "cost")) / maximumCost;
    const movementUse = Math.min(
      4,
      Math.max(0, circulationCell(cell).use) / Math.max(1, minimumSiteUse)
    );
    const trafficRank = frontageTraffic(cell) / maximumFrontageTraffic;
    const proximity = Math.max(0, 1 - distanceToBlock(self.position, cell) /
      Math.max(1, params.siteReach));

    const neighbours = typeof land.neighbors === "function"
      ? land.neighbors(idOf(cell)) || []
      : [];
    const sharedEdges = neighbours.reduce(
      (count, neighbour) => count + (mineIds.has(idOf(neighbour)) ? 1 : 0),
      0
    );
    const compactGrowth = neighbours.length > 0
      ? sharedEdges / neighbours.length
      : 0;

    const score =
      access * params.accessWeight +
      amenity * params.amenityWeight -
      (cost * 0.75 + terrain * 0.25) * params.costWeight -
      movementUse * params.throughRoutePenalty +
      trafficRank * params.trafficWeight +
      compactGrowth * params.growthBias +
      proximity * 0.35;
    const id = idOf(cell);

    if (
      !best ||
      score > best.score + 0.000001 ||
      (Math.abs(score - best.score) <= 0.000001 && id < best.id)
    ) {
      best = { id, score };
    }
  }

  if (!best) return movement;
  // Bids communicate relative suitability. Exact ties are resolved centrally
  // using the scenario seed, tick, land ID and agent ID.
  const growthBid = mine.length > 0 ? finite(params.growthBidBonus, 2) : 0;
  const bid = Math.max(0.01, Math.round((best.score + growthBid + 4) * 1_000) / 1_000);
  return { ...movement, reserveLand: { landId: best.id, bid } };
}`;

export const scenarios = [
  {
    id: "between",
    title: "Convergent · stand between two",
    shortTitle: "Stand between two people",
    kicker: "Convergent behaviour",
    description:
      "Each person privately chooses two others and repeatedly approaches their midpoint. Nobody knows the group centre, yet repeated local averaging can pull the whole system together.",
    steps: ["Choose two people", "Find their midpoint", "Move yourself toward it"],
    question: "Before running: will one cluster form, or several? What role will the hidden relationship graph play?",
    relationMode: "midpoint",
    matchLabel: "near chosen midpoint",
    source: convergeSource,
    params: {
      strength: 2.4,
      maxSpeed: 88,
      personalSpace: 5,
      delayTicks: 0,
    },
    controls: [
      { key: "strength", label: "Response strength", min: 0.4, max: 4, step: 0.1 },
      { key: "maxSpeed", label: "Walking speed", min: 30, max: 150, step: 2 },
      { key: "personalSpace", label: "Personal space", min: 0, max: 18, step: 1 },
      { key: "delayTicks", label: "Reaction delay", min: 0, max: 30, step: 1, unit: "tick" },
    ],
  },
  {
    id: "shield",
    title: "Divergent · keep one between",
    shortTitle: "Keep one person between",
    kicker: "Divergent behaviour",
    description:
      "Each person chooses someone and a shield, then tries to stay on the far side of the shield. The instruction is local, but chains of protection can push motion across the whole room.",
    steps: ["Choose a person", "Choose a shield", "Keep the shield between you"],
    question: "Before running: where can this rule ever settle? Watch when the boundary becomes part of the system.",
    relationMode: "shield",
    matchLabel: "shield correctly placed",
    source: shieldSource,
    params: {
      strength: 2.7,
      extension: 1,
      maxSpeed: 96,
      personalSpace: 5,
      delayTicks: 0,
    },
    controls: [
      { key: "strength", label: "Response strength", min: 0.4, max: 4, step: 0.1 },
      { key: "extension", label: "Distance beyond shield", min: 0.2, max: 1.8, step: 0.1 },
      { key: "maxSpeed", label: "Walking speed", min: 30, max: 150, step: 2 },
      { key: "delayTicks", label: "Reaction delay", min: 0, max: 30, step: 1, unit: "tick" },
    ],
  },
  {
    id: "equidistant",
    title: "Network · stay equally distant",
    shortTitle: "Stay equally distant",
    kicker: "Relational equilibrium",
    description:
      "Each person chooses two others and moves toward the nearest place that is equally distant from both. Unlike the midpoint rule, an entire line of positions can satisfy the instruction.",
    steps: ["Choose two people", "Compare both distances", "Balance the difference"],
    question: "Before running: does a rule with many valid answers converge, keep moving, or freeze into a loose network?",
    relationMode: "bisector",
    matchLabel: "distances balanced",
    source: equidistantSource,
    params: {
      strength: 2.1,
      maxSpeed: 82,
      personalSpace: 5,
      delayTicks: 0,
    },
    controls: [
      { key: "strength", label: "Response strength", min: 0.4, max: 4, step: 0.1 },
      { key: "maxSpeed", label: "Walking speed", min: 30, max: 150, step: 2 },
      { key: "personalSpace", label: "Personal space", min: 0, max: 18, step: 1 },
      { key: "delayTicks", label: "Reaction delay", min: 0, max: 30, step: 1, unit: "tick" },
    ],
  },
  {
    id: "triangle-nearest",
    title: "Geometry · complete a triangle",
    shortTitle: "Complete an equilateral triangle",
    kicker: "Geometric frustration",
    description:
      "Each person chooses two others and moves toward the nearer point that would complete an equilateral triangle. Every target is simple, but the overlapping triangles may be impossible to satisfy at once.",
    steps: ["Choose two people", "Imagine both third corners", "Move toward the nearer one"],
    question: "Before running: can everyone complete their triangle at once, or will conflicting targets keep the group moving?",
    relationMode: "equilateral-nearest",
    matchLabel: "near an equilateral corner",
    source: nearestTriangleSource,
    params: {
      strength: 2.2,
      maxSpeed: 88,
      personalSpace: 5,
      delayTicks: 0,
    },
    controls: [
      { key: "strength", label: "Response strength", min: 0.4, max: 4, step: 0.1 },
      { key: "maxSpeed", label: "Walking speed", min: 30, max: 150, step: 2 },
      { key: "personalSpace", label: "Personal space", min: 0, max: 18, step: 1 },
      { key: "delayTicks", label: "Reaction delay", min: 0, max: 30, step: 1, unit: "tick" },
    ],
  },
  {
    id: "triangle-chiral",
    title: "Chiral · choose one shared side",
    shortTitle: "Complete a one-sided triangle",
    kicker: "Broken symmetry",
    description:
      "Each person uses the ordered line from A to B and chooses the same side for the third corner. One shared left–right convention can turn restless local triangles into collective circulation.",
    steps: ["Choose A, then B", "Use one shared side of A → B", "Move toward the third corner"],
    question: "Before running: can one tiny directional convention make the whole group rotate? Flip it using the side control.",
    relationMode: "equilateral",
    matchLabel: "near the chosen triangle corner",
    source: chiralTriangleSource,
    params: {
      strength: 2.2,
      chirality: 1,
      maxSpeed: 88,
      personalSpace: 5,
      delayTicks: 0,
    },
    controls: [
      { key: "strength", label: "Response strength", min: 0.4, max: 4, step: 0.1 },
      {
        key: "chirality",
        label: "Shared side",
        type: "select",
        options: [
          { value: 1, label: "Clockwise" },
          { value: -1, label: "Counterclockwise" },
        ],
      },
      { key: "maxSpeed", label: "Walking speed", min: 30, max: 150, step: 2 },
      { key: "delayTicks", label: "Reaction delay", min: 0, max: 30, step: 1, unit: "tick" },
    ],
  },
  {
    id: "wander",
    title: "Baseline · seeded wander",
    shortTitle: "Seeded random movement",
    kicker: "Null model",
    description:
      "Nobody responds to anybody else. Momentum and small seeded turns create a baseline for deciding whether structure in another run really comes from its social rule.",
    steps: ["Keep momentum", "Turn a little", "Respond only to the room"],
    question: "Compare the spread chart with a social rule using the same seed. Which patterns are only chance or boundary effects?",
    relationMode: "none",
    matchLabel: "no relationship target",
    source: wanderSource,
    params: {
      wanderForce: 72,
      maxSpeed: 76,
      personalSpace: 5,
    },
    controls: [
      { key: "wanderForce", label: "Turning force", min: 5, max: 160, step: 5 },
      { key: "maxSpeed", label: "Walking speed", min: 30, max: 150, step: 2 },
      { key: "personalSpace", label: "Personal space", min: 0, max: 18, step: 1 },
    ],
  },
  {
    id: "desire-paths",
    title: "Trace · reveal desire paths",
    shortTitle: "Reveal desire paths",
    kicker: "Movement leaves a memory",
    stage: { number: "02", label: "Interaction laboratory / 02" },
    description:
      "People make repeated trips among editable, weighted destination gates through a layout of blocks. Every footstep adds a fading trace; walkers compare four ways around nearby blocks, so routes that are used become more attractive to those who follow.",
    steps: ["Place and weight destination gates", "Draw blocks or a block grid", "Prefer a shorter or stronger traced corridor"],
    question: "Before running: which gaps will become routes? Add a third gate or change its likelihood, then compare the same layout and seed with trail influence at zero.",
    relationMode: "none",
    editableLayout: true,
    editableDestinations: true,
    matchLabel: "footfall held by the busiest cells",
    summaryMetrics: [
      { label: "Completed trips", key: "trips", format: "integer", detail: "gate-to-gate arrivals" },
      { label: "Nearest neighbour", key: "nearest", format: "units", detail: "crowding along the route" },
    ],
    metric: {
      label: "Trail concentration",
      key: "trailConcentration",
      format: "fraction-percent",
      fallback: "forming…",
      detail: "footfall in busiest cells",
    },
    trend: {
      label: "Concentration trend",
      key: "trailConcentration",
      ariaLabel: "Recent trail concentration",
      minimumRange: 0.08,
    },
    source: desirePathSource,
    environment: {
      destinations: [
        { id: "west", label: "West gate", x: 120, y: 325, radius: 34, weight: 1 },
        { id: "east", label: "East gate", x: 880, y: 325, radius: 34, weight: 1 },
      ],
      obstacles: [
        { id: "central-block", x: 430, y: 230, width: 140, height: 190 },
      ],
      journeys: {
        enabled: true,
        spawnAtDestinations: true,
        arrivalRadius: 30,
      },
      field: {
        enabled: true,
        cellSize: 14,
        deposit: 1,
        decay: 0.006,
        diffusion: 0.06,
      },
    },
    params: {
      trailInfluence: 1,
      strength: 2.4,
      maxSpeed: 82,
      fieldPersistence: 0.994,
    },
    controls: [
      { key: "trailInfluence", label: "Trail influence", min: 0, max: 2, step: 0.05, format: "decimal-2" },
      { key: "strength", label: "Response strength", min: 0.4, max: 4, step: 0.1 },
      { key: "maxSpeed", label: "Walking speed", min: 30, max: 150, step: 2 },
      { key: "fieldPersistence", label: "Trace persistence", min: 0.96, max: 0.999, step: 0.001, format: "percent" },
    ],
  },
  {
    id: "territory-growth",
    title: "Territory · paths become streets",
    shortTitle: "Grow streets and territory",
    kicker: "Movement reserves the public realm",
    stage: { number: "03", label: "Territory laboratory / 03" },
    description:
      "People keep a rough destination bearing but choose each step from a bounded forward view, adapting to nearby traces and obstacles. Their continuous trajectories reinforce a fading off-grid flow network: only repeatedly used traces mature into streets, clear low-traffic sites beside surviving frontage become parcels, and costly detours or prolonged blockage can create crossings that eventually sever private land.",
    steps: [
      "Adapt locally within a forward view",
      "Promote only well-beaten paths",
      "Negotiate costly crossings",
    ],
    question:
      "Before running: will a narrower forward view create more branches, or merely longer trips? Change forward view, reset with the same seed, and compare surviving paths, settlement, and public crossings.",
    relationMode: "none",
    matchLabel: "claimed land held in compact parcels",
    summaryMetrics: [
      { label: "Claimed land", key: "claimedShare", format: "fraction-percent", detail: "buildable cells with an owner" },
      { label: "Public streets", key: "roadShare", format: "fraction-percent", detail: "cells sustained by repeated public use" },
    ],
    metric: {
      label: "Parcel compactness",
      key: "meanParcelCompactness",
      format: "fraction-percent",
      fallback: "forming…",
      detail: "mean edge-connected parcel shape",
    },
    trend: {
      label: "Claimed-land trend",
      key: "claimedShare",
      ariaLabel: "Recent share of land claimed",
      minimumRange: 1,
      domain: [0, 1],
    },
    source: territoryGrowthSource,
    environment: {
      land: {
        enabled: true,
        origin: { x: 20, y: 10 },
        columns: 24,
        rows: 15,
        cellSize: 40,
        gap: 0,
        attributes: {
          access: {
            sources: [
              { id: "west-gate", x: 20, y: 325, strength: 1 },
              { id: "east-gate", x: 980, y: 325, strength: 1 },
            ],
            falloff: 360,
          },
          amenity: {
            sources: [
              { id: "north-green", x: 500, y: 90, strength: 1 },
              { id: "south-well", x: 650, y: 535, strength: 0.78 },
            ],
            falloff: 245,
          },
          terrain: {
            seed: 2026,
            variation: 0.38,
          },
          cost: {
            base: 0.18,
            accessMultiplier: 0.55,
            amenityMultiplier: 0.25,
          },
          frontage: { edges: ["north", "east", "south", "west"] },
        },
        policy: {
          reservationTicks: 60,
          expiryTicks: 900,
          requireContiguous: true,
          occupancyClearance: 3,
          maxReservationsPerOwner: 1,
        },
      },
      destinations: [
        { id: "west", label: "West gate", x: 34, y: 325, radius: 28, weight: 1 },
        { id: "east", label: "East gate", x: 966, y: 325, radius: 28, weight: 1 },
        { id: "north", label: "North gate", x: 500, y: 24, radius: 24, weight: 0.55 },
        { id: "south", label: "South gate", x: 500, y: 626, radius: 24, weight: 0.55 },
      ],
      journeys: {
        enabled: true,
        spawnAtDestinations: true,
        arrivalRadius: 25,
      },
      field: {
        enabled: true,
        cellSize: 10,
        deposit: 1,
        decay: 0.006,
        diffusion: 0.04,
      },
      circulation: {
        enabled: true,
        sourceLayer: "land",
        entrySides: ["west", "east"],
        usePersistence: 0.94,
        reserveThreshold: 18,
        formationTicks: 10,
        releaseThreshold: 6,
        maturityTicks: 24,
        releaseTicks: 60,
        maxNewPerTick: 1,
        roadPreference: 0.45,
        trailPreference: 0.5,
        arrivalRadius: 12,
        flowResolution: 16,
        flowAngleBins: 24,
        flowPersistence: 0.96,
        flowTraceThreshold: 0.9,
        flowPathThreshold: 5.5,
        flowFormationTicks: 5,
        flowReleaseThreshold: 2,
        flowReleaseTicks: 45,
        pressurePersistence: 0.98,
        pressureDetourRatio: 1.18,
        pressureDetourDistance: 60,
        pressureContribution: 0.24,
        pressureStallTicks: 75,
        pressureStallDistance: 18,
        pressureStallMovementRatio: 0.3,
        pressureStallContribution: 0.14,
        easementPressureThreshold: 14,
        easementWidth: 15,
        easementUsePersistence: 0.97,
        easementAcquisitionThreshold: 15,
        easementAcquisitionTicks: 24,
      },
    },
    params: {
      trailInfluence: 1,
      viewAngle: 110,
      viewDepth: 70,
      routeMomentum: 0.55,
      throughRoutePenalty: 1.1,
      settlementStartTick: 240,
      minimumSiteUse: 2,
      maximumSiteUse: 8,
      trafficWeight: 1.8,
      settlerShare: 0.42,
      minimumParcelCells: 3,
      maximumParcelCells: 7,
      growthBidBonus: 2,
      siteReach: 52,
      accessWeight: 1.4,
      amenityWeight: 0.9,
      costWeight: 1.1,
      growthBias: 1.3,
      strength: 2.2,
      maxSpeed: 80,
      fieldPersistence: 0.994,
    },
    controls: [
      { key: "trailInfluence", label: "Preferred routes", min: 0, max: 2, step: 0.05, format: "decimal-2" },
      { key: "viewAngle", label: "Forward view", min: 60, max: 160, step: 5 },
      { key: "throughRoutePenalty", label: "Protect busy routes", min: 0, max: 3, step: 0.1 },
      { key: "accessWeight", label: "Access preference", min: 0, max: 3, step: 0.1 },
      { key: "amenityWeight", label: "Amenity preference", min: 0, max: 3, step: 0.1 },
      { key: "costWeight", label: "Cost sensitivity", min: 0, max: 3, step: 0.1 },
      { key: "growthBias", label: "Compact growth", min: 0, max: 3, step: 0.1 },
      { key: "strength", label: "Response strength", min: 0.4, max: 4, step: 0.1 },
      { key: "maxSpeed", label: "Walking speed", min: 30, max: 150, step: 2 },
      { key: "fieldPersistence", label: "Trace persistence", min: 0.96, max: 0.999, step: 0.001, format: "percent" },
    ],
  },
].map((scenario) => ({
  ...scenario,
  stage: scenario.stage || { number: "01", label: "Movement laboratory / 01" },
  summaryMetrics: scenario.summaryMetrics || [
    { label: "Group spread", key: "spread", format: "units", detail: "radius from centre" },
    { label: "Nearest neighbour", key: "nearest", format: "units", detail: "mean distance" },
  ],
  metric: scenario.metric || {
    label: "Rule match",
    key: "match",
    format: "percent",
    fallback: "baseline",
    detail: scenario.matchLabel,
  },
  trend: scenario.trend || {
    label: "Spread trend",
    key: "spread",
    ariaLabel: "Recent group spread",
    minimumRange: 8,
  },
}));

export function getScenario(id) {
  return scenarios.find((scenario) => scenario.id === id) || scenarios[0];
}

export function copyParameters(scenario) {
  return { ...scenario.params };
}
