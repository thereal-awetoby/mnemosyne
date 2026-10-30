import { runCycle } from "./cycle.js";

runCycle()
  .then((result) => {
    if (!result.committed) process.exitCode = 1;
    // A sub whose report() was attempted and failed is an integrity problem
    // (audit trail incomplete), so surface it in the exit code too.
    if (result.reports?.some((r) => r.status === "failed")) process.exitCode = 1;
  })
  .catch((err) => {
    console.error("Uncaught error running cycle:", err);
    process.exitCode = 1;
  });
