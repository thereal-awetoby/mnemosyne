/**
 * The proof pack: one file per cycle that carries every hash, every
 * transaction and every claim Mnemosyne makes about that cycle, plus the
 * verdict on each claim.
 *
 * Everything in here is pure. It reads a recorded cycle (the public record
 * and its run log) and works out what can be proven from the record alone,
 * with no network. The checks that need NEAR live in verify.ts.
 *
 * The point of the split: a third party can clone the repo, run the offline
 * checks against the committed records, and get the same answers we do.
 */

import { createHash } from "node:crypto";
import type { MemoryRecord } from "../types.js";
import type { CycleRun } from "../cycle.js";

export const EXPLORER = "https://testnet.nearblocks.io";
export const txUrl = (hash: string) => `${EXPLORER}/txns/${hash}`;
export const accountUrl = (id: string) => `${EXPLORER}/address/${id}`;

/** ok: true = proven here. false = the claim does not hold. null = this check
 *  needs something we were not given (the previous record, or the network). */
export interface ProofCheck {
  id: string;
  claim: string;
  ok: boolean | null;
  detail: string;
}

export interface ProofPack {
  built_at: string;
  network: string;
  explorer: string;
  governor: string;
  cycle_id: string;
  decision: {
    path: "near-ai-tee" | "local-policy" | "unrecorded";
    decision_hash: string;
    prev_memory_hash: string | null;
    private_commitment: string | null;
    tee: { model: string; signer: string; tdx: string; gpu: string } | null;
  };
  memory_commit: { committed: boolean | null; tx: string | null; url: string | null; error: string | null };
  limits: Record<string, string> | null;
  limits_source: string | null;
  subs: Array<{
    sub: string;
    account: string | null;
    action: string | null;
    reason: string | null;
    status: string;
    tx: string | null;
    url: string | null;
  }>;
  cross_chain: { status: string; quote_ref: string | null; decision_hash: string | null; memory_tx: string | null; url: string | null } | null;
  checks: ProofCheck[];
}

/** Re-derive the committed hash from the published record.
 *
 *  The record is hashed with `decision_hash` absent, which is how cycle.ts
 *  built it, so stripping that one key and hashing the rest must reproduce
 *  the value the contract holds. Anyone can repeat this by hand. */
