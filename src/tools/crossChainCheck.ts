/**
 * Ask Rhea / NEAR Intents for a cross-chain price for the newest committed
 * memory record, without running a whole cycle. QUOTE ONLY: nothing is sent,
 * signed or deposited, and no private key is needed.
 *
 *   set CROSS_CHAIN_RECIPIENT=0x1234567890abcdef1234567890abcdef12345678   (an address you own)
 *   npm run crosschain:check
 *
 * Same gate as the cycle: it needs the newest on-chain memory commit to match
 * an intact record on this machine. See docs/CROSS_CHAIN.md.
 */

import "dotenv/config";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCycles } from "../dashboard/data.js";
import { getChainHead } from "../memory.js";
import { DESTINATIONS, loadCrossChainConfig, runCrossChainAllocate } from "../allocate/cross_chain.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(REPO_ROOT, "data/runtime"));
const GOV = process.env.GOVERNOR_ACCOUNT_ID ?? "";

async function main() {
  if (!GOV) throw new Error("set GOVERNOR_ACCOUNT_ID in .env");
  const cfg = loadCrossChainConfig();
  console.log(`\ncross-chain check  (quote only: nothing is sent, signed or deposited)`);
  console.log(`  provider ${cfg.provider}, sub ${cfg.sub}, ${cfg.units} units -> ${cfg.dest} (${DESTINATIONS[cfg.dest]?.chain_label ?? "not allowlisted"}), recipient ${cfg.recipient ?? "NOT SET"}\n`);

  const head = await getChainHead(GOV);
  if (!head.latest_hash || head.commit_count === 0) throw new Error("the chain holds no memory commit yet: run npm run cycle first. No memory, no quote.");
  const hit = readCycles(DATA_DIR).find((c) => c.record?.decision_hash === head.latest_hash);
  if (!hit) throw new Error(`the newest on-chain memory commit (${head.latest_hash.slice(0, 19)}...) has no record on this machine. Run npm run cycle here first.`);

  const out = await runCrossChainAllocate({ record: hit.record, commit: { committed: true, txHash: hit.run?.commit_tx ?? undefined }, state: [], source: "onchain" }, { config: cfg });
  const s = out.summary;
  console.log(`  memory commit  ${s.decision_hash}`);
  if (s.memory_tx_url) console.log(`                 ${s.memory_tx_url}`);
  for (const e of out.entries) console.log(`  ${e.note}`);
  if (s.status === "quoted") {
    console.log(`  quote id       ${s.provider_quote_id ?? "(provider gave none)"}   ref ${s.quote_ref}`);
    console.log(`\n  ${s.note}\n\nQUOTE OK\n`);
  } else {
    console.log(`\nNO QUOTE (${s.status}). Nothing was sent.`);
    if (s.status === "unavailable") console.log(`If the provider refused the request (for example 1Click 400), run: npm run crosschain:probe\n`);
    else console.log("");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\ncrosschain:check refused or failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
