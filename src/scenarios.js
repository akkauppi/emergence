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

const desirePathSource = `function behave({ self, destination, obstacles, field, params, vec }) {
  if (!destination) return { acceleration: { x: 0, y: 0 } };

  const goal = { x: destination.x, y: destination.y };
  const forward = vec.unit(vec.subtract(goal, self.position));
  const lateral = { x: -forward.y, y: forward.x };

  // Compare footfall just ahead and to either side. A stronger trace can
  // recruit later walkers onto an earlier route; zero influence removes
  // that feedback while leaving the destinations and obstacle unchanged.
  const lookAhead = vec.add(self.position, vec.scale(forward, 42));
  const leftProbe = vec.add(lookAhead, vec.scale(lateral, 30));
  const rightProbe = vec.add(lookAhead, vec.scale(lateral, -30));
  const traceTurn = (
    field.sample(leftProbe) - field.sample(rightProbe)
  ) * params.trailInfluence;
  // Pairs leave each gate with opposite exploratory preferences. This avoids
  // baking a winning side into the preset while remaining seed-reproducible.
  const inheritedTurn = self.id % 4 < 2 ? -1 : 1;
  const turn = Math.abs(traceTurn) > 0.004
    ? (traceTurn > 0 ? 1 : -1)
    : inheritedTurn;

  let target = goal;
  const obstacle = obstacles[0];
  if (obstacle) {
    const clearance = 46;
    const rightEdge = obstacle.x + obstacle.width;
    const bottomEdge = obstacle.y + obstacle.height;
    const obstacleAhead = (
      forward.x >= 0
        ? self.position.x < rightEdge + clearance && goal.x > obstacle.x
        : self.position.x > obstacle.x - clearance && goal.x < rightEdge
    );
    const nearObstacleBand = (
      self.position.y > obstacle.y - clearance &&
      self.position.y < bottomEdge + clearance
    );

    if (obstacleAhead && nearObstacleBand) {
      // Use a near and far corner so the segment does not cut through the
      // rectangle. "Turn" is relative to the current walking direction.
      const goBelow = lateral.y * turn > 0;
      const routeY = goBelow ? bottomEdge + clearance : obstacle.y - clearance;
      const walkingRight = forward.x >= 0;
      const approaching = walkingRight
        ? self.position.x < obstacle.x - clearance * 0.35
        : self.position.x > rightEdge + clearance * 0.35;
      const routeX = walkingRight
        ? (approaching ? obstacle.x - clearance : rightEdge + clearance)
        : (approaching ? rightEdge + clearance : obstacle.x - clearance);
      target = { x: routeX, y: routeY };
    }
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
      "People make repeated trips between two destinations around one obstruction. Every footstep adds a fading trace; walkers sample the ground ahead, so routes that are used become more attractive to those who follow.",
    steps: ["Walk toward the other destination", "Route around the obstruction", "Prefer the stronger trace ahead"],
    question: "Before running: will traffic keep two equal routes, or will a small early advantage recruit later walkers into one shared path? Set trail influence to zero for the control run.",
    relationMode: "none",
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
        { id: "west", label: "West gate", x: 120, y: 325, radius: 34 },
        { id: "east", label: "East gate", x: 880, y: 325, radius: 34 },
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
