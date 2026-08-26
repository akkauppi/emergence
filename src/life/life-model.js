export const DEFAULT_LIFE_COLUMNS = 20;
export const DEFAULT_LIFE_ROWS = 16;

function assertDimension(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
}

function normalizeCells(cells, size) {
  if (cells === undefined || cells === null) return new Uint8Array(size);
  if (cells.length !== size) {
    throw new RangeError(`Expected ${size} cell values, received ${cells.length}.`);
  }
  return Uint8Array.from(cells, (value) => (value ? 1 : 0));
}

export function createLifeBoard(columns = DEFAULT_LIFE_COLUMNS, rows = DEFAULT_LIFE_ROWS, cells) {
  assertDimension(columns, "columns");
  assertDimension(rows, "rows");
  return {
    columns,
    rows,
    cells: normalizeCells(cells, columns * rows),
  };
}

export function cloneLifeBoard(board) {
  return createLifeBoard(board.columns, board.rows, board.cells);
}

export function lifeCellIndex(board, column, row) {
  if (column < 0 || row < 0 || column >= board.columns || row >= board.rows) return -1;
  return row * board.columns + column;
}

export function lifeCell(board, column, row) {
  const index = lifeCellIndex(board, column, row);
  return index < 0 ? 0 : board.cells[index];
}

export function setLifeCell(board, column, row, alive) {
  const index = lifeCellIndex(board, column, row);
  if (index >= 0) board.cells[index] = alive ? 1 : 0;
  return board;
}

export function toggleLifeCell(board, column, row) {
  const index = lifeCellIndex(board, column, row);
  if (index >= 0) board.cells[index] = board.cells[index] ? 0 : 1;
  return board;
}

export function countLifeNeighbors(board, column, row) {
  let neighbors = 0;
  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
      if (rowOffset === 0 && columnOffset === 0) continue;
      neighbors += lifeCell(board, column + columnOffset, row + rowOffset);
    }
  }
  return neighbors;
}

export function nextLifeCell(alive, neighbors) {
  return neighbors === 3 || (alive && neighbors === 2) ? 1 : 0;
}

export function evolveLife(board) {
  const next = createLifeBoard(board.columns, board.rows);
  for (let row = 0; row < board.rows; row += 1) {
    for (let column = 0; column < board.columns; column += 1) {
      const index = lifeCellIndex(board, column, row);
      next.cells[index] = nextLifeCell(board.cells[index], countLifeNeighbors(board, column, row));
    }
  }
  return next;
}

export function evolveLifeBy(board, generations) {
  if (!Number.isInteger(generations) || generations < 0) {
    throw new RangeError("generations must be a non-negative integer.");
  }
  let result = cloneLifeBoard(board);
  for (let generation = 0; generation < generations; generation += 1) {
    result = evolveLife(result);
  }
  return result;
}

export function lifePopulation(board) {
  let population = 0;
  for (const cell of board.cells) population += cell;
  return population;
}

export function lifeTransition(current, next = evolveLife(current)) {
  if (current.columns !== next.columns || current.rows !== next.rows) {
    throw new RangeError("Life boards must have matching dimensions.");
  }
  let births = 0;
  let deaths = 0;
  let survivors = 0;
  for (let index = 0; index < current.cells.length; index += 1) {
    if (!current.cells[index] && next.cells[index]) births += 1;
    else if (current.cells[index] && !next.cells[index]) deaths += 1;
    else if (current.cells[index]) survivors += 1;
  }
  return { births, deaths, survivors, changed: births + deaths };
}

export function lifeBoardsEqual(first, second) {
  if (first.columns !== second.columns || first.rows !== second.rows) return false;
  for (let index = 0; index < first.cells.length; index += 1) {
    if (first.cells[index] !== second.cells[index]) return false;
  }
  return true;
}

export function lifeBoardKey(board) {
  let key = `${board.columns}x${board.rows}:`;
  for (let index = 0; index < board.cells.length; index += 1) {
    key += board.cells[index] ? "1" : "0";
  }
  return key;
}

export function stampLifePattern(board, pattern, options = {}) {
  const result = options.clear === false ? cloneLifeBoard(board) : createLifeBoard(board.columns, board.rows);
  const originColumn = Number.isInteger(options.column)
    ? options.column
    : Math.floor((board.columns - pattern.width) / 2);
  const originRow = Number.isInteger(options.row)
    ? options.row
    : Math.floor((board.rows - pattern.height) / 2);
  for (const [column, row] of pattern.cells) {
    setLifeCell(result, originColumn + column, originRow + row, true);
  }
  return result;
}
