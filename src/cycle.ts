/**
 * One governor cycle (docs/BUILD_PLAN.md section 7).
 *
 * read -> decide (private: NEAR AI TEE or local rule) -> MEMORY COMMIT on NEAR (fail-closed gate)
 * -> allocate (print-only) -> sub-agent window (each sub checks its mandate,
 * then reports ACT/REFUSE on-chain with its own report-only key) -> log.
 *
 * Still simulated: swarm state (readFakeSwarmState, SWARM_SCENARIO) and
 * ALLOCATE (no real transfers). Everything else talks to testnet / NEAR AI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFakeSwarmState, swarmScenario } from "./subAgents.js";
import { decidePrivately, DEFAULT_ENVELOPE, type DecisionOutcome } from "./private/decide.js";
import { getLatestMemoryRecord, hashDecision, writeMemoryRecord } from "./memory.js";
import { evaluateSubDecision, type SubRuntimeDecision } from "./refuse.js";
import { reportOnChain, type ReportResult } from "./report.js";
import type {
  CycleResult,
  MemoryRecord,
  PrivateDecision,
  SubId,
} from "./types.js";

function makeCycleId(): string {
  return new Date().toISOString() + "-" + Math.random().toString(16).slice(2, 7);
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(REPO_ROOT, "data/runtime"));

function writePublicRecord(rec: MemoryRecord): string {
  const dir = join(DATA_DIR, "public");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${rec.cycle_id.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  writeFileSync(file, JSON.stringify(rec, null, 2));
  return file;
}

/** Public summaries of past lessons: context for the private decision. They
 *  go to the TEE only, never into the public record. */
function memoryLessons(): string[] {
  for (const p of [join(DATA_DIR, "memory.json"), join(REPO_ROOT, "data/seed-memory.json")]) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      return (j.entries ?? []).map((e: any) => String(e.public_summary ?? "")).filter(Boolean).slice(-8);
    } catch { /* fall through */ }
  }
  return [];
}

