/**
 * `npm run prove` — check every claim against the recorded cycles, and
 * optionally against NEAR itself.
 *
 *   npm run prove                 offline: the records settle it, no network
 *   npm run prove -- --live       also ask NEAR: commit tx, sub reports, head
 *   npm run prove -- --live --write   write the proof packs and PROOFS.md
 *
 * Exit code 1 if any claim does not hold, so CI can gate on it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import "dotenv/config";
import { readCycles } from "../dashboard/data.js";
import { buildPack, tally, type ProofPack } from "../proof/pack.js";
import { liveChecks } from "../proof/verify.js";
import { renderProofs } from "../proof/proofs.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(REPO_ROOT, "data/runtime"));

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const WRITE = args.includes("--write");
const JSON_OUT = args.includes("--json");

const tick = (ok: boolean | null) => (ok === true ? "PASS" : ok === false ? "FAIL" : "n/a ");

async function main(): Promise<number> {
  const cycles = readCycles(DATA_DIR); // newest first
  if (!cycles.length) {
    console.log(`No recorded cycles in ${DATA_DIR}/public. Run: npm run cycle`);
    return 1;
  }

  const packs: ProofPack[] = cycles.map((c, i) =>
    buildPack({ record: c.record, run: c.run, prevRecord: cycles[i + 1]?.record ?? null }),
  );

  // the NEAR checks run on the newest cycle: that is the one whose hash the
  // contract should still be holding
  if (LIVE) {
    const newest = packs[0];
    const live = await liveChecks({
      record: cycles[0].record,
      commitTx: newest.memory_commit.tx,
      reports: newest.subs.map((s) => ({ sub: s.sub, action: s.action, account: s.account, tx: s.tx })),
      newestRecordHash: newest.decision.decision_hash,
      knownHashes: packs.map((p) => p.decision.decision_hash),
    });
    newest.checks.push(...live);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(packs, null, 2));
  } else {
    for (const p of packs) {
      const t = tally(p.checks);
      console.log(`\n${p.cycle_id}  ${t.pass} pass, ${t.fail} fail, ${t.skip} n/a`);
      for (const c of p.checks) console.log(`  ${tick(c.ok)}  ${c.claim}\n        ${c.detail}`);
    }
  }

  if (WRITE) {
    const dir = join(DATA_DIR, "proofs");
    mkdirSync(dir, { recursive: true });
    for (const p of packs) {
      writeFileSync(join(dir, `${p.cycle_id.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`), JSON.stringify(p, null, 2));
    }
    writeFileSync(join(dir, "latest.json"), JSON.stringify(packs[0], null, 2));
    const command = `npm run prove -- ${LIVE ? "--live " : ""}--write`;
    writeFileSync(join(REPO_ROOT, "PROOFS.md"), renderProofs(packs, { live: LIVE, command }).replace(/\n*$/, "\n"));
    console.log(`\nWrote ${packs.length} proof pack(s) to ${dir} and PROOFS.md`);
  }

  const all = packs.flatMap((p) => p.checks);
  const t = tally(all);
  console.log(`\n${t.pass} pass · ${t.fail} fail · ${t.skip} not applicable here${LIVE ? "" : "  (NEAR checks skipped; add --live)"}`);
  if (t.fail) console.log("At least one claim does not hold. Fix the claim or the code, never the wording.");
  return t.fail ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`prove failed: ${(err as Error).message}`);
    process.exit(1);
  },
);
