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
  into streets as walkers adapt within a bounded forward view; quiet streets fade,
  parcels follow frontage, and costly detours create easements that sustained use can
  turn into public right-of-way.

Useful controls include pause, single-step, same-seed reset, population, tempo,
relationship overlays, delayed sensing, and drag-to-perturb interventions.

## Quick start

The app is a dependency-free static site. Node.js 20 or newer is the only tool
needed.

```bash
npm run dev       # open http://127.0.0.1:4173
npm test          # run deterministic simulation tests
npm run build     # write the deployable site to dist/
npm run check     # test and build
```

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
for classroom discussion.

## Design and safety notes

The simulation advances in fixed steps and decides all agents from one frozen
snapshot before committing changes. The editable classroom behavior runs in a
disposable Web Worker so an accidental infinite loop can be recovered. A worker is
not a security boundary, so do not run untrusted shared code.

See [the product and implementation plan](docs/PLAN.md) for the teaching sequence and
architecture. The [urban-growth research notes](docs/RESEARCH.md) connect Territory's
modeling decisions to papers and reference implementations, record the deterministic
A/B comparison, and separate planned extensions from standalone comparison demos.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and pull-request
guidance. Please use [GitHub Issues](https://github.com/akkauppi/emergence/issues) for
bugs, teaching feedback, and experiment ideas.
