# Forward and reverse Conway's Life

This experiment is a visual solver laboratory. It first makes Conway's Game of Life
concrete—paint a board, load a familiar object, and run the usual rule forward—then
turns the question around: given the next board, what could the previous board have
been?

Open it from the scenario menu or directly with:

```text
/?scenario=reverse-life
/?scenario=reverse-life&direction=reverse&objective=sparse&solve=1
```

The pattern library includes a glider, block, blinker, toad, beacon, lightweight
spaceship, R-pentomino, acorn, and pulsar. The board is a finite 20 × 16 rectangle;
cells outside it are always dead.

## Forward rule

Each generation is computed simultaneously with Conway's B3/S23 rule:

- a dead cell is born when exactly three neighbours are alive;
- a live cell survives with two or three live neighbours;
- every other cell is dead in the next generation.

The forward implementation is the reference semantics used by both animation and
solver verification.

## Reverse encoding

There is one Boolean variable for every possible live cell in the predecessor. For
each target cell, a Boolean formula expresses the same forward rule:

```text
nextAlive = neighboursEqual3 OR (previousAlive AND neighboursEqual2)
```

The requested target fixes every `nextAlive` result to true or false. Logic Solver
Plus translates these formulas to CNF and its WebAssembly MiniSat backend finds a
satisfying assignment. “Any predecessor” stops at the first assignment. “Sparse
predecessor” minimizes the number of live predecessor cells. “Another answer” adds a
blocking clause for each prior board before solving again.

An UNSAT result means that no predecessor exists under this finite, dead-boundary
model—not that the same pattern has no predecessor on an infinite Life plane. A SAT
result is never trusted on its own: the app applies one ordinary forward step and
checks that every cell exactly matches the requested target. The user can open that
forward proof and step it visually.

## Browser and build architecture

Solving runs in a disposable module Web Worker so the interface remains responsive and
the solver can be stopped. `scripts/bundle-life-solver.mjs` uses esbuild to bundle the
worker and copies the solver's WebAssembly module beside it. Those two generated files
are ignored by Git and recreated by `predev` and `prebuild`.

To reproduce the experiment:

```bash
npm ci
npm run dev
npm test -- test/life-model.test.js test/reverse-life-solver.test.js
npm run build
```

The dependency license is in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
