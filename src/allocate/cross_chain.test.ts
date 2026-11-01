/**
 * Phase 7, cross-chain allocation: the memory gate, the envelope, the allowlist,
 * quote-only behaviour, and the refusal to execute. Fake providers, no network.
 */

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hashDecision } from "../memory.js";
import { base58Encode } from "../nearTx.js";
import { DEFAULT_ENVELOPE } from "../private/decide.js";
import { envelopeToSwarmRisk } from "../limits/index.js";
import type { MemoryRecord, SubDecision } from "../types.js";
import { AllocationGateError, type AllocationContext } from "./index.js";
import {
  CrossChainRefusal, DESTINATIONS, HARD_MAX_UNITS, checkQuote, crossChainEnabled, executeAllocation, fmtUnits,
  loadCrossChainConfig, planCrossChain, quoteAllocation, refundAccount, runCrossChainAllocate, type AllocationExecutor, type CrossChainConfig,
} from "./cross_chain.js";
import { ProviderError, type ProviderQuote, type QuoteProvider } from "./crossChainProviders.js";

const UNIT = 10n ** 19n;
const NOW = 1_800_000_000_000;
const RECIPIENT = "0x" + "ab".repeat(20);
const CFG: CrossChainConfig = { provider: "oneclick", sub: "A", dest: "base:USDC", recipient: RECIPIENT, sender: "mnemosyne-gov.testnet", units: 100, maxUnits: 100, slippageBps: 50 };

const D = (sub: "A" | "B" | "C", action: SubDecision["action"], target = 800): SubDecision =>
  action === "PAUSE"
    ? { sub, action, reason_code: "local_loss_limit" }
    : { sub, action, target_capital: String(target), max_position: String(Math.floor(target * 0.2)), max_loss_cycle: String(Math.floor(target * 0.05)), mandate: sub === "A" ? "mean_reversion_only" : sub === "B" ? "inventory_liquidity_only" : "defensive_reduce_only" };

function record(decisions: SubDecision[]): MemoryRecord {
  const rest = { cycle_id: "2026-11-01T12:00:00.000Z-abcde", governor: "mnemosyne-gov.testnet", prev_memory_hash: null, decisions, swarm_risk: envelopeToSwarmRisk(DEFAULT_ENVELOPE), schema_version: 2 as const };
  return { ...rest, decision_hash: hashDecision(rest) };
}
const ctx = (rec: MemoryRecord, over: Partial<AllocationContext> = {}): AllocationContext => ({
  record: rec, commit: { committed: true, txHash: "MEMTX" }, state: [{ sub: "A", capital: 800, lastCycleLoss: 0 }, { sub: "B", capital: 800, lastCycleLoss: 0 }, { sub: "C", capital: 800, lastCycleLoss: 0 }], source: "onchain", ...over,
});
const GOOD = () => record([D("A", "KEEP"), D("B", "CUT", 700), D("C", "CUT", 700)]);

let asked: unknown[] = [];
const quoteOf = (over: Partial<ProviderQuote> = {}): ProviderQuote => ({ provider: "oneclick", provider_quote_id: "corr-1", router: "near-intents", amount_in: (100n * UNIT).toString(), amount_out: "3100", min_amount_out: "3000", received_at: NOW, expires_at: NOW + 30_000, has_deposit_address: false, ...over });
const provider = (q: Partial<ProviderQuote> | Error = {}): QuoteProvider => ({
  name: "oneclick",
  async quote(plan) { asked.push(plan); if (q instanceof Error) throw q; return quoteOf(q); },
});
const deps = (q: Partial<ProviderQuote> | Error = {}, config: CrossChainConfig = CFG) => ({ config, provider: provider(q), now: () => NOW, unitYocto: UNIT });

beforeEach(() => { asked = []; });

describe("the memory gate", () => {
  it("allocate without memory is rejected: no commit, no quote, the provider is never asked", async () => {
    await assert.rejects(runCrossChainAllocate(ctx(GOOD(), { commit: { committed: false } }), deps()), (e: Error) => e instanceof AllocationGateError && /memory commit missing/.test(e.message));
    assert.equal(asked.length, 0);
  });

  it("rejects a record that no longer matches its own decision_hash", async () => {
    const rec = GOOD();
    rec.decisions[0].target_capital = "900"; // changed after the hash was made
    await assert.rejects(runCrossChainAllocate(ctx(rec), deps()), /does not match its decision_hash/);
    assert.equal(asked.length, 0);
  });

  it("a broken configuration is a refusal entry, and it cannot hide a failed gate", async () => {
    const saved = process.env.CROSS_CHAIN_UNITS;
    process.env.CROSS_CHAIN_UNITS = "0"; // invalid
    try {
      const bad = await runCrossChainAllocate(ctx(GOOD()), { provider: provider(), now: () => NOW, unitYocto: UNIT });
      assert.equal(bad.summary.status, "refused");
      assert.match(bad.summary.reason ?? "", /^configuration: CROSS_CHAIN_UNITS must be a whole number/);
      await assert.rejects(runCrossChainAllocate(ctx(GOOD(), { commit: { committed: false } }), { provider: provider(), now: () => NOW, unitYocto: UNIT }), AllocationGateError);
      assert.equal(asked.length, 0);
    } finally {
      if (saved === undefined) delete process.env.CROSS_CHAIN_UNITS; else process.env.CROSS_CHAIN_UNITS = saved;
    }
  });
});

