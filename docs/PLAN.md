# Emergence Lab: product and implementation plan

## 1. Purpose

Emergence Lab should let students move fluidly between an embodied experiment and a computational one. It is not intended to make a simulation look authoritative. It should make assumptions visible, comparisons reproducible, and surprising outcomes discussable.

The recurring classroom loop is:

> **Predict → run → measure → change one rule → rerun with the same seed → explain.**

The long-term destination is an extensible agent-based urban morphology laboratory. Moving people are the first domain. Persistent traces, land tenure, buildings, parcels, and street networks come later as independent world layers.

## 2. Translation of the physical experiment

Every agent chooses two distinct people at reset and keeps those references for the whole run. Choices are private in the embodied exercise; in the web version they are normally hidden but can be revealed for one selected person.

The first paired rules are:

1. **Convergent — put yourself between two people.** Move toward the midpoint of the two chosen people. Repeated averaging tends to contract the group.
2. **Divergent — keep a shield between you and someone else.** Choose person A and person B, then move to the far side of B from A. The desired position is beyond B along the A→B line. This relationship can propagate movement outward until environmental limits matter.

The engine adds a small collision response as a physical constraint, analogous to personal space. It does not silently add social attraction or repulsion.

Two supporting presets help separate the ingredients:

- **Equal distance:** approach the perpendicular bisector of the selected pair without requiring the agent to stand between them.
- **Complete a triangle:** approach the nearer third corner of an equilateral triangle, exposing geometric frustration when overlapping local goals conflict.
- **Chiral triangle:** always use the same side of the ordered A→B base, showing how a small shared convention can break symmetry and create circulation.
- **Seeded wander:** a null model for distinguishing structured emergence from random motion and boundary effects.

All social presets can read earlier observations through `sense(delayTicks)`. A selected
agent shows those delayed references as ghosts, making the model's information lag
visible. Dragging a person creates one atomic intervention at a recorded tick, zeros
their velocity, preserves their relationships, and then lets the cascade continue.
The current slice records intervention metadata but does not yet export or replay it.

## 3. MVP scope and acceptance criteria

The current milestone is a movement laboratory suitable for a ten-minute classroom demonstration and a longer student experiment.

It is complete when:

- resetting with the same seed recreates positions, velocities, and social references;
- all agents decide from one frozen tick snapshot before any position changes;
- convergent and divergent outcomes are visually and numerically distinct;
- students can edit a short behavior, apply it explicitly, and receive useful errors;
- broken or infinite code cannot permanently freeze the page;
- playback, stepping, reset, population, tempo, trails, and relationship overlays work by keyboard;
- the layout works on a projected desktop and a narrow laptop or phone;
- at least 180 agents run smoothly on an ordinary laptop;
- the app has no network dependency during a lesson.

## 4. Architecture

```text
controls + editor ── commands ──> simulation worker
       │                              │
       │                        fixed-step engine
       │                        rule compiler/runtime
       │                              │
       └── canvas + metrics <── frames/errors
```

### Main thread

The main thread owns semantic controls, the text editor, Canvas 2D rendering, trails, metric history, presentation mode, and a heartbeat watchdog. Agent positions never enter a reactive component tree, which leaves a future framework migration inexpensive.

### Simulation worker

The worker owns the canonical world. It advances at a fixed `1/30 s` simulation step regardless of render rate. Tempo changes how many fixed ticks run per wall-clock interval; it never changes the equations.

Each tick has two phases:

1. Construct read-only observations from state at tick `t` and ask every behavior for an intent.
2. Validate and clamp all intents, then integrate and commit state `t + 1` together.

Stable numeric IDs, deterministic social references, and keyed random values make reruns comparable. Invalid numbers are rejected at the engine boundary.

### Student behavior API

The editable function receives bounded observations and returns an intent:

```js
function behave({ self, chosen, params, vec, random, tick, world }) {
  const target = vec.midpoint(chosen[0].position, chosen[1].position);
  return { acceleration: vec.seek(self, target, params.strength) };
}
```

Code cannot mutate canonical state through this API. Student rules follow a pure-function
contract and should use only their arguments; the current JavaScript runtime is not a
security boundary and cannot enforce purity against deliberately hostile code. Movement
is only the first intent family. The same boundary will later accept validated
`emitField`, `reserveLand`, `claimLand`, `build`, and `connect` intents.

### Runtime safety path

The current trusted-classroom prototype uses JavaScript evaluation in a disposable worker. The main thread terminates and rebuilds an unresponsive worker from the last known scenario. Before programs can be shared or loaded from URLs, replace evaluation with an embedded interpreter such as QuickJS/WASM, reject imports, impose instruction and memory limits, and expose only frozen plain data.

## 5. Teaching sequence

### Stage 1 — Movement laboratory (implemented foundation)

Learning questions:

- Is a global pattern possible without any agent seeing the whole group?
- How much does the final form depend on the relationship graph and starting seed?
- What changes when decisions are simultaneous rather than sequential?
- When does the room boundary become part of the behavior?

