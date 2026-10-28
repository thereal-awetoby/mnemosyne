import { runCycle } from "./cycle.js";

runCycle()
  .then((result) => {
    if (!result.committed) process.exitCode = 1;
  })
  .catch((err) => {
    console.error("Uncaught error running cycle:", err);
    process.exitCode = 1;
  });
