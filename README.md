# Emergence Lab

Emergence Lab is a browser-based teaching playground for asking a deceptively simple question: **how can a shared spatial pattern arise when every person follows only a local rule?**

The first working slice models the classroom movement experiment with stable social references. Each simulated person secretly chooses two others. In the convergent preset they move between their chosen people; in the divergent preset they keep one chosen person between themselves and the other. A second slice connects movement to morphology: repeated journeys deposit a fading footfall field, and later walkers can follow the traces left by earlier ones.

## Run it

The project deliberately has no runtime or package dependencies. Node 20+ is enough.

```bash
npm run dev
```

Then open <http://127.0.0.1:4173>.

The development server listens on all network interfaces by default. When it starts,
it also prints one or more `Network` URLs such as `http://192.168.1.42:4173`; open
that URL from another computer on the same LAN. To restrict it to the Pi itself, run
`HOST=127.0.0.1 npm run dev`. The port can be changed with `PORT=8080 npm run dev`.

Other commands:

```bash
npm test       # deterministic engine and preset tests
npm run build  # copy the static application into dist/
npm run check  # test and build
```

## What is already included

- A deterministic, fixed-step 2D agent simulation
- Simultaneous updates, so array order does not decide the result
- Stable, seeded choices of two reference people per agent
- Editable JavaScript behavior with apply/reset and error reporting
- Convergent, divergent, equidistant, two-sided triangle, chiral triangle, and wandering examples
- A desire-path experiment with two destinations, a central obstruction, repeat trips, and a persistent footfall field
- Delayed sensing with visible historical-reference ghosts
- Drag-to-perturb interventions that preserve the relationship network and simulation tick
- Pause, single-step, same-seed reset, new seed, tempo, and population controls
- Agent trails, inspectable relationships, a desire-path heat field, and scenario-specific live metrics
- Responsive classroom/projector layout and presentation mode
- A worker watchdog that recovers the interface from accidental infinite loops

Try the dynamics in this order: run the two-sided triangle and ask whether all local
triangles can be satisfied; compare it with the shared-side chiral triangle using the
same seed; then introduce reaction delay or drag one person and watch the disturbance
propagate through hidden references. Seed, code, and parameters reproduce an untouched
run. Drag events are recorded in memory for inspection; saved replay is a planned step.

Then choose **Trace · reveal desire paths**. People repeatedly cross between the west
and east gates while a rectangular block splits the direct route. Their footfalls form
a scalar field that fades over time. The editable rule samples that field ahead and on
both sides, allowing an established route to recruit later walkers. For a useful A/B
demonstration, first run with **Trail influence** at `0`, reset with the same seed, then
raise it to `1` or `2`. **Trace persistence** controls how long the shared spatial memory
lasts. Trail concentration and its trend replace rule-match measurement in this preset.

The editor currently evaluates trusted classroom JavaScript in a disposable Web Worker. A worker prevents accidental code from freezing the page, but is not a security boundary; do not run untrusted shared code until the planned interpreter sandbox is added. Student rules should be pure: use only the values and helpers passed to `behave`, and use `random(key)` for seeded randomness. Journey rules additionally receive `destination`, read-only `destinations` and `obstacles`, plus `field.sample(point)` and `field.gradient(point, step)` for sensing accumulated footfall.

See [docs/PLAN.md](docs/PLAN.md) for the product, teaching, architecture, and urban-growth roadmap.
