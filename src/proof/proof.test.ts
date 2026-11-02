/** The proof pack: every claim it makes must be falsifiable, and must
 *  actually fail when the thing it claims stops being true. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashDecision } from "../memory.js";
import { buildPack, reHashRecord, cycleTag, tally } from "./pack.js";
import { renderProofs } from "./proofs.js";
import type { MemoryRecord } from "../types.js";
import type { CycleRun } from "../cycle.js";

/** A record built the way cycle.ts builds one: hash last, over everything else. */
function record(over: Partial<MemoryRecord> = {}): MemoryRecord {
  const base = {
    cycle_id: "2026-11-02T10:00:00.000Z-aaaaa",
    governor: "mnemosyne-gov.testnet",
    prev_memory_hash: "sha256:" + "11".repeat(32),
    decisions: [
      { sub: "A", action: "KEEP", target_capital: "1000", max_position: "200", max_loss_cycle: "50", mandate: "mean_reversion_only" },
      { sub: "C", action: "PAUSE", reason_code: "local_loss_limit" },
    ],
    swarm_risk: { max_total_exposure: "3000", max_daily_loss: "150" },
    schema_version: 2 as const,
    decision_path: "near-ai-tee" as const,
    private_commitment: "sha256:" + "22".repeat(32),
    tee: {
      provider: "near-ai-cloud", model: "Qwen/Qwen3.8-27B", chat_id: "c", signing_address: "0xabc",
      signature_kind: "provider_tee", signature: "0x1", request_hash: "a", response_hash: "b",
      checks: { hashes_match: true, signature_valid: true, provider_tee: true, model_matches: true, binds_address: true, binds_nonce: true, tdx: "not_checked", gpu: "not_checked" },
    },
    ...over,
  } as Omit<MemoryRecord, "decision_hash">;
  return { ...base, decision_hash: hashDecision(base) } as MemoryRecord;
}

const run = (over: Partial<CycleRun> = {}): CycleRun => ({
  cycle_id: "2026-11-02T10:00:00.000Z-aaaaa",
  finished_at: "2026-11-02T10:02:00.000Z",
  committed: true,
  commit_tx: "CommitTxHash111",
  error: null,
  verdicts: [{ sub: "A", action: "ACT", reason: "within mandate mean_reversion_only" }],
  reports: [{ sub: "A", status: "reported", action: "ACT", accountId: "mnemosyne-sub-a.testnet", txHash: "ReportTxA" }],
  ...over,
});

const find = (p: ReturnType<typeof buildPack>, id: string) => {
  const c = p.checks.find((x) => x.id === id);
  assert.ok(c, `no check with id ${id}`);
  return c!;
};

describe("the published record is the thing that was committed", () => {
  it("re-hashing the record without decision_hash reproduces the committed hash", () => {
    const r = record();
    assert.equal(reHashRecord(r), r.decision_hash);
    assert.equal(find(buildPack({ record: r, run: run() }), "record_hashes_to_commitment").ok, true);
  });

  it("changing one byte of the record breaks it", () => {
    for (const tamper of [
      { swarm_risk: { max_total_exposure: "3001", max_daily_loss: "150" } },
      { decisions: [{ sub: "A", action: "KEEP", target_capital: "9999", max_position: "200", max_loss_cycle: "50", mandate: "mean_reversion_only" }] },
      { private_commitment: "sha256:" + "33".repeat(32) },
    ] as Array<Partial<MemoryRecord>>) {
      const r = record();
      const bad = { ...r, ...tamper } as MemoryRecord;   // keeps the original hash: a lie
      assert.notEqual(reHashRecord(bad), bad.decision_hash);
      assert.equal(find(buildPack({ record: bad, run: run() }), "record_hashes_to_commitment").ok, false, JSON.stringify(tamper).slice(0, 40));
    }
  });
});

describe("the chain of records", () => {
  it("passes when this record names the previous one, fails when it does not", () => {
    const first = record({ prev_memory_hash: null });
    const second = record({ cycle_id: "2026-11-02T11:00:00.000Z-bbbbb", prev_memory_hash: first.decision_hash });
    assert.equal(find(buildPack({ record: second, run: run(), prevRecord: first }), "chain_links_to_previous").ok, true);
    const other = record({ cycle_id: "2026-11-02T09:00:00.000Z-ccccc", prev_memory_hash: null, governor: "someone-else.testnet" });
    assert.equal(find(buildPack({ record: second, run: run(), prevRecord: other }), "chain_links_to_previous").ok, false);
  });

  it("says plainly when there is nothing before it, or the previous record is not in this copy", () => {
    assert.equal(find(buildPack({ record: record({ prev_memory_hash: null }), run: run() }), "chain_links_to_previous").ok, null);
    assert.equal(find(buildPack({ record: record(), run: run(), prevRecord: null }), "chain_links_to_previous").ok, null);
  });
});

describe("fail-closed", () => {
  it("passes when a failed commit stopped everything", () => {
    const c = find(buildPack({ record: record(), run: run({ committed: false, commit_tx: null, error: "rpc timeout", reports: [], verdicts: [] }) }), "no_move_without_commit");
    assert.equal(c.ok, true);
    assert.match(c.detail, /nothing moved, no sub reported/);
  });

  it("fails when something moved even though the commit failed", () => {
    const bad = run({
      committed: false, commit_tx: null, error: "rpc timeout",
      allocations: [{ sub: "A", kind: "transfer", note: "topped up", tx: "MovedAnyway" } as never],
      reports: [],
    });
    assert.equal(find(buildPack({ record: record(), run: bad }), "no_move_without_commit").ok, false);
  });
});

