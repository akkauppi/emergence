function patternFromRows(definition) {
  const rows = definition.rows.map((row) => row.replace(/\s/g, ""));
  const width = Math.max(...rows.map((row) => row.length));
  const cells = [];
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < rows[row].length; column += 1) {
      if (/[O#*1]/.test(rows[row][column])) cells.push([column, row]);
    }
  }
  return Object.freeze({
    ...definition,
    rows: undefined,
    width,
    height: rows.length,
    cells: Object.freeze(cells.map((cell) => Object.freeze(cell))),
  });
}

export const LIFE_PATTERNS = Object.freeze([
  patternFromRows({
    id: "glider",
    name: "Glider",
    family: "Spaceship",
    fact: "Moves one cell diagonally every four generations.",
    period: 4,
    rows: [
      ".O.",
      "..O",
      "OOO",
    ],
  }),
  patternFromRows({
    id: "block",
    name: "Block",
    family: "Still life",
    fact: "A stable four-cell object: its next generation is identical.",
    period: 1,
    rows: [
      "OO",
      "OO",
    ],
  }),
  patternFromRows({
    id: "blinker",
    name: "Blinker",
    family: "Oscillator",
    fact: "The smallest oscillator alternates between horizontal and vertical.",
    period: 2,
    rows: ["OOO"],
  }),
  patternFromRows({
    id: "toad",
    name: "Toad",
    family: "Oscillator",
    fact: "A six-cell oscillator with period two.",
    period: 2,
    rows: [
      ".OOO",
      "OOO.",
    ],
  }),
  patternFromRows({
    id: "beacon",
    name: "Beacon",
    family: "Oscillator",
    fact: "Two almost-touching blocks blink with period two.",
    period: 2,
    rows: [
      "OO..",
      "OO..",
      "..OO",
      "..OO",
    ],
  }),
  patternFromRows({
    id: "lwss",
    name: "Lightweight spaceship",
    family: "Spaceship",
    fact: "A period-four spaceship that travels horizontally.",
    period: 4,
    rows: [
      ".OOO.",
      "O...O",
      "....O",
      "O..O.",
    ],
  }),
  patternFromRows({
    id: "r-pentomino",
    name: "R-pentomino",
    family: "Methuselah",
    fact: "Only five cells, but it evolves for 1,103 generations before settling.",
    period: null,
    rows: [
      ".OO",
      "OO.",
      ".O.",
    ],
  }),
  patternFromRows({
    id: "acorn",
    name: "Acorn",
    family: "Methuselah",
    fact: "Seven cells generate a long-lived cloud before stabilizing.",
    period: null,
    rows: [
      ".O.....",
      "...O...",
      "OO..OOO",
    ],
  }),
  patternFromRows({
    id: "pulsar",
    name: "Pulsar",
    family: "Oscillator",
    fact: "A symmetric 48-cell oscillator with period three.",
    period: 3,
    rows: [
      "..OOO...OOO..",
      ".............",
      "O....O.O....O",
      "O....O.O....O",
      "O....O.O....O",
      "..OOO...OOO..",
      ".............",
      "..OOO...OOO..",
      "O....O.O....O",
      "O....O.O....O",
      "O....O.O....O",
      ".............",
      "..OOO...OOO..",
    ],
  }),
]);

export function getLifePattern(id) {
  return LIFE_PATTERNS.find((pattern) => pattern.id === id) || LIFE_PATTERNS[0];
}
