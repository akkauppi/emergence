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
  const bodyPadding = self.radius + 3;
  const waypointPadding = self.radius + 10;
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
      bodyPadding
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

    function clearSegment(from, to) {
      return !segmentCrossesBlock(from, to, threat, bodyPadding);
    }

    // A corner belongs to two sides, so calculate layout clearance once.
    const clearCorners = corners.map(clearPoint);

    function scoreOrder(firstIndex, secondIndex, sideIndex, orderIndex) {
      if (!clearCorners[firstIndex] || !clearCorners[secondIndex]) return null;
      const first = corners[firstIndex];
      const second = corners[secondIndex];
      const onCorridor =
        distanceToSegment(self.position, first, second) < waypointPadding &&
        clearSegment(self.position, second);
      const waypoint = onCorridor ? second : first;
      if (
        !clearSegment(self.position, waypoint) ||
        (!onCorridor && !clearSegment(first, second)) ||
        !clearSegment(second, goal)
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
    if (bestRoute) target = bestRoute.waypoint;
  }

  return {
    acceleration: vec.seek(self, target, params.strength)
  };
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