describe("reports are tied to the decision they answer", () => {
  it("the tag is the first 12 characters of the decision hash", () => {
    const r = record();
    assert.equal(cycleTag(r.decision_hash), `cycle ${r.decision_hash.replace("sha256:", "").slice(0, 12)}`);
    assert.equal(find(buildPack({ record: r, run: run() }), "reports_name_the_decision").ok, true);
  });

  it("is not applicable when no sub reported", () => {
    assert.equal(find(buildPack({ record: record(), run: run({ reports: [] }) }), "reports_name_the_decision").ok, null);
  });
});

describe("the cross-chain quote", () => {
  const quote = (over: Record<string, unknown> = {}) =>
    run({ cross_chain: { status: "quoted", quote_ref: "abcdef0123456789", decision_hash: record().decision_hash, memory_tx: "MemTx", ...over } as never });

  it("passes when the quote is bound to this decision and nothing was sent", () => {
    const p = buildPack({ record: record(), run: quote() });
    assert.equal(find(p, "quote_bound_to_decision").ok, true);
    assert.equal(find(p, "quote_is_price_only").ok, true);
    assert.equal(p.cross_chain?.quote_ref, "abcdef0123456789");
  });

  it("fails when the quote names another decision, or when something was sent", () => {
    assert.equal(find(buildPack({ record: record(), run: quote({ decision_hash: "sha256:" + "99".repeat(32) }) }), "quote_bound_to_decision").ok, false);
    assert.equal(find(buildPack({ record: record(), run: quote({ status: "submitted" }) }), "quote_is_price_only").ok, false);
  });
});

describe("the private reasoning stays out of the public record", () => {
  it("passes when only a commitment hash is published", () => {
    assert.equal(find(buildPack({ record: record(), run: run() }), "private_reasoning_absent").ok, true);
  });

  it("fails if prose from the private side ever appears in the record", () => {
    const leaky = { ...record(), reasoning: "cut B because the book is heavy" } as unknown as MemoryRecord;
    assert.equal(find(buildPack({ record: leaky, run: run() }), "private_reasoning_absent").ok, false);
  });

  it("fails if the commitment is not a hash", () => {
    const bad = { ...record(), private_commitment: "the full reasoning text" } as MemoryRecord;
    assert.equal(find(buildPack({ record: bad, run: run() }), "private_reasoning_absent").ok, false);
  });
});

describe("a sealed decision is never overclaimed", () => {
  it("fails when the record claims a TEE but an enclave check did not pass", () => {
    const r = record();
    const bad = { ...r, tee: { ...r.tee!, checks: { ...(r.tee!.checks as object), signature_valid: false } } } as MemoryRecord;
    assert.equal(find(buildPack({ record: bad, run: run() }), "tee_claim_matches_evidence").ok, false);
  });

  it("passes when the built-in rule decided and the record says so, with no evidence attached", () => {
    const local = record({ decision_path: "local-policy", tee: null, private_commitment: undefined });
    assert.equal(find(buildPack({ record: local, run: run() }), "tee_claim_matches_evidence").ok, true);
  });

  it("fails when the record says local rule but carries enclave evidence", () => {
    const r = record();
    const muddled = { ...r, decision_path: "local-policy" } as MemoryRecord;
    assert.equal(find(buildPack({ record: muddled, run: run() }), "tee_claim_matches_evidence").ok, false);
  });
});

describe("PROOFS.md is written from the records", () => {
  it("carries the newest cycle, its transactions and the re-hash recipe", () => {
    const p = buildPack({ record: record(), run: run() });
    const md = renderProofs([p], { live: false, command: "npm run prove -- --write" });
    assert.match(md, /# Mnemosyne — proofs/);
    assert.match(md, /CommitTxHash111/);
    assert.match(md, /ReportTxA/);
    assert.match(md, /get_latest/);
    assert.match(md, /Quotes are not fills/);
    assert.match(md, /Users are buyers, not governors/);
  });

  it("says so, in the file, when a claim stops holding", () => {
    const bad = { ...record(), swarm_risk: { max_total_exposure: "4000", max_daily_loss: "150" } } as MemoryRecord;
    const p = buildPack({ record: bad, run: run() });
    assert.equal(tally(p.checks).fail, 1);
    const md = renderProofs([p], { live: false, command: "npm run prove" });
    assert.match(md, /## Failing checks/);
    assert.match(md, /\*\*NO\*\*/);
  });

  it("does not invent anything when there are no cycles at all", () => {
    assert.match(renderProofs([], { live: false, command: "npm run prove" }), /No cycles have been recorded yet/);
  });
});

describe("what may be committed to the repository", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const ignored = (p: string): boolean | null => {
    try {
      execFileSync("git", ["check-ignore", "-q", p], { cwd: ROOT, stdio: "ignore" });
      return true;
    } catch (err) {
      const code = (err as { status?: number }).status;
      if (code === 1) return false;          // git ran and the path is not ignored
      return null;                            // no git here: nothing to say
    }
  };

  it("keeps the private reasoning, accounts, sessions and receipts out", () => {
    for (const p of ["data/runtime/private/anything.json", "data/runtime/users.json", "data/runtime/sessions.json", "data/runtime/receipts.json"]) {
      const v = ignored(p);
      if (v === null) return;                 // git unavailable
      assert.equal(v, true, `${p} must never be committed`);
    }
  });

  it("lets the public records and proof packs in, because the repository is the evidence", () => {
    for (const p of ["data/runtime/public/some-cycle.json", "data/runtime/proofs/latest.json"]) {
      const v = ignored(p);
      if (v === null) return;
      assert.equal(v, false, `${p} is the evidence and should be committable`);
    }
  });
});
