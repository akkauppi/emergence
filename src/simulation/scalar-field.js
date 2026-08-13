const EPSILON = 1e-12;
const MAX_CELLS = 262_144;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finiteOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

/**
 * A deterministic, fixed-grid scalar field. The simulation owns the mutable
 * values; behavior programs only receive the frozen sampling facade.
 */
export class ScalarField {
  constructor(width, height, config = {}) {
    this.width = width;
    this.height = height;
    let cellSize = clamp(finiteOr(config.cellSize, 16), 2, Math.max(width, height));
    let columns = Math.max(1, Math.ceil(width / cellSize));
    let rows = Math.max(1, Math.ceil(height / cellSize));

    if (columns * rows > MAX_CELLS) {
      cellSize = Math.sqrt((width * height) / MAX_CELLS);
      columns = Math.max(1, Math.ceil(width / cellSize));
      rows = Math.max(1, Math.ceil(height / cellSize));
    }

    this.cellSize = cellSize;
    this.columns = columns;
    this.rows = rows;
    this.cellWidth = width / columns;
    this.cellHeight = height / rows;
    this.values = new Float64Array(columns * rows);
    this.scratch = new Float64Array(columns * rows);
    this.cachedMaximum = 0;
    this.maximumDirty = false;
    this.api = Object.freeze({
      enabled: true,
      cols: columns,
      columns,
      rows,
      cellSize,
      sample: (point) => this.sample(point),
      gradient: (point, distance) => this.gradient(point, distance),
    });
  }

  reset() {
    this.values.fill(0);
    this.scratch.fill(0);
    this.cachedMaximum = 0;
    this.maximumDirty = false;
  }

  #coordinates(point) {
    const x = clamp(finiteOr(point?.x, 0), 0, this.width);
    const y = clamp(finiteOr(point?.y, 0), 0, this.height);
    return {
      column: clamp((x / this.width) * this.columns - 0.5, 0, this.columns - 1),
      row: clamp((y / this.height) * this.rows - 0.5, 0, this.rows - 1),
    };
  }

  rawSample(point) {
    const { column, row } = this.#coordinates(point);
    const left = Math.floor(column);
    const top = Math.floor(row);
    const right = Math.min(this.columns - 1, left + 1);
    const bottom = Math.min(this.rows - 1, top + 1);
    const tx = column - left;
    const ty = row - top;
    const topValue = this.values[top * this.columns + left] * (1 - tx)
      + this.values[top * this.columns + right] * tx;
    const bottomValue = this.values[bottom * this.columns + left] * (1 - tx)
      + this.values[bottom * this.columns + right] * tx;
    return topValue * (1 - ty) + bottomValue * ty;
  }

  /** Return a stable normalized field strength in the inclusive range 0..1. */
  sample(point) {
    const maximum = this.maximum();
    if (maximum < EPSILON) return 0;
    return clamp(this.rawSample(point) / maximum, 0, 1);
  }

  /** Return the central-difference gradient of the normalized field. */
  gradient(point, distance = this.cellSize) {
    const step = clamp(finiteOr(distance, this.cellSize), 0.01, Math.max(this.width, this.height));
    const x = finiteOr(point?.x, 0);
    const y = finiteOr(point?.y, 0);
    return Object.freeze({
      x: (this.sample({ x: x + step, y }) - this.sample({ x: x - step, y })) / (2 * step),
      y: (this.sample({ x, y: y + step }) - this.sample({ x, y: y - step })) / (2 * step),
    });
  }

  maximum() {
    if (!this.maximumDirty) return this.cachedMaximum;
    let maximum = 0;
    for (const value of this.values) maximum = Math.max(maximum, value);
    this.cachedMaximum = maximum;
    this.maximumDirty = false;
    return maximum;
  }

  evolve(points, { deposit = 1, persistence = 1, diffusion = 0 } = {}) {
    const retained = clamp(finiteOr(persistence, 1), 0, 1);
    const spread = clamp(finiteOr(diffusion, 0), 0, 1);

    if (spread < EPSILON) {
      for (let index = 0; index < this.values.length; index += 1) {
        this.values[index] *= retained;
      }
    } else {
      this.scratch.fill(0);
      for (let row = 0; row < this.rows; row += 1) {
        for (let column = 0; column < this.columns; column += 1) {
          const index = row * this.columns + column;
          const value = this.values[index] * retained;
          let neighbors = 0;
          if (column > 0) neighbors += 1;
          if (column + 1 < this.columns) neighbors += 1;
          if (row > 0) neighbors += 1;
          if (row + 1 < this.rows) neighbors += 1;
          const shared = neighbors > 0 ? value * spread / neighbors : 0;
          this.scratch[index] += value - shared * neighbors;
          if (column > 0) this.scratch[index - 1] += shared;
          if (column + 1 < this.columns) this.scratch[index + 1] += shared;
          if (row > 0) this.scratch[index - this.columns] += shared;
          if (row + 1 < this.rows) this.scratch[index + this.columns] += shared;
        }
      }
      [this.values, this.scratch] = [this.scratch, this.values];
    }

    const amount = Math.max(0, finiteOr(deposit, 1));
    if (amount > 0) {
      for (const point of points) {
        const x = clamp(finiteOr(point?.x, 0), 0, this.width - Number.EPSILON);
        const y = clamp(finiteOr(point?.y, 0), 0, this.height - Number.EPSILON);
        const column = Math.min(this.columns - 1, Math.floor(x / this.cellWidth));
        const row = Math.min(this.rows - 1, Math.floor(y / this.cellHeight));
        this.values[row * this.columns + column] += amount;
      }
    }
    this.maximumDirty = true;
  }

  metrics() {
    let total = 0;
    for (const value of this.values) total += value;
    if (total < EPSILON) return { total: 0, concentration: 0 };

    const ordered = Float64Array.from(this.values);
    ordered.sort();
    const busiestCount = Math.max(1, Math.ceil(ordered.length * 0.1));
    let busiest = 0;
    for (let index = ordered.length - busiestCount; index < ordered.length; index += 1) {
      busiest += ordered[index];
    }
    return { total, concentration: clamp(busiest / total, 0, 1) };
  }

  frame() {
    return {
      cols: this.columns,
      columns: this.columns,
      rows: this.rows,
      cellSize: this.cellSize,
      values: Float32Array.from(this.values),
      max: this.maximum(),
      maxValue: this.maximum(),
    };
  }
}
