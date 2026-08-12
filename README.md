# Emergence Lab

Emergence Lab is a browser-based teaching playground for asking a deceptively simple question: **how can a shared spatial pattern arise when every person follows only a local rule?**

The first working slice models the classroom movement experiment with stable social references. Each simulated person secretly chooses two others. In the convergent preset they move between their chosen people; in the divergent preset they keep one chosen person between themselves and the other.

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
- Convergent, divergent, equidistant, and wandering examples
- Pause, single-step, same-seed reset, new seed, tempo, and population controls
- Trails, inspectable relationships, and live spatial metrics
- Responsive classroom/projector layout and presentation mode
- A worker watchdog that recovers the interface from accidental infinite loops

The editor currently evaluates trusted classroom JavaScript in a disposable Web Worker. A worker prevents accidental code from freezing the page, but is not a security boundary; do not run untrusted shared code until the planned interpreter sandbox is added.

See [docs/PLAN.md](docs/PLAN.md) for the product, teaching, architecture, and urban-growth roadmap.
