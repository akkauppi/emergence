# Research notes: organic movement and urban growth

This note records the evidence considered for the Territory experiment, the
mechanism selected for implementation, and the alternatives deliberately kept
out of the same scenario. It is a design record, not a claim that the simulation
predicts real city growth.

## Decision summary

Territory 03 keeps one causal chain:

```text
bounded movement → fading traces → maintained streets → frontage settlement
       ↑                                                   ↓
       └─ costly detours or prolonged stalls → easements ─┘
                                            ↓
                               sustained-use acquisition
```

The selected next mechanism is **bounded-view, locally adaptive wayfinding**.
Walkers retain a rough bearing toward their destination but choose only their
next visible step. Nearby traces and current motion influence that step; walkers
do not receive a completed shortest route around every parcel.

Land use, new destination formation, street capacity, and alternative network
growth algorithms remain later experiments. Adding them simultaneously would
make visually interesting output easier to obtain but causal explanations much
harder to test.

## Evidence and implementation implications

| Evidence | Main result used here | Decision for Emergence Lab |
| --- | --- | --- |
| Ma et al., [*Simple agents – complex emergent path systems*](https://journals.sagepub.com/doi/10.1177/23998083231184884) and its [NetLogo source](https://github.com/LeiMazizizi/Agent-based-modelling-of-pedestrian-movement) | A global destination conception combined with local adaptation and a bounded view can generate desire-path systems. In the reported campus and hospital cases, viewing angle affected morphology more strongly than viewing depth; approximately 90–120° gave the best fit. | Use a 110° default forward view, a fixed local look-ahead, and local trace sampling. |
| Sharmin and Kamruzzaman, [shortest distance versus least directional change](https://www.sciencedirect.com/science/article/pii/S0966692318303867) | Both metric distance and directional change influence pedestrian route choice; least directional change was the stronger individual explanation in their sample. | Score progress and heading continuity rather than metric distance alone. |
| Filomena and Verstegen, [landmarks in pedestrian navigation](https://www.sciencedirect.com/science/article/pii/S0198971520303069), with [PedSimCity](https://github.com/g-filomena/PedSimCity) | Landmark-aware navigation produced more heterogeneous pedestrian distributions than pure minimization models and better matched several properties of observed GPS routes. | Let future activities or junctions become locally salient; do not add decorative landmarks with no causal role. |
| Filomena et al., [empirical pedestrian strategy heterogeneity](https://doi.org/10.1016/j.jenvp.2022.101807) | Empirical configurations changed where flows concentrated, but heterogeneous agent clusters differed only modestly from an empirically calibrated homogeneous population at the global level. | Improve the shared route-choice mechanism first. Avoid a large catalogue of personality types until a specific comparison requires it. |
| Santos et al., [procedural city generation using land-use/transport interaction](https://arxiv.org/abs/2211.01959) and [AutoPlanner source](https://github.com/LFRusso/autoplanner) | Accessibility and differentiated residential, commercial, industrial, and recreational uses can be coupled incrementally. | A later scenario should let occupied parcels create activities and therefore new trips. The current slice does not need reinforcement learning. |
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

1. Each journey keeps its own consecutive stall count; agents do not share frustration.
2. A tick counts only when the walker intended to move, a claimed cell corrected that
   move, and actual displacement was at most 30% of intended displacement.
3. Successful movement or a changed journey resets the count, so waiting, slowing near
   a destination, and brief contacts do not create crossings.
4. After a 75-tick grace period, that walker contributes pressure to the cell that
   physically blocked her. The contribution rises with continued immobility, up to four
   times its base value. Several blocked walkers still aggregate naturally on one cell.
5. Crossing the existing pressure threshold opens the same narrow easement used by the
   detour rule. Ownership remains in place, but movement becomes permeable immediately.

This also separates two rules that look similar in the picture. An easement may pass
through the middle of a parcel without subdividing its legal ownership. Only later,
after sustained traffic proposes permanent public acquisition, does the contiguity
guard apply. If removing that cadastral cell would fragment the owner's remaining
holding, acquisition is rejected but the already-open easement remains. Parcel
subdivision can therefore remain a separate tenure experiment rather than a prerequisite
for resolving a pedestrian deadlock.

The circulation frame now reports currently blocked agents, agents beyond the grace
period, and the maximum per-agent stall age. These values and the per-agent journey
state participate in deterministic replay checksums.

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

## Acceptance and falsification

The bounded-view slice is useful if, across several fixed seeds:

- path concentration falls without journey completion collapsing;
- multiple approach directions and non-orthogonal segments survive;
- easements arise at repeated local conflicts rather than immediately reproducing the
  direct origin–destination line;
- sustained collision stalls eventually resolve while brief contacts create no pressure;
- replay, tick chunking, and agent storage order remain deterministic; and
- runtime remains comparable to the complete-route baseline.

It should be revised or rejected if lower concentration comes mainly from aimless
meandering, agents persist at parcel faces, detour ratios grow without later resolution,
or the outcome depends on adding further unrelated rules.

## Ordered follow-ups

1. Evaluate bounded wayfinding over a small fixed seed suite and add route-distribution
   measurements if trail concentration cannot distinguish branching from noise.
2. In a new activity-focused slice, let some mature parcels create homes, markets,
   workshops, wells, or greens and generate purpose-specific trips.
3. Add street condition and capacity as a separate feedback: use funds maintenance,
   overload raises cost, and quiet capacity decays.
4. Build comparison demos for Physarum conductance, locally optimized connectors,
   aggregation–diffusion, or space colonization only when each poses its own question.

The architectural rule is: **one new feedback, one stated hypothesis, and measurements
capable of disproving it per experiment**. Alternative explanations should share engine
primitives, not accumulate as switches in Territory 03.
