// Worker thread for one best-result variant (see variant-run.mjs).
import { parentPort, workerData } from "node:worker_threads";
import { runVariant } from "./variant-run.mjs";

try {
  const result = runVariant(workerData.input, workerData.variant, (done, total) => parentPort.postMessage({ type: "progress", done, total }));
  parentPort.postMessage({ type: "done", result });
} catch (error) {
  parentPort.postMessage({ type: "error", name: error.name, message: error.message, details: error.details ?? null });
}
