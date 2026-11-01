/**
 * One governor cycle (docs/BUILD_PLAN.md section 7).
 *
 * read -> decide (private: NEAR AI TEE or local rule) -> MEMORY COMMIT on NEAR (fail-closed gate)
 * -> allocate (src/allocate: print-only, or real wNEAR top-ups) -> sub-agent window
 * (each sub checks its mandate, then reports ACT/REFUSE on-chain with its own
 * report-only key) -> log.
 *
 * Swarm balances are real with SWARM_STATE=onchain (src/swarmState.ts); the
 * losses are still a labelled simulation. ALLOCATE moves real (tiny) wNEAR only
 * with ALLOCATE_MODE=wnear, and only after the memory commit. The risk limits
 * come from src/limits and are written into every memory record.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { swarmScenario } from "./subAgents.js";
import { fmtWnear, readSwarm, unitsToYocto, type SwarmSnapshot } from "./swarmState.js";
import { runAllocate, AllocationGateError, type AllocationEntry } from "./allocate/index.js";
import { crossChainEnabled, runCrossChainAllocate, type CrossChainRunLog } from "./allocate/cross_chain.js";
import { envelopeToSwarmRisk, loadLimits } from "./limits/index.js";
import { decidePrivately, type DecisionOutcome } from "./private/decide.js";
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

/** What happened on-chain for a cycle (commit + sub report txs). Kept next
 *  to the public record, not inside it, so decision_hash stays checkable. */
export interface CycleRun {
  cycle_id: string;
  finished_at: string;
  committed: boolean;
  commit_tx: string | null;
  error: string | null;
  verdicts: Array<{ sub: string; action: string; reason: string }>;
  reports: Array<{ sub: string; status: string; action?: string; accountId?: string; txHash?: string; error?: string }>;
  /** where the swarm numbers came from, and how ALLOCATE ran (absent in older runs) */
  swarm_source?: "simulated" | "onchain";
  allocate_mode?: "print" | "wnear";
  allocations?: AllocationEntry[];
  /** Phase 7: the cross-chain quote for this cycle (only when CROSS_CHAIN_ALLOCATE=1). Quote only, never a fill. */
  cross_chain?: CrossChainRunLog;
  limits_source?: "default" | "owner";
}

