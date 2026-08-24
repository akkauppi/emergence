# Emergence Lab: product and implementation plan

## 1. Purpose

Emergence Lab should let students move fluidly between an embodied experiment and a computational one. It is not intended to make a simulation look authoritative. It should make assumptions visible, comparisons reproducible, and surprising outcomes discussable.

The recurring classroom loop is:

> **Predict → run → measure → change one rule → rerun with the same seed → explain.**

The long-term destination is an extensible agent-based urban morphology laboratory. Moving people are the first domain. Persistent traces, land tenure, and the first movement-grown circulation network are implemented; buildings, occupation, and subdivision remain independent later world layers.

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

The first movement-to-morphology preset is now also implemented:

- **Reveal desire paths:** agents make repeat journeys among editable destination gates through an editable layout of rectangular blocks. Every step deposits footfall into a scalar field; the field fades, and the editable behavior compares the length and normalized field strength of all four side corridors around the next relevant block. This works for horizontal, vertical, and diagonal trips and is a feedback loop rather than a painted trail: movement changes the field and the field can change later movement.
- **Control comparison:** setting trail influence to zero preserves the same destinations, obstruction, people, and seed while removing only the field-to-movement feedback.
- **Scenario-authored measurement:** the preset replaces relationship match and spread history with trail concentration and its own concentration history.
- **Layout intervention:** a block can be drawn directly, or a configurable rows-by-columns block grid can be generated inside a dragged area. The default 36-unit street gap supports opposing movement, while narrower choices deliberately expose congestion and gridlock. Destination gates can be added, removed, renamed, resized at creation, and given relative likelihood weights. The previous gate is excluded from the next choice; zero-weight gates are excluded whenever a positive eligible choice exists, while an all-zero eligible set means equal choice. Erase, undo, clear, and preset restore support rapid comparisons. Each accepted edit restarts the run at tick zero with the same seed and clears the footfall field, so inherited traces cannot confound changed geometry or demand.

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
function behave({ self, chosen, destination, obstacles, field, params, vec, random, tick, world }) {
  const target = vec.midpoint(chosen[0].position, chosen[1].position);
  return { acceleration: vec.seek(self, target, params.strength) };
}
```

Code cannot mutate canonical state through this API. Student rules follow a pure-function
contract and should use only their arguments; the current JavaScript runtime is not a
security boundary and cannot enforce purity against deliberately hostile code. Movement
is no longer the only intent family: territory behaviors may now return one validated
`reserveLand` or `claimLand` intent next to their acceleration. Every intent is
collected before the tenure store changes. The same boundary can later add validated
`emitField`, `build`, and `connect` intents.

When a journey environment is enabled, `destination` identifies the agent's current
goal, `destinations` exposes the read-only weighted gate set, `obstacles` describes
read-only rectangular constraints, and the field API exposes normalized `sample(point)`
and `gradient(point, step)` queries. On arrival, the engine counts a trip and chooses a
different gate by relative likelihood using a seeded draw. Footfall deposition, decay,
field diffusion, obstacle collision, and journey reassignment remain engine-owned
mechanics; student code chooses only its steering acceleration.

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

### Stage 2 — Interaction laboratory (first vertical slice implemented)

Add local neighbourhood sensing, field of view, alignment, destinations, obstacles, and scalar fields. Repeated footfall reinforces a trail field and unused traces decay. Students can compare emergent desire paths, congestion, and landmark placement.

The current vertical slice includes editable weighted destination gates, editable
rectangular obstacles and block grids, repeated multi-gate journeys, obstacle collision,
a deposited/decaying footfall grid, behavior-level field sensing, a rendered heat field,
trip counts, and trail concentration. Its local navigation rule handles multiple blocks
and arbitrary gate directions deterministically without private agent memory. A bounded
local field of view is now implemented in Territory 03; heterogeneous traveller
preferences, congestion measures, and side-by-side comparison remain follow-ups.

Measurements: polarization, connected components, trip length, detour ratio, trail concentration, density heat maps, and side-by-side metric histories.

### Stage 3 — Territory laboratory

Add an immutable land geometry layer plus independent layers for tenure, occupation, land use, and desirability. Arriving agents can reserve a cell or polygon, bid during conflict, claim after a reservation period, and release or subdivide holdings.

The first territory–circulation vertical slice uses an immutable rectangular grid as
its internal tenure index, while movement and visible paths use continuous geometry:

- Every site has stable row-major identity, cardinal topology, and authored access,
  amenity, terrain, and cost values. Road frontage is derived from current adjacency to
  the movement-grown public network rather than fixed in advance.
- Every behavior in tick `t` reads the same frozen geometry-and-tenure snapshot and may
  submit at most one reservation or claim intent. Malformed intent structure aborts the
  tick before movement or tenure changes; a well-formed but ineligible action is a
  recorded domain rejection.
- The frozen land snapshot also marks cells touched by any walker's radius plus a small
  clearance. Behaviors avoid reserving or claiming those cells. Arbitration repeats the
  occupancy check against post-movement positions, closing the race where a walker enters
  a proposed site during the same tick.
- Reservation bids are grouped and resolved centrally. Higher priority wins; exact ties
  use a deterministic hash of seed, tick, land ID, and agent ID instead of storage order.
- A winning reservation is stamped with explicit maturity and expiry ticks. Only its
  owner may claim it while mature, active, and unoccupied. Territory uses a 60-tick
  maturation window; a busy reservation remains traversable and can still be preempted
  by public movement or expire.
- An owner's first claim must be beside sufficiently used public frontage. A stable
  subset of agents may settle, and each receives a deterministic target area of three
  to seven cells. Later claims share an edge with existing holdings, but do not need
  traffic on every interior growth cell. Reservations and same-tick claims cannot form
  a temporary bridge.
- There is no preset block or street grid. Entry cells provide the small public seed
  from which circulation can grow.
- Ordinary walkers retain a rough destination bearing but inspect only 13 candidate
  steps inside a bounded forward view. Current velocity supplies short path memory,
  while nearby fading footfall can outweigh the most direct visible step. Only local
  obstacles and the visible corners of the nearest blocking parcel are considered;
  walkers do not receive a completed route around the parcel.
- The frozen `circulation` observation exposes `route(landId)` for approaching a legal
  parcel frontage. Its cadastral support search remains deterministic, but ordinary
  journeys do not follow that grid: actual movement segments accumulate into an
  angle-preserving flow network. A live plot reservation remains contested space until
  either tenure or circulation wins it.
- Movement records use on traversed cells after every agent has decided. Thus every
  behavior in tick `t` observes the same use field from the end of tick `t − 1`.
- Settlement has a movement-only warm-up of 240 ticks. After that phase, an initial site
  needs at least 2 units of use on adjacent public frontage; higher frontage traffic
  raises suitability while traffic through the private site lowers it. Cells above 8
  units of through-use are ineligible for private tenure. This keeps early land choices
  from distorting routes and places parcels beside movement rather than on top of it.
- A route cell must remain above the public-use threshold across repeated active ticks
  before it is eligible for a public-way reservation. A new road cell must share a
  cardinal edge with an entry or the existing legal support network.
- Established support streets accumulate quiet ticks below a lower release threshold.
  A releasable leaf then returns to open land without disconnecting downstream streets;
  permanent entry seeds keep the remaining network anchored.
- Public-way and plot intents share an atomic arbitration phase. A cell cannot be both
  a cell-wide road and a private claim. A later pressure easement is a narrower overlay:
  tenure initially remains, while public passage is allowed only inside the surveyed
  centreline corridor. The remaining claimed cell stays collision-solid, and corridor
  mouths become bounded local wayfinding affordances rather than a completed route.
- Actual movement contributes short, angle-preserving segments to a fading flow network.
  A segment needs repeated active observations above a high-use threshold before it is
  promoted from a trace to a street. An established street that remains below a lower
  threshold for long enough degenerates back to a trace. These paths are rendered from
  continuous segments, not cadastral cell centres; the cell network remains only as
  legal support and for deterministic road/plot arbitration.
- Claimed land is a movement obstacle. Each journey records its original direct distance,
  distance already travelled, remaining straight-line distance, and current-step lost
  progress. Pressure rises only after both an absolute and relative detour threshold are
  exceeded, and only during a step that adds more travel than direct progress. The first
  claimed cell on the still-desired line receives that pressure, including its crossing
  position and angle. Once the pressure threshold is crossed, the site receives a narrow
  easement and becomes permeable without immediately removing ownership.
- A second, per-agent pressure path covers genuine immobility that the detour measure
  cannot see. It retains both consecutive hard-collision corrections and an 18-unit
  mobility anchor. Leaving the anchor radius resets the spatial count; remaining inside
  it for 75 ticks starts pressure only when claimed land crosses the direct desire line.
  Hard collisions target their exact cell. Brief contacts, slow progress through open
  space, and crowding without an intervening parcel therefore do not create easements.
- Easement traffic has its own fading use memory. Sustained use can propose public
  acquisition of the crossed cell. Land and circulation resolve that proposal atomically:
  ownership of the crossing is retired even when this cuts the parcel. The largest
  cardinally connected remainder survives, with a stable cell-ID tie-break; other
  components and any reservation stranded beside them return to open land. The permanent
  crossing remains an off-grid line and becomes a public anchor from which local support
  streets may grow; it does not render the full cadastral cell as an orthogonal street
  block.
- A provisional easement whose use falls below 1.5 for 120 ticks closes only while no
  walker is present in its support cell. Closure clears its residual pressure so it must
  be earned again; any renewed movement resets the quiet age. Acquired rights-of-way are
  permanent. Because tenure is still cell-based, acquisition retires the whole support
  cell and leaves its non-corridor remainder as open land; exact strip subdivision belongs
  with the later non-grid parcel geometry layer.
- The canvas distinguishes continuous traces, established paths, easements, plot
  reservations, contested cells, and claims. The unclaimed cadastral checkerboard is
  hidden in this mode so the movement geometry, rather than the storage topology,
  determines the composition.

Initial land sequence:

1. Choose locally within a bounded forward view and accumulate continuous,
   angle-preserving movement traces.
2. Promote only repeatedly reinforced traces, and retire streets after sustained low use.
3. After the warm-up, seed private parcels only on clear, low-through-use sites beside
   the busiest eligible frontage.
4. Grow each parcel contiguously toward a bounded target area, balancing compactness and suitability.
5. Accumulate pressure when claimed land imposes a substantial journey detour, a
   sustained hard collision, or prolonged movement inside a small spatial radius.
6. Open a narrow, reversible easement; close it after sustained disuse or acquire it
   after sustained use. If acquisition cuts a parcel, retain one connected side and
   release the rest.
7. Resolve road, plot, easement, and acquisition events deterministically and expose them for inspection.

This sequence retains deterministic cell-based tenure without forcing paths to inherit
its orthogonal shape. Remaining depth includes affordability and budget locking,
voluntary release and subdivision, non-grid parcel geometry, easement compensation,
capacity and maintenance, and coupling claims to occupation or demand. A plot claim
still does not create a building.

Measurements: parcel area, frontage, compactness, ownership concentration, travel use,
journey detour distance and ratio, trace and street counts, promotions and degenerations,
easements and acquired rights-of-way, road cells and growth, network components,
reservations, occupancy rejections, parcel severances, and road/plot conflicts.

#### Modeling rationale and organic-growth directions

The evidence survey, implementation decision, deterministic baseline, and alternatives
kept as separate experiments are recorded in [the urban-growth research notes](RESEARCH.md).

The implemented feedbacks are intentionally local. Reinforcement plus decay follows the
[active-walker account of pedestrian trail formation](https://arxiv.org/abs/cond-mat/9806097),
where repeated walking can produce a shared low-detour path system. Street support expands
beside existing use through local decisions, consistent with evidence that
[local optimization can generate realistic planar street patterns](https://arxiv.org/abs/0708.4360).
Ordinary edge-connected growth acts as *densification*, while a heavily used acquired
crossing acts as a new *exploration* anchor—two recurring mechanisms identified in
[empirical road-network evolution](https://www.nature.com/articles/srep00296).

The next useful experiments should add one feedback at a time: let accessibility around
high-use junctions attract new destinations and density, following
[density–topology co-evolution models](https://arxiv.org/abs/0810.1376); give agents
heterogeneous distance, direction-change, amenity, and affordability preferences; then
test density-dependent subdivision, congestion, and street capacity. A controllable
aggregation-versus-diffusion parameter could expose compact growth and sprawl without
prescribing either morphology, as explored in
[urban morphogenesis models](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0203516).

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
- Obstacles and repeat origin/destination journeys (implemented for editable rectangular blocks, block grids, and weighted multi-gate destinations)
- Footfall field, decay, desire-path renderer, and scenario-authored metric panels (implemented foundation)
- Direct-manipulation layout tools with same-seed, cleared-field restarts (implemented)
- Bounded field of view in Territory (implemented); heterogeneous agents or
  traveller-specific destination preferences remain
- Checkpoints/replay and downloadable CSV measurements

### 0.3 — Claims and parcels

- Land grid prototype with reservation/claim arbitration (implemented foundation)
- Attributed access, terrain, cost and frontage plus contiguous parcel growth and parcel metrics (implemented foundation)
- Add agent budgets, bid locks/refunds, and hard affordability/frontage policies
- Add voluntary release, general subdivision, and non-grid parcel geometry
- Scenario versioning and instructor-authored locked parameters

### 0.4 — Streets and settlement

- Preferred-route cell search, fading movement-use traces, hysteretic public-way
  formation/release, shared road/plot arbitration, and a cardinal legal support network
  behind continuous street geometry (implemented foundation)
- Derive variable-width street geometry, hierarchy, capacity, and condition from the
  cell network and its accumulated use
- Building footprints, occupation, and plot subdivision
- Agent budgets and the coupling of affordability, claims, and settlement
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
- desire-path agents remain finite, bounded, and outside obstacles while completing horizontal, vertical, and diagonal journeys through central, regular-grid, staggered-grid, and weighted multi-gate layouts;
- every territory behavior in a tick observes the same tenure snapshot, contested cells resolve independently of agent storage order, and an invalid intent leaves the whole tick unchanged;
- reservations mature and expire at exact documented ticks, occupied cells cannot become
  reservations or claims, no cell is double-owned, every owner's surviving claimed cells
  remain cardinally connected, and reservation conflicts and expiries replay exactly;
- parcel-access routes break equal-cost ties deterministically, while ordinary movement
  produces replayable continuous flow segments with multiple orientations;
- every behavior sees the same prior-tick use snapshot, and only a repeatedly traversed
  cell can receive a valid public-way reservation;
- continuous traces require repeated high use before promotion, and promoted segments
  plus non-entry support streets deterministically degenerate after sustained low use;
- simultaneous public-way and plot intents for one cell produce one deterministic
  winner, never dual allocation, and the result is unchanged by agent storage order;
- every committed cell-wide public way remains connected to an entry, earlier road, or
  acquired right-of-way anchor; claimed sites remain blocked until a journey exceeds
  deterministic detour thresholds, after which an easement preserves the owner while
  recording use through the site;
- sustained easement use can retire ownership and sever a parcel deterministically;
  one connected component survives, released sides return to open land, and accepted
  acquisitions replay as permanent off-grid public anchors;
- for the same scenario, seed, behavior, parameters, population, and scheduled
  interventions, agents, tenure, route use, road growth, conflicts, and checksum replay
  exactly; tick chunking and agent storage order do not change the result.

Browser checks should cover applying a behavior, a visible compactness trend change, worker recovery, resize without reset, mobile tabs, presentation mode, and all labeled controls.

## 9. Decisions to revisit with course material

- The exact wording and named variants of the embodied exercise
- Whether references are random, consciously chosen, nearest, or instructor-assigned
- Bounded room versus toroidal world and whether boundaries are visible from lesson one
- Whether personal-space collision is always enabled or made part of editable code
- The first morphology case study and what historical claims it is safe to make
- Export format needed by the university learning environment
