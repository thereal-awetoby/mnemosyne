/**
 * One governor cycle (docs/BUILD_PLAN.md section 7).
 *
 * read -> decide (stub, private) -> MEMORY COMMIT on NEAR (fail-closed gate)
 * -> allocate (print-only) -> sub-agent window (each sub checks its mandate,
 * then reports ACT/REFUSE on-chain with its own report-only key) -> log.
 *
 * Still simulated: swarm state (readFakeSwarmState), decide() (Phase 6),
 * and ALLOCATE (no real transfers). Everything else talks to testnet.
 */

import { readFakeSwarmState, SUB_AGENTS } from "./subAgents.js";
import { getLatestMemoryRecord, hashDecision, writeMemoryRecord } from "./memory.js";
import { evaluateSubDecision, type SubRuntimeDecision } from "./refuse.js";
import { reportOnChain, type ReportResult } from "./report.js";
import type {
  CycleResult,
  MemoryRecord,
  PrivateDecision,
  SubDecision,
  SubId,
} from "./types.js";

function makeCycleId(): string {
  return new Date().toISOString() + "-" + Math.random().toString(16).slice(2, 7);
}

/**
 * Step 2: DECIDE (private).
 *
 * Stub logic for now — deterministic, not "AI", just enough to exercise
 * every branch (KEEP / INCREASE / CUT / PAUSE) so later phases have a
 * real decision object to replace this with. This is the function a
 * later phase swaps out for a real private reasoning path.
 */
function decide(cycleId: string, swarmState: ReturnType<typeof readFakeSwarmState>): {
  decisions: SubDecision[];
  privateDecision: PrivateDecision;
} {
  const decisions: SubDecision[] = swarmState.map((s) => {
    const profile = SUB_AGENTS.find((a) => a.id === s.sub)!;
    if (s.lastCycleLoss > 100) {
      return { sub: s.sub, action: "PAUSE", reason_code: "local_loss_limit" };
    }
    return {
      sub: s.sub,
      action: "KEEP",
      target_capital: String(s.capital),
      max_position: String(Math.round(s.capital * 0.2)),
      max_loss_cycle: String(Math.round(s.capital * 0.05)),
      mandate: profile.mandate,
    };
  });

  const privateDecision: PrivateDecision = {
    cycle_id: cycleId,
    reasoning:
      "[stub] No real reasoning yet — Phase 1 placeholder. Every sub kept at current capital unless its last-cycle loss exceeded 100.",
    raw_inputs: { swarmState },
  };

  return { decisions, privateDecision };
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
  console.log("[2/6] DECIDE: running (stub) private decision logic...");
  const { decisions, privateDecision } = decide(cycleId, swarmState);

  const recordWithoutHash: Omit<MemoryRecord, "decision_hash"> = {
    cycle_id: cycleId,
    governor: process.env.GOVERNOR_ACCOUNT_ID ?? "mnemosyne-gov.testnet",
    prev_memory_hash: prevHash,
    decisions,
    swarm_risk: {
      max_total_exposure: "3000",
      max_daily_loss: "150",
    },
    schema_version: 1,
  };
  const decisionHash = hashDecision(recordWithoutHash);
  const memoryRecord: MemoryRecord = { ...recordWithoutHash, decision_hash: decisionHash };
  console.log(`      decision_hash: ${decisionHash}`);

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