export async function runCycle(): Promise<CycleResult> {
  const cycleId = makeCycleId();
  console.log(`\n=== Mnemosyne cycle ${cycleId} ===`);

  // 1. READ
  console.log("[1/6] READ: reading swarm state...");
  const swarmState = readFakeSwarmState();
  const prev = await getLatestMemoryRecord();
  const prevHash = prev ? prev.decision_hash : null;
  console.log(`      prev_memory_hash: ${prevHash ?? "(none — first cycle)"}`);

  // 2. DECIDE (private)
  const apiKey = process.env.NEAR_AI_API_KEY || undefined;
  console.log(`[2/6] DECIDE: ${apiKey ? `private reasoning in a NEAR AI Cloud TEE (${process.env.NEAR_AI_MODEL || "Qwen/Qwen3.8-27B"})` : "local policy rule (no NEAR_AI_API_KEY)"}...`);
  console.log(`      swarm state: SIMULATED, scenario "${swarmScenario()}"`);
  let outcome: DecisionOutcome;
  try {
    outcome = await decidePrivately(cycleId, swarmState, {
      apiKey,
      model: process.env.NEAR_AI_MODEL || undefined,
      verify: process.env.TEE_VERIFY === "signature" ? "signature" : "full",
      dataDir: DATA_DIR,
      lessons: memoryLessons(),
    });
  } catch (err) {
    // Fail-closed: an unverifiable private decision is no decision at all.
    // Nothing is committed and nothing is allocated.
    console.log(`[FAIL-CLOSED] private decision failed: ${(err as Error).message}. Cycle ends. Nothing committed.`);
    throw err;
  }
  const { decisions } = outcome;
  const privateDecision: PrivateDecision = {
    cycle_id: cycleId,
    path: outcome.path,
    private_file: outcome.privateFile,
    guard_adjustments: outcome.guardAdjustments,
  };
  if (outcome.tee) {
    const c = outcome.tee.checks;
    const tdx = c.tdx === "not_checked" ? "not checked" : `${c.tdx.verified ? "OK" : "FAIL"} (${c.tdx.status})`;
    const gpu = c.gpu === "not_checked" ? "not checked" : c.gpu.verdict && c.gpu.token_signature_valid ? "OK" : "FAIL";
    console.log(`      TEE signer ${outcome.tee.signing_address}: signature OK, bound to fresh nonce, Intel TDX ${tdx}, NVIDIA GPU ${gpu}`);
  }
  console.log(`      policy guard adjustments: ${outcome.guardAdjustments}`);
  console.log(`      private_commitment: ${outcome.privateCommitment} (blob stays local)`);

  const recordWithoutHash: Omit<MemoryRecord, "decision_hash"> = {
    cycle_id: cycleId,
    governor: process.env.GOVERNOR_ACCOUNT_ID ?? "mnemosyne-gov.testnet",
    prev_memory_hash: prevHash,
    decisions,
    swarm_risk: {
      max_total_exposure: String(DEFAULT_ENVELOPE.max_total_exposure),
      max_daily_loss: String(DEFAULT_ENVELOPE.max_daily_loss),
    },
    schema_version: 2,
    decision_path: outcome.path,
    private_commitment: outcome.privateCommitment,
    tee: outcome.tee,
  };
  const decisionHash = hashDecision(recordWithoutHash);
  const memoryRecord: MemoryRecord = { ...recordWithoutHash, decision_hash: decisionHash };
  console.log(`      decision_hash: ${decisionHash}`);
  // The public record, so anyone can recompute decision_hash and check the
  // TEE signature (npm run tee:check -- --record <file>).
  const publicFile = writePublicRecord(memoryRecord);
  console.log(`      public record: ${publicFile}`);

  // 3. MEMORY COMMIT (mandatory gate)
  console.log("[3/6] MEMORY COMMIT: writing memory record (on-chain, mnemosyne-gov.testnet)...");
  const commitResult = await writeMemoryRecord(memoryRecord);

  if (!commitResult.committed) {
    // Fail-closed: no capital/authority action follows a failed commit.
    console.log(`[FAIL-CLOSED] memory commit failed (${commitResult.error}). Cycle ends. No allocation performed.`);
    return { memoryRecord, privateDecision, committed: false };
  }
  console.log("      committed.");
  if (commitResult.txHash) console.log(`      tx: https://testnet.nearblocks.io/txns/${commitResult.txHash}`);

  // 4. CAPITAL / AUTHORITY ACTION — only after memory is confirmed.
  console.log("[4/6] ALLOCATE: applying decisions (print-only — no real transfers yet)...");
  for (const d of memoryRecord.decisions) {
    if (d.action === "PAUSE") {
      console.log(`      sub ${d.sub}: PAUSE (${d.reason_code})`);
    } else {
      console.log(
        `      sub ${d.sub}: ${d.action} -> target_capital=${d.target_capital}, max_position=${d.max_position}, max_loss_cycle=${d.max_loss_cycle}, mandate=${d.mandate}`
      );
    }
  }

  // 5. SUB-AGENT WINDOW
  // Each sub validates the directive against its own mandate (local), then
  // writes its ACT/REFUSE on-chain via report(), signing with ITS OWN
  // report-only key. PAUSE subs are inactive and don't report.
  console.log("[5/6] SUB-AGENT WINDOW: mandate checks + on-chain report()...");
  const verdicts: SubRuntimeDecision[] = [];
  for (const d of memoryRecord.decisions) {
    if (d.action === "PAUSE") {
      console.log(`      sub ${d.sub}: PAUSE -> inactive this cycle, nothing to report`);
      continue;
    }
    let verdict: SubRuntimeDecision;
    if (!d.target_capital || !d.max_position || !d.max_loss_cycle || !d.mandate) {
      verdict = { sub: d.sub, action: "REFUSE", reason: "missing directive fields from governor, fail-closed" };
    } else {
      verdict = evaluateSubDecision({
        sub: d.sub,
        status: d.action,
        target_capital: Number(d.target_capital),
        max_position: Number(d.max_position),
        max_loss_cycle: Number(d.max_loss_cycle),
        mandate: d.mandate,
        current_capital: swarmState.find((s) => s.sub === d.sub)?.capital,
      });
    }
    verdicts.push(verdict);
    console.log(`      sub ${d.sub}: ${verdict.action} (${verdict.reason})`);
  }

  // Tie each report to this cycle's commitment so the audit trail links up.
  const shortHash = decisionHash.replace(/^sha256:/, "").slice(0, 12);
  // Different signer accounts -> no nonce contention, so send in parallel.
  const reports: ReportResult[] = await Promise.all(
    verdicts.map((v) =>
      reportOnChain(v.sub as SubId, v.action, `cycle ${shortHash}: ${v.reason}`)
    )
  );
  for (const r of reports) {
    if (r.status === "reported") {
      console.log(`      sub ${r.sub} -> on-chain ${r.action} as ${r.accountId}`);
      if (r.txHash) console.log(`        tx: https://testnet.nearblocks.io/txns/${r.txHash}`);
    } else if (r.status === "skipped") {
      console.log(`      sub ${r.sub} -> NOT reported (${r.error})`);
    } else {
      console.log(`      sub ${r.sub} -> REPORT FAILED as ${r.accountId}: ${r.error}`);
    }
  }

  // 6. PUBLIC LOG
  console.log("[6/6] PUBLIC LOG: cycle complete.");
  console.log(`=== end cycle ${cycleId} ===\n`);

  return { memoryRecord, privateDecision, committed: true, reports };
}
