import {
  cloneLifeBoard,
  createLifeBoard,
  evolveLife,
  lifeBoardKey,
  lifeBoardsEqual,
  lifePopulation,
  lifeTransition,
  setLifeCell,
  stampLifePattern,
} from "./life-model.js";
import { getLifePattern, LIFE_PATTERNS } from "./life-patterns.js";

const BASE_GENERATIONS_PER_SECOND = 5;
const SOLVER_TIMEOUT_MS = 15_000;

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1) return `${milliseconds.toFixed(1)} ms`;
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

export class LifeLab {
  constructor(elements, { onUpdate = () => {} } = {}) {
    this.elements = elements;
    this.onUpdate = onUpdate;
    this.active = false;
    this.mode = "forward";
    this.pattern = getLifePattern("glider");
    this.current = stampLifePattern(createLifeBoard(), this.pattern);
    this.target = cloneLifeBoard(this.current);
    this.predecessor = null;
    this.generation = 0;
    this.running = false;
    this.solving = false;
    this.tempo = 1;
    this.frameRequest = null;
    this.lastFrameAt = null;
    this.accumulator = 0;
    this.populationHistory = [lifePopulation(this.current)];
    this.blockedPredecessors = [];
    this.solutionTargetKey = null;
    this.solverStats = null;
    this.solverProgress = null;
    this.requestSequence = 0;
    this.worker = null;
    this.solverTimeout = null;
    this.canvasLayouts = new WeakMap();
    this.hovered = { canvas: null, column: -1, row: -1 };
    this.painting = null;
    this.proofTarget = null;
    this.statusMessage = "Paint cells or choose an object, then advance one generation.";

    this.populatePatterns();
    this.bindControls();
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(this.elements.stage);
    this.render();
  }

  populatePatterns() {
    const options = LIFE_PATTERNS.map((pattern) => {
      const option = document.createElement("option");
      option.value = pattern.id;
      option.textContent = `${pattern.name} · ${pattern.family}`;
      return option;
    });
    this.elements.patternSelect.replaceChildren(...options);
    this.elements.patternSelect.value = this.pattern.id;
  }

  bindControls() {
    this.elements.patternSelect.addEventListener("change", () => {
      this.pattern = getLifePattern(this.elements.patternSelect.value);
      this.reset();
    });
    for (const button of this.elements.modeButtons) {
      button.addEventListener("click", () => this.setMode(button.dataset.lifeMode));
    }
    this.elements.clear.addEventListener("click", () => this.clear());
    this.elements.solve.addEventListener("click", () => this.solveReverse({ another: false }));
    this.elements.another.addEventListener("click", () => this.solveReverse({ another: true }));
    this.elements.verify.addEventListener("click", () => this.openForwardProof());
    this.elements.objective.addEventListener("change", () => {
      this.invalidateSolution("Objective changed. Solve again to compare the result.");
    });

    this.bindCanvas(this.elements.leftCanvas, "left");
    this.bindCanvas(this.elements.rightCanvas, "right");
  }

  bindCanvas(canvas, side) {
    canvas.addEventListener("pointerdown", (event) => {
      if (!this.canEdit(side)) return;
      const cell = this.pointerCell(canvas, event);
      if (!cell) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      const board = this.editableBoard();
      const index = cell.row * board.columns + cell.column;
      this.painting = { side, value: board.cells[index] ? 0 : 1, lastIndex: -1 };
      this.paintCell(cell.column, cell.row);
    });
    canvas.addEventListener("pointermove", (event) => {
      const cell = this.pointerCell(canvas, event);
      this.hovered = cell
        ? { canvas, column: cell.column, row: cell.row }
        : { canvas: null, column: -1, row: -1 };
      if (this.painting?.side === side && cell) this.paintCell(cell.column, cell.row);
      else this.draw();
    });
    const finishPaint = () => {
      this.painting = null;
    };
    canvas.addEventListener("pointerup", finishPaint);
    canvas.addEventListener("pointercancel", finishPaint);
    canvas.addEventListener("pointerleave", () => {
      if (!this.painting) {
        this.hovered = { canvas: null, column: -1, row: -1 };
        this.draw();
      }
    });
  }

  activate() {
    this.active = true;
    this.render();
    requestAnimationFrame(() => this.draw());
  }

  deactivate() {
    this.active = false;
    this.pause();
    this.cancelSolve();
  }