Measurements: radius of gyration, mean nearest-neighbour distance, relationship error, speed, and cluster count (cluster count is a near-term addition).

### Stage 2 — Interaction laboratory

Add local neighbourhood sensing, field of view, alignment, destinations, obstacles, and scalar fields. Repeated footfall reinforces a trail field and unused traces decay. Students can compare emergent desire paths, congestion, and landmark placement.

Measurements: polarization, connected components, trip length, detour ratio, trail concentration, density heat maps, and side-by-side metric histories.

### Stage 3 — Territory laboratory

Add an immutable land geometry layer plus independent layers for tenure, occupation, land use, and desirability. Arriving agents can reserve a cell or polygon, bid during conflict, claim after a reservation period, and release or subdivide holdings.

Initial land sequence:

1. Evaluate unclaimed sites by access, amenity, terrain, and neighbour preferences.
2. Submit a reservation intent rather than mutating land.
3. Resolve conflicts centrally with an explicit policy and seeded tie-break.
4. Require contiguous growth and optionally street frontage.
5. Turn successful claims into obstacles, destinations, or new trip demand.

Measurements: parcel area, frontage, depth, compactness, ownership concentration, conflicts, and landlocked plots.

### Stage 4 — Urban growth laboratory

Let movement and settlement reshape one another:

```text
movement → footfall → persistent paths → accessibility
    ↑                                      ↓
destinations ← buildings ← land claims ← suitability
```

The capstone is a deliberately limited “medieval-like” generative model, not a historical reconstruction. Households, craftspeople, and merchants arrive through gates; value market access, water, kin, frontage, and affordability differently; reinforce paths; claim plots; and subdivide high-value land. Optional walls and gate timing expose path dependence and constraint.

Useful comparisons include the same rules with different seeds, an early versus late wall, moving a market or gate, a hard frontage requirement versus a preference, an emergent network versus a planned grid, and two different processes that create similar-looking plans.

## 6. Engine evolution without a rewrite

The canonical state will grow into these independent stores:

```text
World
├── agents        stable IDs, position, velocity, kind, bounded memory
├── geometry      immutable cells/polygons and topology
├── tenure        owner, reservation, lease/expiry
├── occupation    buildings and physical obstructions
├── land use      current function, independent of ownership
├── scalar fields footfall, slope, desirability, pollution, value
└── network       path/street nodes, edges, capacity and condition
```

The public model should not assume that land is always a square grid. A grid is a good first implementation, while geometry references allow later parcels and imported maps.

Conflicting actions are grouped by target and resolved centrally. A reservation policy can rank bids or suitability, then use a deterministic hash of seed, tick, land ID, and agent ID for ties. This avoids both update-order bias and permanent preference for low agent IDs.

## 7. Product milestones

### 0.1 — Classroom movement slice

- Current playground, presets, editor, metrics, deterministic reset, responsive layout
- Equilateral/chiral geometry, delayed sensing, and recorded drag perturbations
- Add saved JSON run export/import and a checksum
- Add an A/B split view using the same seed
- Add cluster count and an annotated metric chart
- Conduct a keyboard and screen-reader pass

### 0.2 — Movement and traces

- Spatial hash behind a `NeighborIndex` interface
- Obstacles, origins/destinations, field of view, and heterogeneous agents
- Footfall field, decay, desire-path renderer, and scenario-authored metric panels
- Checkpoints/replay and downloadable CSV measurements

### 0.3 — Claims and parcels

- Land grid prototype with reservation/claim arbitration
- Access, budget, frontage, contiguous parcel growth, and parcel metrics
- Scenario versioning and instructor-authored locked parameters

### 0.4 — Streets and settlement

- Persistent graph derived from reinforced paths
- Building footprints and plot subdivision
- Markets, gates, water, walls, terrain, and multiple livelihood strategies
- Medieval-like capstone with explicit limitations and comparison worksheets

### 1.0 — Course authoring

- Saved lessons with prompts, allowed controls, reference runs, and debrief questions
- Secure interpreted student programs
- Shareable scenario files with migration/version checks
- Static offline package and optional learning-platform integration

## 8. Verification strategy

Headless engine tests should establish that:

- the same scenario, seed, code, and scheduled edits produce the same checksum after `N` ticks;
- changing storage order does not change simultaneous decisions;
- reset and checkpoint/restore continue identically;
- no accepted intent creates `NaN`, infinity, an invalid ID, or an out-of-bounds position;
- malformed behavior is isolated and reported;
- reservation conflicts and expiries are stable once land exists.

Browser checks should cover applying a behavior, a visible compactness trend change, worker recovery, resize without reset, mobile tabs, presentation mode, and all labeled controls.

## 9. Decisions to revisit with course material

- The exact wording and named variants of the embodied exercise
- Whether references are random, consciously chosen, nearest, or instructor-assigned
- Bounded room versus toroidal world and whether boundaries are visible from lesson one
- Whether personal-space collision is always enabled or made part of editable code
- The first morphology case study and what historical claims it is safe to make
- Export format needed by the university learning environment
