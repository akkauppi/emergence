import Logic from "logic-solver-plus";

import { createLifeBoard, evolveLife, lifeBoardsEqual, lifePopulation } from "./life-model.js";

function predecessorVariable(column, row) {
  return `p_${column}_${row}`;
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function assertObjective(objective) {
  if (objective !== "any" && objective !== "sparse") {
    throw new RangeError(`Unknown reverse-Life objective: ${objective}`);
  }
}

function normalizeBlocked(blocked, size) {
  return (blocked || []).map((cells, index) => {
    if (cells.length !== size) {
      throw new RangeError(`Blocked predecessor ${index + 1} has the wrong size.`);
    }
    return Uint8Array.from(cells, (value) => (value ? 1 : 0));
  });
}

export async function encodeReverseLife({ target, columns, rows, blocked = [] }) {
  const targetBoard = createLifeBoard(columns, rows, target);
  const blockedBoards = normalizeBlocked(blocked, targetBoard.cells.length);
  const solver = new Logic.Solver();
  await solver.initialize();
  const variables = Array.from({ length: targetBoard.cells.length }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const variable = predecessorVariable(column, row);
    solver.getVarNum(variable);
    return variable;
  });

  const variableAt = (column, row) => (
    column < 0 || row < 0 || column >= columns || row >= rows
      ? null
      : variables[row * columns + column]
  );

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const neighbors = [];
      for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
          if (columnOffset === 0 && rowOffset === 0) continue;
          const neighbor = variableAt(column + columnOffset, row + rowOffset);
          if (neighbor) neighbors.push(neighbor);
        }
      }

      const neighborCount = Logic.sum(neighbors);
      const exactlyTwo = Logic.equalBits(neighborCount, Logic.constantBits(2));
      const exactlyThree = Logic.equalBits(neighborCount, Logic.constantBits(3));
      const aliveNow = variableAt(column, row);
      const aliveNext = Logic.or(exactlyThree, Logic.and(aliveNow, exactlyTwo));
      const targetAlive = targetBoard.cells[row * columns + column] === 1;
      if (targetAlive) solver.require(aliveNext);
      else solver.forbid(aliveNext);
    }
  }

  for (const cells of blockedBoards) {
    const differsSomewhere = variables.map((variable, index) => (
      cells[index] ? Logic.not(variable) : variable
    ));
    solver.require(Logic.or(differsSomewhere));
  }

  return { solver, variables, targetBoard };
}

export async function solveReverseLife({
  target,
  columns,
  rows,
  blocked = [],
  objective = "any",
  onProgress = () => {},
}) {
  assertObjective(objective);
  const startedAt = now();
  const { solver, variables, targetBoard } = await encodeReverseLife({ target, columns, rows, blocked });
  const encodedAt = now();
  onProgress({
    stage: "solving",
    boardVariables: variables.length,
    satVariables: solver._num2name.length - 1,
    clauses: solver.clauses.length,
    elapsedMs: encodedAt - startedAt,
  });
  let solution = solver.solve();
  if (solution && objective === "sparse") {
    onProgress({
      stage: "optimizing",
      boardVariables: variables.length,
      satVariables: solver._num2name.length - 1,
      clauses: solver.clauses.length,
      elapsedMs: now() - startedAt,
    });
    solution = solver.minimizeWeightedSum(solution, variables, 1, { strategy: "bottom-up" });
  }
  const solvedAt = now();

  const stats = {
    boardVariables: variables.length,
    satVariables: solver._num2name.length - 1,
    clauses: solver.clauses.length,
    encodeMs: encodedAt - startedAt,
    solveMs: solvedAt - encodedAt,
    totalMs: solvedAt - startedAt,
    blocked: blocked.length,
    objective,
  };

  if (!solution) return { status: "unsat", predecessor: null, stats };

  const predecessor = createLifeBoard(
    columns,
    rows,
    variables.map((variable) => (solution.evaluate(variable) ? 1 : 0)),
  );
  const verifiedTarget = evolveLife(predecessor);
  if (!lifeBoardsEqual(verifiedTarget, targetBoard)) {
    throw new Error("MiniSat returned a predecessor that failed forward verification.");
  }

  return {
    status: "sat",
    predecessor: Array.from(predecessor.cells),
    stats: {
      ...stats,
      predecessorPopulation: lifePopulation(predecessor),
      targetPopulation: lifePopulation(targetBoard),
      verified: true,
    },
  };
}
