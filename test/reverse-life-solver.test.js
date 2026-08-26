import assert from "node:assert/strict";
import test from "node:test";

import {
  createLifeBoard,
  evolveLife,
  lifeBoardsEqual,
  lifePopulation,
  stampLifePattern,
} from "../src/life/life-model.js";
import { getLifePattern } from "../src/life/life-patterns.js";
import { solveReverseLife } from "../src/life/reverse-life-solver.js";

function solvedBoard(result, columns, rows) {
  assert.equal(result.status, "sat");
  assert.equal(result.stats.verified, true);
  return createLifeBoard(columns, rows, result.predecessor);
}

test("MiniSat finds and forward-verifies a predecessor", async () => {
  const columns = 7;
  const rows = 7;
  const target = stampLifePattern(createLifeBoard(columns, rows), getLifePattern("blinker"));
  const result = await solveReverseLife({ target: target.cells, columns, rows });
  const predecessor = solvedBoard(result, columns, rows);

  assert.equal(lifeBoardsEqual(evolveLife(predecessor), target), true);
  assert.ok(result.stats.clauses > 0);
  assert.ok(result.stats.satVariables > columns * rows);
});

test("blocking a model enumerates a different valid predecessor", async () => {
  const columns = 4;
  const rows = 4;
  const target = createLifeBoard(columns, rows);
  const first = await solveReverseLife({ target: target.cells, columns, rows });
  const second = await solveReverseLife({
    target: target.cells,
    columns,
    rows,
    blocked: [first.predecessor],
  });

  const firstBoard = solvedBoard(first, columns, rows);
  const secondBoard = solvedBoard(second, columns, rows);
  assert.equal(lifeBoardsEqual(firstBoard, secondBoard), false);
  assert.equal(lifeBoardsEqual(evolveLife(secondBoard), target), true);
});

test("sparse reverse search minimizes predecessor population", async () => {
  const target = createLifeBoard(4, 4);
  const result = await solveReverseLife({
    target: target.cells,
    columns: target.columns,
    rows: target.rows,
    objective: "sparse",
  });
  assert.equal(lifePopulation(solvedBoard(result, target.columns, target.rows)), 0);
});

test("an isolated live target on a one-cell closed board is impossible", async () => {
  const result = await solveReverseLife({ target: [1], columns: 1, rows: 1 });
  assert.equal(result.status, "unsat");
  assert.equal(result.predecessor, null);
});