describe("what the memory record allows", () => {
  it("quotes for a KEEP sub, and the plan carries the decision hash and the memory tx", async () => {
    const rec = GOOD();
    const { plan } = await quoteAllocation(ctx(rec), deps());
    assert.equal(plan.decision_hash, rec.decision_hash);
    assert.equal(plan.memory_tx, "MEMTX");
    assert.equal(plan.sub, "A");
    assert.equal(plan.units, 100);
    assert.equal(plan.amount_in, (100n * UNIT).toString()); // 0.001 wNEAR in yocto
    assert.equal(plan.destination, DESTINATIONS["base:USDC"]);
  });

  it("allows INCREASE too", () => {
    assert.equal(planCrossChain(ctx(record([D("A", "INCREASE", 1000), D("B", "KEEP"), D("C", "KEEP")])), CFG, UNIT).action, "INCREASE");
  });

  it("never for a PAUSE sub, a CUT sub, or the reduce-only sub", () => {
    const rec = record([D("A", "PAUSE"), D("B", "CUT", 700), D("C", "KEEP")]);
    assert.throws(() => planCrossChain(ctx(rec), CFG, UNIT), /PAUSE in the committed record/);
    assert.throws(() => planCrossChain(ctx(rec), { ...CFG, sub: "B" }, UNIT), /is CUT in the committed record/);
    assert.throws(() => planCrossChain(ctx(rec), { ...CFG, sub: "C" }, UNIT), /reduce-only/);
  });

  it("never more than the cap or the sub's committed target", () => {
    assert.throws(() => planCrossChain(ctx(GOOD()), { ...CFG, units: 101 }, UNIT), /over the cross-chain cap of 100 units/);
    assert.equal(planCrossChain(ctx(GOOD()), { ...CFG, units: 600, maxUnits: 1000 }, UNIT).units, 600); // inside target 800 and cap 1000
    assert.throws(() => planCrossChain(ctx(record([D("A", "KEEP", 50), D("B", "KEEP"), D("C", "KEEP")])), CFG, UNIT), /over sub A's committed target_capital of 50/);
    // the hard ceiling in code beats any configured cap
    assert.throws(() => planCrossChain(ctx(record([D("A", "KEEP", 2800), D("B", "KEEP", 100), D("C", "KEEP", 100)])), { ...CFG, units: HARD_MAX_UNITS + 1, maxUnits: 5000 }, UNIT), /cap of 1000 units/);
  });

  it("only an allowlisted destination, with a valid recipient and a sender", () => {
    assert.throws(() => planCrossChain(ctx(GOOD()), { ...CFG, dest: "solana:USDC" }, UNIT), /not allowlisted/);
    assert.throws(() => planCrossChain(ctx(GOOD()), { ...CFG, recipient: null }, UNIT), /CROSS_CHAIN_RECIPIENT is not set/);
    assert.throws(() => planCrossChain(ctx(GOOD()), { ...CFG, recipient: "alice.near" }, UNIT), /not a valid Base address.*"0x" followed by 40 hex characters.*You gave: "alice\.near"/);
    assert.throws(() => planCrossChain(ctx(GOOD()), { ...CFG, sender: "" }, UNIT), /no sender/);
  });
});

describe("quote only, and what a provider's answer must satisfy", () => {
  it("logs the quote with the decision hash and the memory tx, and says nothing was sent", async () => {
    const rec = GOOD();
    const out = await runCrossChainAllocate(ctx(rec), deps());
    assert.equal(out.summary.mode, "quote_only");
    assert.equal(out.summary.status, "quoted");
    assert.equal(out.summary.decision_hash, rec.decision_hash);
    assert.equal(out.summary.memory_tx, "MEMTX");
    assert.equal(out.summary.memory_tx_url, "https://testnet.nearblocks.io/txns/MEMTX");
    assert.equal(out.summary.provider_quote_id, "corr-1");
    assert.match(out.summary.quote_ref ?? "", /^[0-9a-f]{16}$/);
    assert.equal(out.summary.amount_out, "3100");
    assert.match(out.summary.note, /not a fill/);
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].kind, "quote");
    assert.equal(out.entries[0].rail, "cross_chain");
    assert.match(out.entries[0].note, /^CROSS-CHAIN QUOTE via near-intents: 0\.00100 wNEAR -> about 0\.0031 USDC on Base \(at least 0\.003\), quote corr-1; quote only, nothing was sent$/);
    assert.equal(asked.length, 1);
  });

  it("a refusal is an entry, not a crash, and nothing is asked of the provider", async () => {
    const out = await runCrossChainAllocate(ctx(record([D("A", "PAUSE"), D("B", "KEEP"), D("C", "KEEP")])), deps());
    assert.equal(out.summary.status, "refused");
    assert.equal(out.entries[0].kind, "blocked");
    assert.match(out.entries[0].note, /^CROSS-CHAIN blocked: sub A is PAUSE.*\(nothing was sent\)$/);
    assert.equal(asked.length, 0);
  });

  it("a provider outage is reported as unavailable and the cycle goes on", async () => {
    const out = await runCrossChainAllocate(ctx(GOOD()), deps(new ProviderError("1Click answered 503")));
    assert.equal(out.summary.status, "unavailable");
    assert.equal(out.summary.reason, "1Click answered 503");
    assert.match(out.entries[0].note, /quote unavailable: 1Click answered 503 \(nothing was sent\)/);
  });

  it("an unexpected error is not swallowed", async () => {
    await assert.rejects(runCrossChainAllocate(ctx(GOOD()), deps(new TypeError("bug"))), TypeError);
  });

  it("refuses an answer outside the memory envelope", async () => {
    const plan = planCrossChain(ctx(GOOD()), CFG, UNIT);
    const bad: Array<[Partial<ProviderQuote>, RegExp]> = [
      [{ amount_in: (101n * UNIT).toString() }, /outside the memory envelope: it is for 0\.00101 wNEAR but the record allows 0\.00100/],
      [{ amount_in: "0" }, /for nothing/],
      [{ min_amount_out: "0" }, /no usable minimum output/],
      [{ amount_out: "10", min_amount_out: "20" }, /no usable minimum output/],
      [{ has_deposit_address: true }, /deposit address/],
      [{ expires_at: NOW }, /expired/],
    ];
    for (const [over, re] of bad) assert.throws(() => checkQuote(plan, quoteOf(over), NOW), (e: Error) => e instanceof CrossChainRefusal && re.test(e.message), JSON.stringify(over));
    checkQuote(plan, quoteOf(), NOW);
    checkQuote(plan, quoteOf({ amount_in: (50n * UNIT).toString() }), NOW); // less than allowed is fine
    const out = await runCrossChainAllocate(ctx(GOOD()), deps({ amount_in: (500n * UNIT).toString() }));
    assert.equal(out.summary.status, "refused");
    assert.equal(out.summary.quote_ref, null);
  });

  it("the quote ref changes if anything the provider said changes", async () => {
    const a = await quoteAllocation(ctx(GOOD()), deps());
    const b = await quoteAllocation(ctx(GOOD()), deps({ amount_out: "3200" }));
    assert.notEqual(a.quote.quote_ref, b.quote.quote_ref);
  });
});

