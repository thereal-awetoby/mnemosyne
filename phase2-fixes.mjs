// Run from the repo root:  node phase2-fixes.mjs
// Applies the Phase 2 fixes. All-or-nothing: if any edit can't find its
// target, nothing is written. Undo with: git checkout src/
import { readFileSync, writeFileSync } from "node:fs";

const cyclePath = "src/cycle.ts";
const memoryPath = "src/memory.ts";
let cycle = readFileSync(cyclePath, "utf8");
let memory = readFileSync(memoryPath, "utf8");
const problems = [];

function edit(label, text, regex, replacer, doneMarker) {
  if (doneMarker && text.includes(doneMarker)) {
    console.log(`skip   ${label} (already applied)`);
    return text;
  }
  if (!regex.test(text)) {
    problems.push(label);
    return text;
  }
  console.log(`apply  ${label}`);
  return text.replace(regex, replacer);
}

// 1. cycle.ts: real governor id instead of the placeholder
cycle = edit(
  "cycle.ts governor id",
  cycle,
  /governor:\s*"mnemosyne\.testnet",[^\n]*/,
  'governor: process.env.GOVERNOR_ACCOUNT_ID ?? "mnemosyne-gov.testnet",',
  "process.env.GOVERNOR_ACCOUNT_ID"
);

// 2. cycle.ts: print explorer link after "committed."
cycle = edit(
  "cycle.ts explorer link",
  cycle,
  /([ \t]*)console\.log\(\s*"\s*committed\."\s*\);/,
  (m, indent) =>
    `${m}\n${indent}if (commitResult.txHash) console.log(\`      tx: https://testnet.nearblocks.io/txns/\${commitResult.txHash}\`);`,
  "nearblocks.io"
);

// 3. memory.ts: return type includes txHash
memory = edit(
  "memory.ts return type",
  memory,
  /Promise<\{\s*committed:\s*boolean;\s*error\?:\s*string\s*\}>/,
  "Promise<{ committed: boolean; txHash?: string; error?: string }>",
  "txHash?: string"
);

// 4. memory.ts: capture the transaction result
memory = edit(
  "memory.ts capture tx result",
  memory,
  /await account\.signAndSendTransaction\(/,
  "const res: any = await account.signAndSendTransaction(",
  "const res: any = await account.signAndSendTransaction("
);

// 5. memory.ts: return the tx hash
memory = edit(
  "memory.ts return txHash",
  memory,
  /return \{ committed: true \};/,
  "const txHash: string | undefined = res?.transaction?.hash ?? res?.transaction_outcome?.id;\n    return { committed: true, txHash };",
  "return { committed: true, txHash }"
);

if (problems.length) {
  console.error("\nNOTHING WRITTEN. Could not find a match for:");
  for (const p of problems) console.error("  - " + p);
  console.error("Paste this output back to Claude.");
  process.exit(1);
}

writeFileSync(cyclePath, cycle);
writeFileSync(memoryPath, memory);
console.log("\nDone. Review with: git diff");