  setTempo(tempo) {
    this.tempo = Number.isFinite(Number(tempo)) ? Math.max(0.1, Number(tempo)) : 1;
  }

  setMode(mode, { preserveCurrent = false } = {}) {
    if (mode !== "forward" && mode !== "reverse") return;
    if (mode === this.mode && !preserveCurrent) return;
    this.pause();
    this.cancelSolve();
    this.mode = mode;
    if (mode === "reverse") {
      this.target = cloneLifeBoard(this.current);
      this.predecessor = null;
      this.blockedPredecessors = [];
      this.solutionTargetKey = lifeBoardKey(this.target);
      this.solverStats = null;
      this.solverProgress = null;
      this.proofTarget = null;
      this.statusMessage = "The right board is fixed as the target. MiniSat will assign every cell on the left.";
    } else if (!preserveCurrent) {
      this.current = this.predecessor ? cloneLifeBoard(this.predecessor) : cloneLifeBoard(this.target);
      this.generation = 0;
      this.populationHistory = [lifePopulation(this.current)];
      this.proofTarget = this.predecessor ? cloneLifeBoard(this.target) : null;
      this.statusMessage = this.proofTarget
        ? "The candidate is loaded. Step once: the preview is the target MiniSat was asked to reproduce."
        : "Paint cells or choose an object, then advance one generation.";
    }
    this.render();
  }

  reset() {
    this.pause();
    this.cancelSolve();
    const board = stampLifePattern(createLifeBoard(), this.pattern);
    if (this.mode === "forward") {
      this.current = board;
      this.generation = 0;
      this.populationHistory = [lifePopulation(board)];
      this.proofTarget = null;
      this.statusMessage = `${this.pattern.name} loaded. ${this.pattern.fact}`;
    } else {
      this.target = board;
      this.invalidateSolution(`${this.pattern.name} is now the target. Find a generation that could have produced it.`);
    }
    this.render();
  }

  clear() {
    this.pause();
    this.cancelSolve();
    if (this.mode === "forward") {
      this.current = createLifeBoard();
      this.generation = 0;
      this.populationHistory = [0];
      this.proofTarget = null;
      this.statusMessage = "Board cleared. Drag across cells to draw a starting generation.";
    } else {
      this.target = createLifeBoard();
      this.invalidateSolution("The empty generation is now the target. It has many possible predecessors.");
    }
    this.render();
  }

  editableBoard() {
    return this.mode === "forward" ? this.current : this.target;
  }

  canEdit(side) {
    return !this.running && !this.solving && (
      (this.mode === "forward" && side === "left")
      || (this.mode === "reverse" && side === "right")
    );
  }

  paintCell(column, row) {
    const board = this.editableBoard();
    const index = row * board.columns + column;
    if (this.painting?.lastIndex === index || board.cells[index] === this.painting?.value) return;
    this.painting.lastIndex = index;
    setLifeCell(board, column, row, this.painting.value);
    if (this.mode === "forward") {
      this.generation = 0;
      this.populationHistory = [lifePopulation(board)];
      this.proofTarget = null;
      this.statusMessage = "Custom starting generation. The right board previews its next step.";
    } else {
      this.cancelSolve();
      this.invalidateSolution("Target edited. Previous answers were discarded because the constraints changed.");
    }
    this.render();
  }

  togglePlayback() {
    if (this.mode === "reverse") {
      this.solveReverse({ another: false });
      return;
    }
    if (this.running) this.pause();
    else this.play();
  }

  play() {
    if (!this.active || this.mode !== "forward" || this.running) return;
    this.running = true;
    this.lastFrameAt = null;
    this.accumulator = 0;
    this.statusMessage = "Running the ordinary B3/S23 Life rule forward.";
    this.emitUpdate();
    this.frameRequest = requestAnimationFrame((time) => this.animate(time));
  }

  pause() {
    if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
    this.lastFrameAt = null;
    if (!this.running) return;
    this.running = false;
    this.statusMessage = `Paused at generation ${this.generation}.`;
    this.render();
  }

  animate(time) {
    if (!this.running || !this.active) return;
    if (this.lastFrameAt === null) this.lastFrameAt = time;
    this.accumulator += Math.min(250, time - this.lastFrameAt);
    this.lastFrameAt = time;
    const interval = 1_000 / (BASE_GENERATIONS_PER_SECOND * this.tempo);
    let steps = 0;
    while (this.accumulator >= interval && steps < 4) {
      this.advance();
      this.accumulator -= interval;
      steps += 1;
    }
    this.frameRequest = requestAnimationFrame((nextTime) => this.animate(nextTime));
  }

