import assert from "node:assert/strict";
import test from "node:test";

import {
  createLifeBoard,
  evolveLife,
  evolveLifeBy,
  lifeBoardsEqual,
  lifeCell,
  lifePopulation,
  lifeTransition,
  stampLifePattern,
} from "../src/life/life-model.js";
import { getLifePattern } from "../src/life/life-patterns.js";

test("the block remains a still life", () => {
  const board = stampLifePattern(createLifeBoard(10, 10), getLifePattern("block"));
  assert.equal(lifeBoardsEqual(evolveLife(board), board), true);
  assert.deepEqual(lifeTransition(board), { births: 0, deaths: 0, survivors: 4, changed: 0 });
});

test("the blinker returns after two generations", () => {
  const board = stampLifePattern(createLifeBoard(9, 9), getLifePattern("blinker"));
  assert.equal(lifeBoardsEqual(evolveLife(board), board), false);
  assert.equal(lifeBoardsEqual(evolveLifeBy(board, 2), board), true);
});

test("the glider translates diagonally after four generations", () => {
  const pattern = getLifePattern("glider");
  const board = stampLifePattern(createLifeBoard(12, 12), pattern, { column: 2, row: 2 });
  const translated = stampLifePattern(createLifeBoard(12, 12), pattern, { column: 3, row: 3 });
  assert.equal(lifeBoardsEqual(evolveLifeBy(board, 4), translated), true);
});

test("the finite board treats cells beyond its edge as dead", () => {
  const board = createLifeBoard(3, 3, [
    1, 1, 1,
    0, 0, 0,
    0, 0, 0,
  ]);
  const next = evolveLife(board);
  assert.equal(lifePopulation(next), 2);
  assert.equal(lifeCell(next, 1, 0), 1);
  assert.equal(lifeCell(next, 1, 1), 1);
});
