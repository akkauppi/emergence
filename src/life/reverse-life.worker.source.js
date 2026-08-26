import { solveReverseLife } from "./reverse-life-solver.js";

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  if (message.type !== "solve") return;
  try {
    self.postMessage({
      type: "progress",
      requestId: message.requestId,
      progress: { stage: "encoding" },
    });
    const result = await solveReverseLife({
      ...message.problem,
      onProgress(progress) {
        self.postMessage({ type: "progress", requestId: message.requestId, progress });
      },
    });
    self.postMessage({ type: "result", requestId: message.requestId, result });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