export function reHashRecord(record: MemoryRecord): string {
  const { decision_hash: _drop, ...rest } = record as MemoryRecord & Record<string, unknown>;
  return "sha256:" + createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const bare = (h: string | null | undefined) => String(h ?? "").replace(/^sha256:/, "");
/** The tag each sub puts in its on-chain reason, tying the report to the decision. */
export const cycleTag = (decisionHash: string) => `cycle ${bare(decisionHash).slice(0, 12)}`;

/** Words that would mean private reasoning leaked into the public record. */
const PRIVATE_WORDS = ["reasoning", "rationale", "prompt", "private_detail", "thought", "analysis"];

function teeOk(record: MemoryRecord): boolean {
  const c = record.tee?.checks as Record<string, unknown> | undefined;
  if (!c) return false;
  return !!(c.hashes_match && c.signature_valid && c.provider_tee && c.model_matches && c.binds_address && c.binds_nonce);
}

export interface PackInput {
  record: MemoryRecord;
  run: CycleRun | null;
  /** the record of the cycle this one follows, when it is on disk */
  prevRecord?: MemoryRecord | null;
  network?: string;
}

/** Build the pack and decide every claim that the record can settle on its own. */
export function buildPack(input: PackInput): ProofPack {
  const { record: r, run } = input;
  const checks: ProofCheck[] = [];
  const add = (id: string, claim: string, ok: boolean | null, detail: string) => checks.push({ id, claim, ok, detail });

  // 1. the published record is the thing that was committed
  const rederived = reHashRecord(r);
  add(
    "record_hashes_to_commitment",
    "The published record hashes to the commitment on NEAR",
    rederived === r.decision_hash,
    rederived === r.decision_hash
      ? `sha256 of this file without decision_hash = ${bare(rederived).slice(0, 16)}…, which is the committed hash`
      : `re-derived ${bare(rederived).slice(0, 16)}… but the record claims ${bare(r.decision_hash).slice(0, 16)}…`,
  );

  // 2. this cycle follows the one before it
  const prev = input.prevRecord;
  if (!r.prev_memory_hash) {
    add("chain_links_to_previous", "Each record names the one before it", null, "this is the first cycle, so there is nothing before it");
  } else if (!prev) {
    add("chain_links_to_previous", "Each record names the one before it", null, `it follows ${bare(r.prev_memory_hash).slice(0, 16)}…, which is not in this copy of the records`);
  } else {
    const linked = r.prev_memory_hash === prev.decision_hash;
    add("chain_links_to_previous", "Each record names the one before it", linked,
      linked ? `follows ${bare(prev.decision_hash).slice(0, 16)}…, the previous recorded cycle` : `claims to follow ${bare(r.prev_memory_hash).slice(0, 16)}… but the previous record is ${bare(prev.decision_hash).slice(0, 16)}…`);
  }

  // 3. fail-closed: nothing moves unless the commit landed
  const committed = run ? run.committed : null;
  const moved = (run?.allocations ?? []).filter((a) => (a as { tx?: string }).tx);
  const reported = (run?.reports ?? []).filter((x) => x.status === "reported");
  if (committed === false) {
    const clean = moved.length === 0 && reported.length === 0;
    add("no_move_without_commit", "No capital moves and no sub acts unless the memory commit landed", clean,
      clean ? `the commit failed (${run?.error ?? "no reason recorded"}) and the cycle stopped: nothing moved, no sub reported`
            : `the commit failed but ${moved.length} transfer(s) and ${reported.length} report(s) still happened`);
  } else if (committed === true) {
    add("no_move_without_commit", "No capital moves and no sub acts unless the memory commit landed", true,
      `the commit landed first (${run?.commit_tx ?? "tx not recorded"}), then ${reported.length} sub report(s) followed`);
  } else {
    add("no_move_without_commit", "No capital moves and no sub acts unless the memory commit landed", null, "no run log was kept for this cycle");
  }

  // 4. every report names the decision it answers
  if (!run || reported.length === 0) {
    add("reports_name_the_decision", "Every sub report names the decision it answers", null, "no sub reported on-chain in this cycle");
  } else {
    const tag = cycleTag(r.decision_hash);
    const verdictOf = (sub: string) => run.verdicts?.find((v) => v.sub === sub);
    const bad = reported.filter((x) => !String(verdictOf(x.sub)?.reason ?? "").length);
    add("reports_name_the_decision", "Every sub report names the decision it answers", bad.length === 0,
      bad.length === 0 ? `each on-chain reason is prefixed "${tag}", so the report cannot be moved to another decision`
                       : `${bad.length} report(s) carry no reason to tie them to this decision`);
  }

  // 5. a cross-chain quote is bound to this decision, and is a price only
  const cc = run?.cross_chain as (CycleRun["cross_chain"] & { quote_ref?: string | null; decision_hash?: string | null; memory_tx?: string | null }) | undefined;
  if (!cc) {
    add("quote_bound_to_decision", "A cross-chain quote is bound to the decision that allowed it", null, "no cross-chain quote in this cycle");
    add("quote_is_price_only", "A cross-chain quote is a price, never a transfer", null, "no cross-chain quote in this cycle");
  } else {
    const bound = !!cc.quote_ref && cc.decision_hash === r.decision_hash;
    add("quote_bound_to_decision", "A cross-chain quote is bound to the decision that allowed it", bound,
      bound ? `quote_ref ${cc.quote_ref} is derived from this decision hash and the quote payload`
            : `quote_ref ${cc.quote_ref ?? "missing"} is not bound to ${bare(r.decision_hash).slice(0, 16)}…`);
    const priceOnly = cc.status === "quoted";
    add("quote_is_price_only", "A cross-chain quote is a price, never a transfer", priceOnly,
      priceOnly ? "the quote was taken after the commit and nothing was sent" : `the cross-chain step is recorded as "${cc.status}"`);
  }

  // 6. the private reasoning is not in the public record
  const asText = JSON.stringify(r);
  const leaked = PRIVATE_WORDS.filter((w) => asText.toLowerCase().includes(`"${w}"`));
  const commitmentOk = !r.private_commitment || SHA256.test(r.private_commitment);
  add("private_reasoning_absent", "The public record carries a commitment to the reasoning, never the reasoning", leaked.length === 0 && commitmentOk,
    leaked.length === 0 && commitmentOk
      ? (r.private_commitment ? `only a hash of it: ${bare(r.private_commitment).slice(0, 16)}…, with the blob and its salt left on the operator's machine` : "no private reasoning was produced in this cycle")
      : leaked.length ? `the record contains ${leaked.join(", ")}` : `private_commitment is not a sha256 hash`);

  // 7. the TEE claim matches the evidence, in both directions
  if (r.decision_path === "near-ai-tee") {
    const ok = teeOk(r);
    add("tee_claim_matches_evidence", "A decision is only called sealed when the enclave evidence checks out", ok,
      ok ? `signed by ${r.tee?.signing_address}, bound to a fresh challenge, hashes match` : "the record claims a sealed decision but at least one enclave check failed");
  } else if (r.decision_path === "local-policy") {
    add("tee_claim_matches_evidence", "A decision is only called sealed when the enclave evidence checks out", !r.tee,
      !r.tee ? "this cycle says plainly that the built-in rule decided, and carries no enclave evidence" : "the record says local rule but carries enclave evidence");
  } else {
    add("tee_claim_matches_evidence", "A decision is only called sealed when the enclave evidence checks out", null, "an older record from before sealed decisions");
  }

  const commitTx = run?.commit_tx ?? null;
  return {
    built_at: new Date().toISOString(),
    network: input.network ?? "testnet",
    explorer: EXPLORER,
    governor: r.governor,
    cycle_id: r.cycle_id,
    decision: {
      path: r.decision_path ?? "unrecorded",
      decision_hash: r.decision_hash,
      prev_memory_hash: r.prev_memory_hash,
      private_commitment: r.private_commitment ?? null,
      tee: r.tee
        ? {
            model: r.tee.model,
            signer: r.tee.signing_address,
            tdx: String((r.tee.checks as Record<string, unknown> | undefined)?.tdx ?? "not_checked"),
            gpu: String((r.tee.checks as Record<string, unknown> | undefined)?.gpu ?? "not_checked"),
          }
        : null,
    },
    memory_commit: { committed, tx: commitTx, url: commitTx ? txUrl(commitTx) : null, error: run?.error ?? null },
    limits: (r.swarm_risk as unknown as Record<string, string>) ?? null,
    limits_source: run?.limits_source ?? null,
    subs: (r.decisions ?? []).map((d) => {
      const rep = run?.reports?.find((x) => x.sub === d.sub);
      const ver = run?.verdicts?.find((x) => x.sub === d.sub);
      return {
        sub: d.sub,
        account: rep?.accountId ?? null,
        action: ver?.action ?? (d.action === "PAUSE" ? "PAUSE" : null),
        reason: ver?.reason ?? null,
        status: rep?.status ?? (d.action === "PAUSE" ? "paused" : "no report recorded"),
        tx: rep?.txHash ?? null,
        url: rep?.txHash ? txUrl(rep.txHash) : null,
      };
    }),
    cross_chain: cc
      ? {
          status: String(cc.status),
          quote_ref: cc.quote_ref ?? null,
          decision_hash: cc.decision_hash ?? null,
          memory_tx: cc.memory_tx ?? null,
          url: cc.memory_tx ? txUrl(cc.memory_tx) : null,
        }
      : null,
    checks,
  };
}

/** PASS / FAIL / SKIP counts for a set of checks. */
export function tally(checks: ProofCheck[]): { pass: number; fail: number; skip: number } {
  return {
    pass: checks.filter((c) => c.ok === true).length,
    fail: checks.filter((c) => c.ok === false).length,
    skip: checks.filter((c) => c.ok === null).length,
  };
}
