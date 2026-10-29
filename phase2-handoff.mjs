// Run from the repo root:  node phase2-handoff.mjs
// Adds the Phase 2 entry to HANDOFF.md (newest on top) and updates README status.
import { readFileSync, writeFileSync } from "node:fs";

const entry = `## 2026-10-29 — Phase 2 (done): on-chain memory gate live on NEAR testnet

**What was done:**

- Memory contract (\`contract/src/lib.rs\`) is deployed to \`mnemosyne-gov.testnet\`. \`commit(hash, prev_hash)\` only succeeds when the governor account calls its own contract (self-call check), and is chained against the on-chain \`latest_hash\`.
- \`src/memory.ts\` now sends a real \`commit\` transaction (near-api-js v7, governor key from \`.env\`) instead of writing \`memory-log.json\`. \`writeMemoryRecord()\` signature kept, and it now also returns \`txHash\`.
- \`src/cycle.ts\` uses the real governor account id (from \`GOVERNOR_ACCOUNT_ID\`) in the hashed record, and prints a nearblocks explorer link after each commit.
- **Verified:** \`npm run cycle\` commits on-chain and \`prev_memory_hash\` is read back from the contract, so the chain links across runs.
- **Verified fail-closed:** running with a bad \`GOVERNOR_PRIVATE_KEY\` prints \`[FAIL-CLOSED]\`, the cycle ends, and the ALLOCATE step never runs.
- Design confirmed: the governor alone writes memory. Subs are not co-authors; they only act inside the last committed mandate under limited keys.

**What's intentionally fake / not done yet:**

- \`getLatestMemoryRecord()\` returns placeholders for everything except the hashes (the contract only stores hashes + count). Fine while \`cycle.ts\` only reads \`.decision_hash\`.
- \`mnemosyne-sub-a\` and \`mnemosyne-sub-b\` each have a leftover function-call key scoped to \`commit\` on the governor contract. It can never succeed (the contract rejects non-governor callers) and is test debris. Remove it in Phase 3. Sub-C's keys were not inspected.
- Sub-agent keys are still FullAccess, not properly restricted (Phase 3).
- ALLOCATE is still print-only. No REFUSE logic (Phase 4), no x402 API (Phase 5), decide() is still a stub (Phase 6).

**Next step (not started):** Phase 3. Delete the stray \`commit\` keys on the subs, then replace each sub's FullAccess key with a real function-call key (limited methods, limited allowance), and make allocation happen only after the memory commit.

* * *

`;

const handoff = readFileSync("HANDOFF.md", "utf8");
const m = handoff.match(/^## \d{4}-\d{2}-\d{2}/m);
if (!m) {
  console.error("NOTHING WRITTEN: couldn't find the first dated entry in HANDOFF.md");
  process.exit(1);
}
if (handoff.includes("Phase 2 (done)")) {
  console.log("skip   HANDOFF.md (already has the Phase 2 done entry)");
} else {
  writeFileSync("HANDOFF.md", handoff.slice(0, m.index) + entry + handoff.slice(m.index));
  console.log("apply  HANDOFF.md");
}

const readme = readFileSync("README.md", "utf8");
const status = /## Current status:[^\n]*\n[\s\S]*?(?=\n## )/;
if (!status.test(readme)) {
  console.error("NOTHING WRITTEN to README: couldn't find the status section");
  process.exit(1);
}
if (readme.includes("Phase 2 — on-chain memory gate")) {
  console.log("skip   README.md (already updated)");
} else {
  const newStatus =
    "## Current status: Phase 2 — on-chain memory gate\n\n" +
    "One cycle (read -> decide -> memory commit -> allocate -> log) runs locally. " +
    "The memory commit is a real NEAR testnet transaction to `mnemosyne-gov.testnet`, " +
    "and the cycle fails closed if it doesn't go through. Allocation is still print-only, " +
    "and sub-agent keys are not restricted yet (Phase 3). No real funds move.\n";
  writeFileSync("README.md", readme.replace(status, newStatus));
  console.log("apply  README.md");
}

console.log("\nDone. Review with: git diff");