  step() {
    if (this.mode === "reverse") {
      this.solveReverse({ another: this.blockedPredecessors.length > 0 });
      return;
    }
    this.pause();
    this.advance();
  }

  advance() {
    if (this.mode !== "forward") return;
    this.current = evolveLife(this.current);
    this.generation += 1;
    this.populationHistory.push(lifePopulation(this.current));
    if (this.populationHistory.length > 90) this.populationHistory.shift();
    if (this.proofTarget && this.generation === 1) {
      this.statusMessage = lifeBoardsEqual(this.current, this.proofTarget)
        ? "Verified: one ordinary Life step exactly reproduces the requested target."
        : "Verification failed: the candidate did not reproduce the target.";
    }
    this.render();
  }

  invalidateSolution(message) {
    this.predecessor = null;
    this.blockedPredecessors = [];
    this.solutionTargetKey = lifeBoardKey(this.target);
    this.solverStats = null;
    this.solverProgress = null;
    this.statusMessage = message;
  }

  cancelSolve() {
    if (this.solverTimeout !== null) clearTimeout(this.solverTimeout);
    this.solverTimeout = null;
    this.worker?.terminate();
    this.worker = null;
    this.solving = false;
  }

  solveReverse({ another }) {
    if (!this.active || this.mode !== "reverse" || this.solving) return;
    const targetKey = lifeBoardKey(this.target);
    if (!another || targetKey !== this.solutionTargetKey) {
      this.blockedPredecessors = [];
      this.predecessor = null;
    }
    this.solutionTargetKey = targetKey;
    this.cancelSolve();
    this.solving = true;
    this.solverProgress = { stage: "loading" };
    this.statusMessage = another
      ? `Blocking ${this.blockedPredecessors.length} earlier answer${this.blockedPredecessors.length === 1 ? "" : "s"} and asking MiniSat again…`
      : "Encoding every Life neighborhood as Boolean constraints, then asking MiniSat for a model…";
    const requestId = ++this.requestSequence;
    const worker = new Worker(new URL("./reverse-life.worker.bundle.js", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.addEventListener("message", (event) => this.handleSolverMessage(event.data, requestId));
    worker.addEventListener("error", (event) => {
      if (requestId !== this.requestSequence) return;
      this.finishSolverError(event.message || "The solver worker stopped unexpectedly.");
    });
    this.solverTimeout = setTimeout(() => {
      if (requestId !== this.requestSequence) return;
      this.finishSolverError("Search exceeded 15 seconds. Try a smaller or less dense target.");
    }, SOLVER_TIMEOUT_MS);
    worker.postMessage({
      type: "solve",
      requestId,
      problem: {
        target: Array.from(this.target.cells),
        columns: this.target.columns,
        rows: this.target.rows,
        blocked: this.blockedPredecessors,
        objective: this.elements.objective.value,
      },
    });
    this.render();
  }

  handleSolverMessage(message, requestId) {
    if (requestId !== this.requestSequence || message?.requestId !== requestId) return;
    if (message.type === "progress") {
      this.solverProgress = message.progress;
      const stage = message.progress?.stage;
      this.statusMessage = stage === "encoding"
        ? "MiniSat worker loaded. Encoding every target neighborhood…"
        : stage === "solving"
          ? `Encoded ${message.progress.clauses.toLocaleString()} clauses. MiniSat is searching for a model…`
          : stage === "optimizing"
            ? "A valid past exists. Tightening the live-cell bound to find a sparsest one…"
            : this.statusMessage;
      this.render();
      return;
    }
    if (message.type === "error") {
      this.finishSolverError(message.message);
      return;
    }
    if (message.type !== "result") return;
    if (this.solverTimeout !== null) clearTimeout(this.solverTimeout);
    this.solverTimeout = null;
    this.worker?.terminate();
    this.worker = null;
    this.solving = false;
    this.solverProgress = null;
    const result = message.result;
    this.solverStats = result.stats;
    if (result.status === "unsat") {
      this.predecessor = null;
      this.statusMessage = this.blockedPredecessors.length > 0
        ? `UNSAT after ${this.blockedPredecessors.length} answer${this.blockedPredecessors.length === 1 ? "" : "s"}: there are no more predecessors under this boundary rule.`
        : "UNSAT: no predecessor exists on this closed board. This target is a finite Garden of Eden.";
    } else {
      this.predecessor = createLifeBoard(this.target.columns, this.target.rows, result.predecessor);
      this.blockedPredecessors.push(Array.from(this.predecessor.cells));
      this.statusMessage = `SAT in ${formatDuration(result.stats.totalMs)}. Forward verification passed; ${
        result.stats.predecessorPopulation
      } live cells produce the ${result.stats.targetPopulation}-cell target.`;
    }
    this.render();
  }

  finishSolverError(message) {
    this.requestSequence += 1;
    this.cancelSolve();
    this.solverProgress = null;
    this.statusMessage = `Solver stopped: ${message}`;
    this.render();
  }

  openForwardProof() {
    if (!this.predecessor) return;
    this.current = cloneLifeBoard(this.predecessor);
    this.generation = 0;
    this.populationHistory = [lifePopulation(this.current)];
    this.proofTarget = cloneLifeBoard(this.target);
    this.setMode("forward", { preserveCurrent: true });
  }

  pointerCell(canvas, event) {
    const layout = this.canvasLayouts.get(canvas);
    if (!layout) return null;
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const column = Math.floor((x - layout.offsetX) / layout.cellSize);
    const row = Math.floor((y - layout.offsetY) / layout.cellSize);
    if (column < 0 || row < 0 || column >= layout.columns || row >= layout.rows) return null;
    return { column, row };
  }

  render() {
    const forward = this.mode === "forward";
    const preview = evolveLife(this.current);
    const transition = lifeTransition(this.current, preview);
    const leftBoard = forward ? this.current : (this.predecessor || createLifeBoard());
    const rightBoard = forward ? preview : this.target;

    for (const button of this.elements.modeButtons) {
      const selected = button.dataset.lifeMode === this.mode;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    this.elements.leftTitle.textContent = forward ? `Generation ${this.generation}` : "Candidate predecessor";
    this.elements.leftKicker.textContent = forward ? "Editable state" : "Assigned by MiniSat";
    this.elements.leftCount.textContent = `${lifePopulation(leftBoard)} live`;
    this.elements.rightTitle.textContent = forward ? `Generation ${this.generation + 1}` : "Target generation";
    this.elements.rightKicker.textContent = forward ? "Rule preview" : "Editable constraints";
    this.elements.rightCount.textContent = `${lifePopulation(rightBoard)} live`;
    this.elements.arrowLabel.textContent = forward ? "B3 / S23" : "must produce";
    this.elements.leftCanvas.classList.toggle("is-editable", forward && !this.running);
    this.elements.rightCanvas.classList.toggle("is-editable", !forward && !this.solving);
    this.elements.reverseControls.hidden = forward;
    this.elements.forwardNote.hidden = !forward;
    this.elements.patternName.textContent = `${this.pattern.name} · ${this.pattern.family}`;
    this.elements.patternFact.textContent = this.pattern.fact;
    this.elements.status.textContent = this.statusMessage;
    this.elements.status.classList.toggle("is-solving", this.solving);
    this.elements.solve.disabled = this.solving;
    this.elements.solve.textContent = this.solving ? "Solving…" : "Find predecessor";
    this.elements.another.disabled = this.solving || !this.predecessor;
    this.elements.verify.disabled = this.solving || !this.predecessor;
    const constraintStats = this.solverStats || this.solverProgress;
    this.elements.constraintVariables.textContent = constraintStats?.satVariables
      ? constraintStats.satVariables.toLocaleString()
      : `${leftBoard.cells.length.toLocaleString()}+`;
    this.elements.constraintClauses.textContent = constraintStats?.clauses
      ? constraintStats.clauses.toLocaleString()
      : "generated on solve";
    this.elements.constraintResult.textContent = this.solving
      ? "searching"
      : this.solverStats
        ? `${this.predecessor ? "SAT" : "UNSAT"} · ${formatDuration(this.solverStats.totalMs)}`
        : "not solved";
    this.elements.constraintResult.classList.toggle("is-sat", Boolean(this.predecessor));

    this.drawBoards(leftBoard, rightBoard, transition);
    this.emitUpdate({ preview, transition });
  }

  emitUpdate(calculated = {}) {
    const preview = calculated.preview || evolveLife(this.current);
    const transition = calculated.transition || lifeTransition(this.current, preview);
    this.onUpdate({
      active: this.active,
      mode: this.mode,
      running: this.running,
      solving: this.solving,
      generation: this.generation,
      population: lifePopulation(this.current),
      nextPopulation: lifePopulation(preview),
      births: transition.births,
      deaths: transition.deaths,
      targetPopulation: lifePopulation(this.target),
      predecessorPopulation: this.predecessor ? lifePopulation(this.predecessor) : null,
      hasPredecessor: Boolean(this.predecessor),
      solutionCount: this.blockedPredecessors.length,
      solverStats: this.solverStats,
      populationHistory: [...this.populationHistory],
    });
  }

  draw() {
    const preview = evolveLife(this.current);
    const leftBoard = this.mode === "forward" ? this.current : (this.predecessor || createLifeBoard());
    const rightBoard = this.mode === "forward" ? preview : this.target;
    this.drawBoards(leftBoard, rightBoard, lifeTransition(this.current, preview));
  }

  drawBoards(leftBoard, rightBoard, transition) {
    if (!this.active) return;
    this.drawBoard(this.elements.leftCanvas, leftBoard, {
      side: "left",
      role: this.mode === "forward" ? "current" : "predecessor",
      comparison: this.mode === "forward" ? evolveLife(this.current) : null,
    });
    this.drawBoard(this.elements.rightCanvas, rightBoard, {
      side: "right",
      role: this.mode === "forward" ? "next" : "target",
      comparison: this.mode === "forward" ? this.current : null,
      transition,
    });
  }

  drawBoard(canvas, board, options) {
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return;
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round(bounds.width);
    const height = Math.round(bounds.height);
    const targetWidth = Math.round(width * pixelRatio);
    const targetHeight = Math.round(height * pixelRatio);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    const context = canvas.getContext("2d");
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#111d30";
    context.fillRect(0, 0, width, height);

    const padding = Math.max(8, Math.min(16, width * 0.03));
    const cellSize = Math.min((width - padding * 2) / board.columns, (height - padding * 2) / board.rows);
    const gridWidth = cellSize * board.columns;
    const gridHeight = cellSize * board.rows;
    const offsetX = (width - gridWidth) / 2;
    const offsetY = (height - gridHeight) / 2;
    this.canvasLayouts.set(canvas, {
      offsetX,
      offsetY,
      cellSize,
      columns: board.columns,
      rows: board.rows,
    });

    context.strokeStyle = "rgba(185, 202, 226, 0.09)";
    context.lineWidth = 1;
    context.beginPath();
    for (let column = 0; column <= board.columns; column += 1) {
      const x = offsetX + column * cellSize;
      context.moveTo(x, offsetY);
      context.lineTo(x, offsetY + gridHeight);
    }
    for (let row = 0; row <= board.rows; row += 1) {
      const y = offsetY + row * cellSize;
      context.moveTo(offsetX, y);
      context.lineTo(offsetX + gridWidth, y);
    }
    context.stroke();

    const inset = Math.max(1, cellSize * 0.08);
    for (let row = 0; row < board.rows; row += 1) {
      for (let column = 0; column < board.columns; column += 1) {
        const index = row * board.columns + column;
        if (!board.cells[index]) continue;
        let color = options.role === "target"
          ? "#73d7b5"
          : options.role === "predecessor"
            ? "#a7b9ff"
            : "#f2bd55";
        if (options.role === "next" && options.comparison && !options.comparison.cells[index]) {
          color = "#73d7b5";
        }
        const x = offsetX + column * cellSize + inset;
        const y = offsetY + row * cellSize + inset;
        const size = Math.max(1, cellSize - inset * 2);
        context.fillStyle = color;
        context.shadowColor = color;
        context.shadowBlur = cellSize > 12 ? 5 : 2;
        context.fillRect(x, y, size, size);
      }
    }
    context.shadowBlur = 0;

    if (this.canEdit(options.side) && this.hovered.canvas === canvas) {
      const x = offsetX + this.hovered.column * cellSize;
      const y = offsetY + this.hovered.row * cellSize;
      context.fillStyle = "rgba(255, 255, 255, 0.13)";
      context.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
      context.strokeStyle = "rgba(255, 255, 255, 0.72)";
      context.strokeRect(x + 1.5, y + 1.5, cellSize - 3, cellSize - 3);
    }
  }
}