describe("execution is not wired, and the checks are real", () => {
  const ready = async () => { const c = ctx(GOOD()); const { plan, quote } = await quoteAllocation(c, deps()); return { c, plan, quote }; };
  const exec: AllocationExecutor & { runs: number } = { runs: 0, async execute() { this.runs++; return { status: "submitted", intent_id: "INTENT-1" }; } };
  const eDeps = (over: object = {}) => ({ config: CFG, now: () => NOW, unitYocto: UNIT, ...over });
  beforeEach(() => { exec.runs = 0; });

  it("refuses by default: no executor, nothing sent", async () => {
    const { c, plan, quote } = await ready();
    await assert.rejects(executeAllocation(c, plan, quote, eDeps()), /execution is not wired in this build: quote only/);
  });

  it("with an executor it still re-checks the memory gate, the record, the amount and the clock", async () => {
    const { c, plan, quote } = await ready();
    await assert.rejects(executeAllocation({ ...c, commit: { committed: false } }, plan, quote, eDeps({ executor: exec })), AllocationGateError);
    await assert.rejects(executeAllocation(c, { ...plan, amount_in: (200n * UNIT).toString() }, quote, eDeps({ executor: exec })), /plan no longer matches the committed record \(amount_in\)/);
    await assert.rejects(executeAllocation(c, plan, { ...quote, decision_hash: "sha256:other" }, eDeps({ executor: exec })), /different memory record/);
    await assert.rejects(executeAllocation(c, plan, quote, eDeps({ executor: exec, now: () => NOW + 60_000 })), /expired/);
    await assert.rejects(executeAllocation(c, plan, { ...quote, amount_in: (999n * UNIT).toString() }, eDeps({ executor: exec })), /outside the memory envelope/);
    assert.equal(exec.runs, 0);
  });

  it("runs the executor once and reports only what the executor says", async () => {
    const { c, plan, quote } = await ready();
    const r = await executeAllocation(c, plan, quote, eDeps({ executor: exec }));
    assert.equal(exec.runs, 1);
    assert.deepEqual({ status: r.status, intent_id: r.intent_id, decision_hash: r.decision_hash, memory_tx: r.memory_tx, quote_ref: r.quote_ref }, { status: "submitted", intent_id: "INTENT-1", decision_hash: c.record.decision_hash, memory_tx: "MEMTX", quote_ref: quote.quote_ref });
  });
});

