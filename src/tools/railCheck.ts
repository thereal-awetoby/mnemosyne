/**
 * Prove the real wNEAR top-up on testnet, without waiting for the governor to
 * choose INCREASE.
 *
 *   npm run rail:check                         1 unit (0.00001 wNEAR) to sub A
 *   npm run rail:check -- --sub B --units 5    5 units to sub B (at most 100)
 *
 * Same transfer code and memo as a cycle. Refuses unless the newest committed
 * memory record is on this machine and intact. See src/allocate/railCheck.ts.
 */

import "dotenv/config";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCycles } from "../dashboard/data.js";
import { getChainHead } from "../memory.js";
import { ftBalance, rpcUrl, swarmAsset } from "../swarmState.js";
import { runRailCheck } from "../allocate/railCheck.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(REPO_ROOT, "data/runtime"));
const GOV = process.env.GOVERNOR_ACCOUNT_ID ?? "";
const EXPLORER = "https://testnet.nearblocks.io/txns/";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

async function main() {
  if (!GOV || !process.env.GOVERNOR_PRIVATE_KEY) throw new Error("set GOVERNOR_ACCOUNT_ID / GOVERNOR_PRIVATE_KEY in .env");
  if (!rpcUrl().includes("testnet")) throw new Error("rail:check is testnet-only (NEAR_RPC_URL must be a testnet RPC)");
  const asset = swarmAsset();

  console.log(`\nrail check  (token ${asset}, governor ${GOV}; nothing here is a governor decision)\n`);
  const r = await runRailCheck(
    { sub: arg("--sub", "A"), units: Number(arg("--units", "1")) },
    {
      head: () => getChainHead(GOV),
      localRecords: () => readCycles(DATA_DIR).map((c) => c.record),
      balanceOf: (id) => ftBalance(id, asset),
      governorId: GOV,
    },
  );

  console.log(`  [OK ] newest memory commit on-chain: ${r.decision_hash}`);
  console.log(`        found here as cycle ${r.cycle_id}; it recomputes to its own hash and is inside its own limits`);
  console.log(`  [OK ] sent ${r.units} unit${r.units === 1 ? "" : "s"} (${r.wnear} wNEAR) from ${GOV} to ${r.account}`);
  console.log(`        memo "${r.memo}"  (the first 12 characters of that commit's hash)`);
  console.log(`        ${EXPLORER}${r.tx}`);
  console.log(r.memo_in_logs
    ? `  [OK ] the token's own transfer log carries the memo`
    : `  [note] the token did not echo the memo in its log; it is still in the transaction's call arguments on the explorer`);
  console.log(`  [OK ] ${r.account} balance: ${r.before_units} -> ${r.after_units} units`);
  console.log("\nRAIL OK\n");
}

main().catch((err) => {
  console.error(`\nrail:check refused or failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