function writeRun(run: CycleRun): void {
  try {
    const dir = join(DATA_DIR, "public");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${run.cycle_id.replace(/[^A-Za-z0-9_.-]/g, "_")}.run.json`), JSON.stringify(run, null, 2));
  } catch (err) {
    console.log(`      (could not write run log: ${(err as Error).message})`);
  }
}

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
  let swarm: SwarmSnapshot;
  try {
    swarm = await readSwarm();
  } catch (err) {
    // Fail-closed: no real balances means no decision, and nothing is committed.
    console.log(`[FAIL-CLOSED] could not read the swarm state: ${(err as Error).message}. Cycle ends. Nothing committed.`);
    throw err;
  }
  const swarmState = swarm.state;
  const { limits, source: limitsSource } = loadLimits(DATA_DIR);
  if (swarm.source === "onchain") {
    const empty = swarmState.filter((x) => x.capital === 0).map((x) => x.sub);
    if (empty.length) console.log(`      note: sub ${empty.join(", ")} hold${empty.length === 1 ? "s" : ""} 0 units, and capital can't grow from nothing. Run npm run swarm:setup to fund them.`);
  }
  const prev = await getLatestMemoryRecord();
  const prevHash = prev ? prev.decision_hash : null;
  console.log(`      prev_memory_hash: ${prevHash ?? "(none — first cycle)"}`);
  console.log(`      limits: ${limitsSource === "owner" ? "set by the owner" : "built-in defaults"} (total exposure ${limits.max_total_exposure}, per sub ${limits.per_sub_max_capital}, pause at loss ${limits.pause_loss_threshold})`);

  // 2. DECIDE (private)
  const apiKey = process.env.NEAR_AI_API_KEY || undefined;
  console.log(`[2/6] DECIDE: ${apiKey ? `private reasoning in a NEAR AI Cloud TEE (${process.env.NEAR_AI_MODEL || "Qwen/Qwen3.8-27B"})` : "local policy rule (no NEAR_AI_API_KEY)"}...`);
  if (swarm.source === "onchain") {
    console.log(`      swarm state: balances REAL (${swarm.asset} on testnet): ${swarmState.map((s) => `${s.sub}=${s.capital}`).join(" ")} units; losses SIMULATED, scenario "${swarmScenario()}"`);
  } else {
    console.log(`      swarm state: SIMULATED, scenario "${swarmScenario()}"`);
  }
  let outcome: DecisionOutcome;
  try {
    outcome = await decidePrivately(cycleId, swarmState, {
      apiKey,
      model: process.env.NEAR_AI_MODEL || undefined,
      verify: process.env.TEE_VERIFY === "signature" ? "signature" : "full",
      dataDir: DATA_DIR,
      env: limits,
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
    swarm_risk: envelopeToSwarmRisk(limits),
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
    writeRun({ cycle_id: cycleId, finished_at: new Date().toISOString(), committed: false, commit_tx: null, error: commitResult.error ?? "commit failed", verdicts: [], reports: [], swarm_source: swarm.source, limits_source: limitsSource });
    return { memoryRecord, privateDecision, committed: false };
  }
  console.log("      committed.");
  if (commitResult.txHash) console.log(`      tx: https://testnet.nearblocks.io/txns/${commitResult.txHash}`);

  // 4. CAPITAL / AUTHORITY ACTION — only after memory is confirmed.
  // runAllocate() checks the gate again itself: no committed record that
  // matches its own hash, no allocation.
  let allocateMode: "print" | "wnear" = "print";
  let allocations: AllocationEntry[] = [];
  let allocateGateOk = false;
  try {
    const out = await runAllocate({ record: memoryRecord, commit: commitResult, state: swarmState, source: swarm.source });
    allocateGateOk = true;
    allocateMode = out.mode;
    allocations = out.entries;
    console.log(`[4/6] ALLOCATE: applying decisions (${allocateMode === "wnear" ? "real wNEAR top-ups on testnet, tiny amounts" : "print-only — no real transfers"})...`);
    for (const e of allocations) {
      console.log(`      sub ${e.sub}: ${e.note}`);
      if (e.tx) console.log(`        tx: https://testnet.nearblocks.io/txns/${e.tx}`);
    }
    const moved = allocations.filter((e) => e.kind === "transfer" && e.tx);
    if (moved.length) console.log(`      moved ${fmtWnear(unitsToYocto(moved.reduce((t, e) => t + e.units, 0)))} wNEAR in total`);
  } catch (err) {
    console.log(`[4/6] ALLOCATE: ${err instanceof AllocationGateError ? "[FAIL-CLOSED] " : "failed: "}${(err as Error).message}`);
  }

  // 4b. Phase 7, off by default: ask Rhea / NEAR Intents for a cross-chain price. Quote only,
  // never a fill. It runs only if the same-chain allocation step passed the memory gate,
  // and runCrossChainAllocate() checks that gate again itself.
  let crossChain: CrossChainRunLog | undefined;
  let crossChainOn = false;
  try { crossChainOn = crossChainEnabled(); } catch (err) { console.log(`      cross-chain: ${(err as Error).message}; skipped`); }
  if (crossChainOn && allocateGateOk) {
    try {
      const cc = await runCrossChainAllocate({ record: memoryRecord, commit: commitResult, state: swarmState, source: swarm.source });
      crossChain = cc.summary;
      allocations = [...allocations, ...cc.entries];
      for (const e of cc.entries) console.log(`      sub ${e.sub}: ${e.note}`);
      if (cc.summary.memory_tx_url) console.log(`        allowed by memory commit: ${cc.summary.memory_tx_url}`);
    } catch (err) {
      console.log(`      cross-chain: ${err instanceof AllocationGateError ? "[FAIL-CLOSED] " : "failed: "}${(err as Error).message}`);
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

  writeRun({
    cycle_id: cycleId,
    finished_at: new Date().toISOString(),
    committed: true,
    commit_tx: commitResult.txHash ?? null,
    error: null,
    verdicts: verdicts.map((v) => ({ sub: v.sub, action: v.action, reason: v.reason })),
    reports: reports.map((r) => ({ sub: r.sub, status: r.status, action: r.action, accountId: r.accountId, txHash: r.txHash, error: r.error })),
    swarm_source: swarm.source,
    allocate_mode: allocateMode,
    allocations,
    ...(crossChain ? { cross_chain: crossChain } : {}),
    limits_source: limitsSource,
  });
  return { memoryRecord, privateDecision, committed: true, reports };
}
