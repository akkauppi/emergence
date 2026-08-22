# Emergence Lab

Emergence Lab is a browser-based teaching playground for asking a deceptively simple question: **how can a shared spatial pattern arise when every person follows only a local rule?**

The first working slice models the classroom movement experiment with stable social references. Each simulated person secretly chooses two others. In the convergent preset they move between their chosen people; in the divergent preset they keep one chosen person between themselves and the other. A second slice connects movement to morphology: repeated journeys deposit a fading footfall field, and later walkers can follow the traces left by earlier ones. A third slice couples tenure to circulation: preferred routes leave traces, actively used cells can become public ways, and plot claims grow around the network that movement creates.

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
- A desire-path experiment with editable weighted gates, blocks and block grids, repeat trips, and a persistent footfall field
- A territory experiment with attributed land, preferred-route traces, emergent public-way cells, road-versus-plot conflicts, expiring reservations, and contiguous parcel growth
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

Then choose **Trace · reveal desire paths**. The preset begins with west and east gates,
but people can make repeat trips among any number of gates in horizontal, vertical, or
diagonal arrangements. Their footfalls form a scalar field that fades over time. The
editable rule finds the next relevant block, scores four possible sides by detour and
trace strength, and follows the better route. For a useful A/B demonstration, first run
with **Trail influence** at `0`, reset with the same seed, then raise it to `1` or `2`.
**Trace persistence** controls how long the shared spatial memory lasts. Trail
concentration and its trend replace rule-match measurement in this preset.

To edit the walking ground, pause the run and choose **Block** to drag one rectangle or
**Block grid** to drag a whole arrangement; its rows, columns, and street gap can be set
beside the tools. The 36-unit default gap leaves room for opposing walkers; deliberately
narrower streets can produce congestion and gridlock. Choose **Gate** to click or drag a
new destination, then edit its label and **Likelihood** from `0` to `10`. Relative
likelihoods weight the next destination;
the gate an agent just left is excluded. A zero excludes that gate while another choice
has positive weight, while all eligible zeros fall back to equal choice. **Erase**
removes a block or gate, while **Undo**, **Clear**, and **Restore layout** make quick
comparisons safe. Every accepted layout or gate edit restarts at tick zero with the same
seed and an empty footfall field. That keeps the people and starting conditions
comparable while ensuring traces from the previous geometry do not contaminate the new
one.

The editor currently evaluates trusted classroom JavaScript in a disposable Web Worker. A worker prevents accidental code from freezing the page, but is not a security boundary; do not run untrusted shared code until the planned interpreter sandbox is added. Student rules should be pure: use only the values and helpers passed to `behave`, and use `random(key)` for seeded randomness. Journey rules additionally receive `destination`, read-only `destinations` and `obstacles`, plus `field.sample(point)` and `field.gradient(point, step)` for sensing accumulated footfall. Territory rules receive frozen `land` and `circulation` views. `circulation.route(landId)` applies the preferred-route heuristic and returns the next waypoint and cardinal land cells traversed by the current best route; established roads and reinforced traces are cheaper than unused land, while claimed plots are excluded. A rule may submit plot reservation and claim intents, while active movement can produce a public-way reservation intent.

Then choose **Territory · paths become streets**. There is no preset street grid. A small set of entry cells anchors circulation, and people evaluate preferred cardinal routes across the cadastral grid. Moving through an available cell records use. Reinforced traces become increasingly attractive, so repeated local route choices can concentrate movement before any road is declared.

An actively used route cell may be reserved for circulation. Road and plot intents for the same cell are resolved together, so one cell cannot silently become both private tenure and public way. A successful road reservation joins the existing network across a cardinal edge. Claimed land blocks later routing, while a private reservation remains contestable until either tenure or circulation wins the cell. Plot reservations still mature and expire, and later claims must grow across a cardinal edge from land the same owner already holds. Diagonal contact never counts as connected growth.

Every person in a tick reads the same prior circulation-and-tenure snapshot. Use deposits and competing intents are applied only after decisions, with stable seeded tie-breaks, so internal agent order does not choose the town plan. The canvas distinguishes faint travel traces, pending public-way reservations, established roads, plot reservations, claims, and road/plot conflicts. Click a cell to inspect both its tenure and circulation state; road frontage is derived from current road adjacency, and hiding Tenure leaves the movement-grown network visible on its own.

Geometry, tenure, circulation, and future occupation remain separate layers, but their intents can compete for exclusive use of a land cell. For an untouched run, the same scenario, code, parameters, population, and seed reproduce agents, tenure, road growth, conflicts, and checksum. Buildings, occupation, budgets and bid locks, release, subdivision, and non-grid parcel geometry remain later work.

See [docs/PLAN.md](docs/PLAN.md) for the product, teaching, architecture, and urban-growth roadmap.
