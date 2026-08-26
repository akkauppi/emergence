# Emergence Lab

[![Deploy to GitHub Pages](https://github.com/akkauppi/emergence/actions/workflows/pages.yml/badge.svg)](https://github.com/akkauppi/emergence/actions/workflows/pages.yml)
[![Tests](https://github.com/akkauppi/emergence/actions/workflows/test.yml/badge.svg)](https://github.com/akkauppi/emergence/actions/workflows/test.yml)

**[Open the live playground](https://akkauppi.github.io/emergence/)**

Emergence Lab is a browser-based teaching playground for a deceptively simple
question: how can a shared spatial pattern arise when every person follows only a
local rule?

It turns that question into reproducible experiments. Students can change a rule,
run the model, inspect the measurements, reset with the same seed, and explain what
changed. The experiments grow from movement and social reference networks into
desire paths, public streets, and territory.

## Experiments

- **Movement laboratory** — compare convergent, divergent, equidistant, triangle,
  chiral, and wandering rules.
- **Trace · reveal desire paths** — edit blocks and destination gates, then watch
  repeated journeys create a fading footfall field that influences later movement.
- **Territory · paths become streets** — observe well-beaten continuous paths mature
  into streets as walkers adapt within a bounded forward view; clear plots follow
  established frontage, quiet streets and unused provisional easements fade, and
  sustained narrow crossings can cut parcels into public right-of-way. Mature parcels
  beside surviving streets can become homes, markets, workshops, wells, or greens,
  adding new local trips to the movement pattern that first created their frontage.
- **Street hierarchy · use earns capacity** — rerun Territory with one additional
  feedback: current load maintains condition and grows usable capacity, quiet streets
  narrow, and actual overload makes an aligned route locally less attractive. Variable
  width and congestion marks make the resulting hierarchy visible without imposing a
  grid or changing Territory's defaults.
- **Conway's Life · run forward, solve backward** — paint familiar Life patterns,
  evolve them under B3/S23, or ask a SAT solver for one of their possible predecessor
  states and verify the answer with an ordinary forward step.

Useful controls include pause, single-step, same-seed reset, population, tempo,
relationship overlays, delayed sensing, and drag-to-perturb interventions.

## Quick start

The deployed app is a static site. Building it requires Node.js 20 or newer and the
locked npm dependencies.

```bash
npm ci
npm run dev       # open http://127.0.0.1:4173
npm test          # run deterministic simulation tests
npm run build     # write the deployable site to dist/
npm run check     # test and build
npm run evaluate:territory  # run the four-seed, 2400-tick Territory probe
npm run diagnose:territory  # classify late-stuck journeys at four checkpoints
```

The evaluator accepts `--scenario street-hierarchy`, `--seeds`, `--ticks`,
`--window`, `--distance`, `--population`, and `--json`. Its default stuck-walker probe
means no completed trip and less than 25 world units of displacement during the final
200 ticks.

The deadlock atlas uses that same definition at ticks 1000, 1500, 2000, and 2400,
then separates endpoint displacement from the path actually traveled. Add `--details`
for per-agent evidence, `--json` for structured output, or `--svg-dir <path>` for
standalone map overlays. Its parcel, collision, oscillation, crowding, target, and
easement labels are diagnostic signals rather than claims of causal proof.

The server listens on the LAN by default. Use `HOST=127.0.0.1 npm run dev` to keep
it local, or set `PORT=8080` to use another port.

## A good first lesson

1. Run **Complete a triangle** and predict whether every local goal can be met.
2. Compare **Chiral triangle** with the same seed.
3. Reveal relationships, introduce a sensing delay, or drag one person.
4. Reset with the same seed and change one parameter at a time.
5. Try **Trace · reveal desire paths** with trail influence at `0`, then at `1` or
   `2`, keeping the seed and layout unchanged.

The model is deterministic for an untouched run: scenario, code, parameters,
population, and seed reproduce the same state. This makes A/B comparisons suitable
for classroom discussion. Compare paused runs at the same tick; the short visual tail
behind each walker is sampled from displayed frames and can look different after a
tempo change even though agents, tenure, fields, and streets replay exactly.

## Design and safety notes

The simulation advances in fixed steps and decides all agents from one frozen
snapshot before committing changes. The editable classroom behavior runs in a
disposable Web Worker so an accidental infinite loop can be recovered. A worker is
not a security boundary, so do not run untrusted shared code.

See [the product and implementation plan](docs/PLAN.md) for the teaching sequence and
architecture. The [urban-growth research notes](docs/RESEARCH.md) connect Territory's
modeling decisions to papers and reference implementations, record the deterministic
A/B comparison, and separate planned extensions from standalone comparison demos.
The [reverse-Life experiment note](docs/REVERSE_LIFE.md) documents the SAT encoding,
finite-board assumptions, generated solver assets, and reproducible entry points.
Bundled dependency licenses are recorded in
[third-party notices](THIRD_PARTY_NOTICES.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and pull-request
guidance. Please use [GitHub Issues](https://github.com/akkauppi/emergence/issues) for
bugs, teaching feedback, and experiment ideas.
