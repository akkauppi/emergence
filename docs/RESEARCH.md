# Research notes: organic movement and urban growth

This note records the evidence considered for the Territory experiment, the
mechanism selected for implementation, and the alternatives deliberately kept
out of the same scenario. It is a design record, not a claim that the simulation
predicts real city growth.

## Decision summary

Territory 03 keeps one causal chain:

```text
bounded movement → fading traces → maintained streets → frontage settlement
       ↑                         ↑                         ↓
       ├── regional trips ───────┴──── mature parcel activities
       └─ costly detours or prolonged stalls → easements
                                            ↓
                               sustained-use acquisition
```

The latest mechanism is **bounded parcel-activity demand**, built on the earlier
bounded-view, locally adaptive wayfinding slice. Walkers still retain a rough bearing
toward their destination but choose only their next visible step. Mature parcels beside
surviving public frontage can now become local destinations, so settlement changes later
movement instead of remaining only an output layer.

This is not yet a land-use or building model: activity types are abstract trip purposes,
not households, jobs, floor area, production, or occupancy. Street capacity and
alternative network growth algorithms remain later experiments. Adding them
simultaneously would make visually interesting output easier to obtain but causal
explanations much harder to test.

## Evidence and implementation implications

| Evidence | Main result used here | Decision for Emergence Lab |
| --- | --- | --- |
| Ma et al., [*Simple agents – complex emergent path systems*](https://journals.sagepub.com/doi/10.1177/23998083231184884) and its [NetLogo source](https://github.com/LeiMazizizi/Agent-based-modelling-of-pedestrian-movement) | A global destination conception combined with local adaptation and a bounded view can generate desire-path systems. In the reported campus and hospital cases, viewing angle affected morphology more strongly than viewing depth; approximately 90–120° gave the best fit. | Use a 110° default forward view, a fixed local look-ahead, and local trace sampling. |
| Sharmin and Kamruzzaman, [shortest distance versus least directional change](https://www.sciencedirect.com/science/article/pii/S0966692318303867) | Both metric distance and directional change influence pedestrian route choice; least directional change was the stronger individual explanation in their sample. | Score progress and heading continuity rather than metric distance alone. |
| Filomena and Verstegen, [landmarks in pedestrian navigation](https://www.sciencedirect.com/science/article/pii/S0198971520303069), with [PedSimCity](https://github.com/g-filomena/PedSimCity) | Landmark-aware navigation produced more heterogeneous pedestrian distributions than pure minimization models and better matched several properties of observed GPS routes. | Let future activities or junctions become locally salient; do not add decorative landmarks with no causal role. |
| Filomena et al., [empirical pedestrian strategy heterogeneity](https://doi.org/10.1016/j.jenvp.2022.101807) | Empirical configurations changed where flows concentrated, but heterogeneous agent clusters differed only modestly from an empirically calibrated homogeneous population at the global level. | Improve the shared route-choice mechanism first. Avoid a large catalogue of personality types until a specific comparison requires it. |
| Santos et al., [procedural city generation using land-use/transport interaction](https://arxiv.org/abs/2211.01959) and [AutoPlanner source](https://github.com/LFRusso/autoplanner) | Accessibility and differentiated residential, commercial, industrial, and recreational uses can be coupled incrementally. | Let mature fronted parcels create a bounded first set of abstract activities and trips. Explicit occupancy and reinforcement learning are not required for this slice. |
| Levinson and Yerra, [self-organization of surface transportation networks](https://pubsonline.informs.org/doi/10.1287/trsc.1050.0132) | Coupled demand, cost, revenue, and investment can produce road hierarchy without a predefined hierarchy. | Later add capacity, condition, maintenance, and congestion as one coherent street-hierarchy experiment. |
| Barthélemy and Flammini, [local optimization of urban street patterns](https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.100.138702) | A local connection rule can reproduce several statistical properties of planar street networks better than grids or Voronoi tessellations. | Keep as a comparison between planned connectors and movement-grown paths, or use it when new activities need connection. |
| Tero et al., [adaptive biological network design](https://ora.ox.ac.uk/objects/uuid%3A01616eb5-3b21-4848-8b63-f909f34a83cc) | Reinforcement by flow plus decay balances transport cost, efficiency, and robustness. | A Physarum-style conductance network is a useful separate comparison. It overlaps too strongly with Territory's existing reinforcement loop to add here wholesale. |
| Raimbault, [aggregation and diffusion in urban morphogenesis](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0203516) and [model source](https://github.com/JusteRaimbault/Density) | Two opposing mesoscopic processes reproduce a broad range of observed density morphologies. | Build a separate macro-scale compact-growth/sprawl experiment; do not mix population-density diffusion into individual parcel tenure. |
| Webb, [2D space-colonization experiments](https://github.com/jasonwebb/2d-space-colonization-experiments) | Local attractors can grow open or looped branching networks, and accumulated flux can determine width. | Reuse flux as a possible width visualization or build a demand-seeking infrastructure comparison; do not bypass walkers in Territory. |

The linked repositories informed concepts and implementation structure only. No
source was copied into this project; several references use licenses that would
require care before code reuse.

## Implemented bounded-wayfinding rule

Each movement decision now:

1. Retains the destination as a weak global bearing.
2. Blends that bearing with current velocity, which acts as short physical memory.
3. Samples 13 deterministic candidate rays inside a bounded forward view.
4. Scores local progress, directional continuity, and fading footfall.
5. Rejects candidate segments crossing only the obstacles close enough to be visible.
6. Treats the nearest blocking parcel's visible corners as local affordances, without
   evaluating a complete route beyond the parcel.
7. Uses a tiny stable handedness preference to resolve symmetric alternatives without
   update-order or per-tick randomness.

The default full viewing angle is 110°, within the empirical range reported by
Ma et al. Look-ahead remains fixed at 70 world units because the cited study found
angle more consequential than depth. The angle is exposed as the single new lesson
control; the other implementation values stay fixed so the experiment does not become
a collection of unrelated knobs.

That bounded-wayfinding slice left settlement timing and suitability, trace promotion
and degeneration, easement formation, and acquisition unchanged. This isolated the
effect of information available to walkers before the stall-pressure follow-up below.

## Implemented stall-pressure rule

Detour pressure alone had a blind spot: a walker held almost stationary at a claimed
parcel added no extra travel, so the rule recorded zero lost-progress pressure. The
movement resolver now reports both the attempted pre-collision position and the exact
claimed cell responsible for the strongest collision correction.

Stall pressure is deliberately narrower than general delay:

1. Each journey keeps its own collision-stall count and an 18-unit mobility anchor;
   agents do not share frustration.
2. A hard-collision tick counts when a claimed cell corrects an intended move and actual
   displacement is at most 30% of intended displacement.
3. The mobility count catches the complementary failure: a walker can repeatedly change
   direction without a large collision correction yet remain inside the anchor radius.
   Ordinary movement resets this count by leaving the radius.
4. After a 75-tick grace period, a hard collision pressures its exact claimed cell. A
   spatial stall pressures only the first claimed cell on the direct desire line; crowding
   or slow movement in open space cannot punch land.
5. The contribution rises with continued immobility, up to four times its base value.
   Crossing the existing threshold opens the same narrow easement used by detour pressure;
   ownership remains in place, but movement becomes permeable immediately.

This also separates two rules that look similar in the picture. An easement may first
pass through the middle of a parcel without changing legal ownership. Later, sustained
traffic can acquire that crossing permanently even when it cuts the parcel. The largest
cardinally connected remainder survives (with a stable cell-ID tie-break); other
components and reservations attached only to them return to open land. This preserves
one parcel per owner without letting the old no-fragmentation guard veto a public cut.

The circulation frame now reports currently collision-blocked agents, spatially immobile
agents beyond the grace period, frustrated agents from either path, and both maximum
per-agent ages. These values, mobility anchors, and journey state participate in
deterministic replay checksums.

## Deterministic reference comparison

The following A/B run used seed 2026, 72 agents, the default Territory environment,
and no interventions. The baseline is the complete-route behavior at commit `02e273e`;
the candidate is the bounded-view rule. Values are deterministic but are not calibration
targets.

| Tick 720 metric | Complete-route baseline | Bounded view |
| --- | ---: | ---: |
| Active flow segments | 516 | 536 |
| Established flow segments | 64 | 87 |
| Trail concentration | 0.636 | 0.535 |
| Completed trips | 51 | 68 |
| Easements | 2 | 5 |
| Acquired rights-of-way | 1 | 2 |
| Mean journey detour ratio | 1.411 | 1.442 |
| Maximum journey detour ratio | 2.593 | 3.237 |

The result is consistent with the desired direction: movement is distributed across
more surviving paths and costly local frustration creates more crossings. Completed
trips increase rather than collapse, so lower concentration is not explained merely by
walkers wandering without arriving. The higher maximum detour is a warning as well as a
source of pressure.

A follow-up run of seeds 104, 613, 991, and 2026 at tick 720 produced 52–68 completed
trips, trail concentration from 0.510 to 0.583, and four or five easements. Visual
inspection found multiple non-orthogonal approaches and surviving side paths. This
small suite is a smoke test, not empirical calibration; broader seed and parameter
exploration remains useful.

On the development machine both 720-tick runs took approximately nine seconds. The
bounded rule limits obstacle clearance to a local subset and did not introduce a
material runtime regression in this reference run.

### Stall-pressure reference run

A later seed-2026 run at tick 2400 compared bounded wayfinding before and after stall
pressure. The pre-change run completed 176 trips, had 15 walkers below 1 world unit per
second, and contained 15 easements. With the default stall rule it completed 171 trips,
had 12 walkers below that speed, and contained 16 easements. One easement was caused by
a single collision stall that reached 223 ticks; the other 15 still came from detours.

This is evidence that the rule resolves its intended deadlock, not that it improves every
global outcome. The changed crossing also changes later settlement and routes, and the
single run completed five fewer trips. The rule should stay a bounded escape mechanism;
broader throughput claims require a multi-seed, longer-horizon comparison.

### Movement-first tenure follow-up

The next fixed-seed diagnosis found a different failure before pressure was relevant.
Reservations were traversable, but after only 18 ticks they could harden into claimed
obstacles around people still inside. In the seed-2026 run, 31 of 124 claims contained
at least one agent centre at the instant of claiming. Walkers then spent 11,017 aggregate
agent-ticks inside claimed, non-easement land; the longest uninterrupted enclosure lasted
1,872 ticks.

The revised tenure rule adds three gates: settlement waits 240 ticks for movement to
organize, reservations mature for 60 ticks, and cells touched by a walker plus 3 units of
clearance cannot be reserved or claimed. Sites above 8 units of through-use are also
protected. Occupancy is visible to every behavior from the same frozen pre-decision
snapshot and is checked again after movement during atomic arbitration.

At tick 2400, the revised run had zero claims formed around an agent, zero enclosed
agent-ticks, 250 completed trips, 8 walkers below 1 world unit per second, 110 claimed
cells, 36 support-road cells, 7 easements, and 5 acquired rights-of-way. The prior run had
171 trips, 12 slow walkers, 116 claimed cells, 23 support-road cells, 16 easements, and 8
acquired rights-of-way. The first reservation moved from tick 91 to 241 and the first
claim from 110 to 302. One acquired easement severed a parcel under the new rule.

These figures are a deterministic regression probe, not calibration. They do show that
settlement remains substantial while the specific enclosure defect disappears; the
lower easement count is consistent with land creating fewer conflicts in the first
place.

### Spatial-immobility follow-up

A second late-run diagnosis tested the movement-first version at ticks 1000, 1500, and
2000. Two independent seed-2026 engines and a reset replay had identical state at tick
2000 (`cdc83f72` before this follow-up), so the reported variation was not simulation
randomness. The genuine defect was narrower: 6, 10, and 6 walkers respectively travelled
less than 25 world units over the preceding 200 ticks without completing a trip. Several
oscillated inside a one-unit-wide range beside a parcel, but their collision-stall count
kept resetting to zero.

With the mobility-anchor rule, the same three stuck counts were 0, 0, and 0. At tick 2400
the run had 367 completed trips, 130 claimed cells, 39 support-road cells, 34 easements,
and 25 acquired rights-of-way. Of the 34 crossing events, 19 came from immobility alone,
8 combined detour and immobility, and 7 came from detour alone. This is a successful
deadlock regression but also a substantial increase in crossings; the count and visual
permeability should be treated as calibration signals rather than assumed improvements.
An independent candidate replay matched the tick-2000 checksum `581faf8a` exactly.

### Narrow, reversible easement follow-up

The mobility-anchor run still contained a geometric mismatch: a 15-unit easement was
drawn through a 40-unit cadastral cell, but collision treated the complete claimed cell
as permeable. The revised resolver keeps the claimed rectangle solid outside the
surveyed centreline envelope. Local wayfinding can recognize either corridor mouth and
cross only when its candidate segment remains within the strip; lateral drift meets a
corridor wall.

Provisional crossings now have a quiet age as well as fading use. Use below 1.5 for 120
ticks closes a crossing only if no walker occupies its support cell, and renewed use
resets that age. Closure clears the old pressure geometry. Acquisition is deliberately
slower at 24 use for 36 active ticks and remains permanent. The current tenure grid still
retires the whole acquired support cell, so its non-corridor remainder becomes open land;
representing separate corridor and residual ownership requires the later polygonal
parcel layer.

In the seed-2026 reference run, stuck counts at ticks 1000, 1500, 2000, and 2400 were
1, 1, 0, and 3 using the same 25-units-over-200-ticks probe. At tick 2400 the run had
325 completed trips, 45 active easements (34 acquired and 11 provisional), and 35 prior
provisional releases. These are healthier than a permanently accumulating overlay, but
the crossing count remains a calibration signal for the later activity-demand loop.

### Parcel activity-demand follow-up

The first demand loop adds one feedback and leaves buildings, explicit occupancy, and
street capacity out of scope:

1. Activity formation begins at tick 480, after the movement-only and early settlement
   phases. A parcel must have existed for 120 observations, contain at least two cells,
   satisfy its purpose-specific size floor, and touch a current public-way cell.
2. Its destination sits ten units outside the claimed cell on the busiest eligible
   public edge. That entrance remains fixed while the edge survives, so changing traffic
   does not make a walker's target jitter between parcel sides.
3. Eight simultaneous activities bound the feedback. The first eligible cohort balances
   homes, markets, workshops, wells, and greens before frequency permits repeats. Types
   carry different trip weights but are assigned with seeded, order-independent ties.
4. Tenure loss closes an activity immediately. Public-frontage loss starts a 90-tick
   grace period; recovery preserves the entrance, while sustained loss retires it.
5. Generated activities join the frozen weighted journey set but stay separate from
   authored, editable gates. After visiting an activity, a walker must next choose a
   regional gate. A gate arrival may choose another gate or a local activity. This
   regional/local alternation prevents parcel-to-parcel chains from taking over the
   movement pattern that originally produced frontage.
6. Openings, closures, active purposes, and local arrivals are framed, measured, rendered
   as diamond markers, and included in deterministic checksums.

An early 12-activity version without trip alternation was rejected. By tick 2400 it sent
roughly two thirds of walkers toward parcel activities, produced 197 local visits, raised
active easements to 63, and left 10 walkers below the 25-units-over-200-ticks mobility
probe. The image was lively, but the new loop had overwhelmed its causal substrate.

The selected eight-activity version produced the following seed-2026 comparison. The
easement-only values are the immediately preceding reference run; the activity values
use the same seed, population, and probe.

| Metric | Easement-only | Activity demand |
| --- | ---: | ---: |
| Stuck walkers at ticks 1000 / 1500 / 2000 / 2400 | 1 / 1 / 0 / 3 | 3 / 3 / 8 / 5 |
| Completed trips at tick 2400 | 325 | 407 |
| Local activity visits at tick 2400 | 0 | 120 |
| Active activities at tick 2400 | 0 | 8 |
| Active easements at tick 2400 | 45 | 50 |
| Acquired rights-of-way at tick 2400 | 34 | 39 |
| Prior provisional easement releases at tick 2400 | 35 | 37 |

The demand loop clearly works: all five purposes receive visits and journey throughput
does not collapse. It also exposes a falsification signal. Late-run immobility is higher,
especially around tick 2000, even though only 23–28 walkers target activities and the
diagnosed slow agents are not concentrated at activity entrances. This points to changed
parcel/path morphology and pressure timing rather than an entrance-collision defect.
The next calibration should inspect those late journeys across several seeds before
raising activity capacity or adding more land-use detail.

## Acceptance and falsification

The coupled Territory slice is useful if, across several fixed seeds:

- path concentration falls without journey completion collapsing;
- multiple approach directions and non-orthogonal segments survive;
- easements arise at repeated local conflicts rather than immediately reproducing the
  direct origin–destination line;
- sustained collision stalls eventually resolve while brief contacts create no pressure;
- no reservation or claim forms under an occupying walker, including a same-tick arrival;
- a mature public cut leaves at most one connected private component for its owner;
- parcel activities produce measurable local trips without replacing regional movement
  or trapping walkers at their frontage entrances;
- replay, tick chunking, and agent storage order remain deterministic; and
- runtime remains comparable to the complete-route baseline.

It should be revised or rejected if lower concentration comes mainly from aimless
meandering, agents persist at parcel faces, detour ratios grow without later resolution,
or the outcome depends on adding further unrelated rules.

## Ordered follow-ups

1. Evaluate bounded wayfinding and parcel activity demand over a small fixed seed suite;
   distinguish temporary oscillation from lasting deadlock and add route-distribution
   measurements if trail concentration cannot distinguish branching from noise.
2. Only after that comparison, decide whether activities need explicit opening/closure
   decisions, household/job occupancy, or a larger capacity.
3. Add street condition and capacity as a separate feedback: use funds maintenance,
   overload raises cost, and quiet capacity decays.
4. Build comparison demos for Physarum conductance, locally optimized connectors,
   aggregation–diffusion, or space colonization only when each poses its own question.

The architectural rule is: **one new feedback, one stated hypothesis, and measurements
capable of disproving it per experiment**. Alternative explanations should share engine
primitives, not accumulate as switches in Territory 03.