describe("configuration", () => {
  it("is off unless CROSS_CHAIN_ALLOCATE=1, and an odd value is an error, never a guess", () => {
    assert.equal(crossChainEnabled({}), false);
    assert.equal(crossChainEnabled({ CROSS_CHAIN_ALLOCATE: "0" }), false);
    assert.equal(crossChainEnabled({ CROSS_CHAIN_ALLOCATE: "1" }), true);
    assert.throws(() => crossChainEnabled({ CROSS_CHAIN_ALLOCATE: "yes" }), /must be 1 or 0/);
  });

  it("has safe defaults: 1Click without a Rhea key, sub A, Base USDC, 100 units, no recipient", () => {
    const c = loadCrossChainConfig({ GOVERNOR_ACCOUNT_ID: "mnemosyne-gov.testnet" });
    assert.deepEqual(c, { provider: "oneclick", sub: "A", dest: "base:USDC", recipient: null, sender: "mnemosyne-gov.testnet", units: 100, maxUnits: 100, slippageBps: 50 });
    assert.equal(loadCrossChainConfig({ RHEA_API_KEY: "k" }).provider, "rhea");
    assert.equal(loadCrossChainConfig({ RHEA_API_KEY: "k", CROSS_CHAIN_PROVIDER: "oneclick" }).provider, "oneclick");
  });

  it("names the governor key's own mainnet-style account as the refund label (1Click refuses a .testnet name)", () => {
    const seed = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(seed);
    const key = "ed25519:" + base58Encode(Uint8Array.from([...seed, ...pub]));
    const implicit = Buffer.from(pub).toString("hex");
    const env = { GOVERNOR_ACCOUNT_ID: "mnemosyne-gov.testnet", GOVERNOR_PRIVATE_KEY: key };
    assert.equal(refundAccount(env), implicit);
    assert.equal(loadCrossChainConfig(env).sender, implicit);
    assert.match(implicit, /^[0-9a-f]{64}$/);
  });

  it("CROSS_CHAIN_SENDER overrides it, and an unusable key falls back to the account name", () => {
    assert.equal(refundAccount({ CROSS_CHAIN_SENDER: "me.near", GOVERNOR_PRIVATE_KEY: "ed25519:abc", GOVERNOR_ACCOUNT_ID: "g.testnet" }), "me.near");
    assert.equal(refundAccount({ GOVERNOR_PRIVATE_KEY: "not-a-key", GOVERNOR_ACCOUNT_ID: "g.testnet" }), "g.testnet");
    assert.equal(refundAccount({}), "");
  });

  it("rejects anything out of range or unknown", () => {
    for (const env of [{ CROSS_CHAIN_UNITS: "0" }, { CROSS_CHAIN_UNITS: "1001" }, { CROSS_CHAIN_UNITS: "1.5" }, { CROSS_CHAIN_MAX_UNITS: "5000" }, { CROSS_CHAIN_SLIPPAGE_BPS: "500" }, { CROSS_CHAIN_SUB: "Z" }, { CROSS_CHAIN_PROVIDER: "uniswap" }]) {
      assert.throws(() => loadCrossChainConfig(env), /CROSS_CHAIN|must be a whole number/, JSON.stringify(env));
    }
  });

  it("formats base units for the log", () => {
    assert.equal(fmtUnits("3100", 6), "0.0031");
    assert.equal(fmtUnits("1000000", 6), "1");
    assert.equal(fmtUnits("12345678", 6), "12.345678");
  });
});
