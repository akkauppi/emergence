const convergeSource = `function behave({ self, chosen, params, vec }) {
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

const shieldSource = `function behave({ self, chosen, params, vec }) {
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

const equidistantSource = `function behave({ self, chosen, params, vec }) {
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
    },
    controls: [
      { key: "strength", label: "Response strength", min: 0.4, max: 4, step: 0.1 },
      { key: "maxSpeed", label: "Walking speed", min: 30, max: 150, step: 2 },
      { key: "personalSpace", label: "Personal space", min: 0, max: 18, step: 1 },
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
    },
    controls: [
      { key: "strength", label: "Response strength", min: 0.4, max: 4, step: 0.1 },
      { key: "extension", label: "Distance beyond shield", min: 0.2, max: 1.8, step: 0.1 },
      { key: "maxSpeed", label: "Walking speed", min: 30, max: 150, step: 2 },
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
    },
    controls: [
      { key: "strength", label: "Response strength", min: 0.4, max: 4, step: 0.1 },
      { key: "maxSpeed", label: "Walking speed", min: 30, max: 150, step: 2 },
      { key: "personalSpace", label: "Personal space", min: 0, max: 18, step: 1 },
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
];

export function getScenario(id) {
  return scenarios.find((scenario) => scenario.id === id) || scenarios[0];
}

export function copyParameters(scenario) {
  return { ...scenario.params };
}
