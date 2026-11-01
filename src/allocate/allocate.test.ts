/**
 * ALLOCATE: the memory gate, the rules every rail must follow, and the real
 * wNEAR rail against injected fakes (no network, no keys).
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { hashDecision } from "../memory.js";
import { DEFAULT_ENVELOPE } from "../private/decide.js";
import { envelopeToSwarmRisk } from "../limits/index.js";
import type { FakeSubState } from "../subAgents.js";
import type { MemoryRecord, SubDecision } from "../types.js";
import { AllocationGateError, assertMemoryGate, runAllocate, type AllocateDeps } from "./index.js";
import { ftBalance, readSwarm, yoctoToUnits } from "../swarmState.js";

const UNIT = 10n ** 19n;
const D = (sub: "A" | "B" | "C", action: SubDecision["action"], target: number): SubDecision =>
  action === "PAUSE"
    ? { sub, action, reason_code: "local_loss_limit" }
    : { sub, action, target_capital: String(target), max_position: String(Math.floor(target * 0.2)), max_loss_cycle: String(Math.floor(target * 0.05)), mandate: sub === "A" ? "mean_reversion_only" : sub === "B" ? "inventory_liquidity_only" : "defensive_reduce_only" };

function record(decisions: SubDecision[], risk = envelopeToSwarmRisk(DEFAULT_ENVELOPE)): MemoryRecord {
  const rest = { cycle_id: "2026-11-01T10:00:00.000Z-abcde", governor: "mnemosyne-gov.testnet", prev_memory_hash: null, decisions, swarm_risk: risk, schema_version: 2 as const };
  return { ...rest, decision_hash: hashDecision(rest) };
}
const state = (a = 1000, b = 1000, c = 1000): FakeSubState[] => [{ sub: "A", capital: a, lastCycleLoss: 0 }, { sub: "B", capital: b, lastCycleLoss: 0 }, { sub: "C", capital: c, lastCycleLoss: 0 }];
const ctx = (rec: MemoryRecord, over: Partial<Parameters<typeof runAllocate>[0]> = {}) => ({ record: rec, commit: { committed: true, txHash: "x" }, state: state(), source: "onchain" as const, ...over });

let calls: Array<{ to: string; yocto: bigint; memo: string }> = [];
const deps = (over: Partial<AllocateDeps> = {}): AllocateDeps => ({
  unitYocto: UNIT,
  governorBalance: async () => 10n ** 23n,
  isRegistered: async () => true,
  transfer: async (to, yocto, memo) => { calls.push({ to, yocto, memo }); return { tx: "TX" + calls.length }; },
  ...over,
});

const saved = { mode: process.env.ALLOCATE_MODE };
beforeEach(() => { calls = []; process.env.ALLOCATE_MODE = "wnear"; });
afterEach(() => { if (saved.mode === undefined) delete process.env.ALLOCATE_MODE; else process.env.ALLOCATE_MODE = saved.mode; });

describe("the memory gate", () => {
  it("rejects an allocation when the memory commit is missing, and moves nothing", async () => {
    const rec = record([D("A", "INCREASE", 1250), D("B", "KEEP", 1000), D("C", "PAUSE", 0)]);
    await assert.rejects(runAllocate(ctx(rec, { commit: { committed: false } }), deps()), (e: Error) => e instanceof AllocationGateError && /memory commit missing/.test(e.message));
    assert.equal(calls.length, 0);
  });

  it("rejects a record that no longer matches its own decision_hash", async () => {
    const rec = record([D("A", "INCREASE", 1250), D("B", "KEEP", 1000), D("C", "PAUSE", 0)]);
    rec.decisions[0].target_capital = "1500"; // changed after the hash was made
    await assert.rejects(runAllocate(ctx(rec), deps()), /does not match its decision_hash/);
    assert.equal(calls.length, 0);
  });

  it("rejects a record whose targets exceed its own max_total_exposure", () => {
    const rec = record([D("A", "INCREASE", 1250), D("B", "KEEP", 1000), D("C", "PAUSE", 0)], { ...envelopeToSwarmRisk(DEFAULT_ENVELOPE), max_total_exposure: "500" });
    assert.throws(() => assertMemoryGate(ctx(rec)), /exceed its own max_total_exposure/);
  });
});

describe("print mode (the default)", () => {
  it("moves nothing and says so, with the same directive text as before", async () => {
    delete process.env.ALLOCATE_MODE;
    const rec = record([D("A", "INCREASE", 1250), D("B", "KEEP", 1000), D("C", "PAUSE", 0)]);
    const out = await runAllocate(ctx(rec), deps());
    assert.equal(out.mode, "print");
    assert.equal(calls.length, 0);
    assert.ok(out.entries.every((e) => e.kind === "none"));
    assert.match(out.entries[0].note, /INCREASE -> target_capital=1250, max_position=250, max_loss_cycle=62, mandate=mean_reversion_only/);
  });

  it("an unknown ALLOCATE_MODE is an error, never a guess", async () => {
    process.env.ALLOCATE_MODE = "yolo";
    await assert.rejects(runAllocate(ctx(record([D("A", "KEEP", 1000), D("B", "KEEP", 1000), D("C", "PAUSE", 0)])), deps()), /unknown ALLOCATE_MODE/);
  });
});

describe("real wNEAR rail", () => {
  it("tops up only the INCREASE sub, by exactly the gap to its committed target", async () => {
    const rec = record([D("A", "INCREASE", 1250), D("B", "KEEP", 1000), D("C", "PAUSE", 0)]);
    const out = await runAllocate(ctx(rec), deps());
    assert.equal(out.mode, "wnear");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, "mnemosyne-sub-a.testnet");
    assert.equal(calls[0].yocto, 250n * UNIT);
    // the memo ties the transfer to the memory commit that allowed it
    assert.ok(calls[0].memo.includes(rec.decision_hash.replace("sha256:", "").slice(0, 12)));
    assert.deepEqual(out.entries.map((e) => e.kind), ["transfer", "none", "none"]);
    assert.equal(out.entries[0].tx, "TX1");
    assert.equal(out.entries[0].units, 250);
  });

  it("never moves more than the per-cycle cap", async () => {
    const rec = record([D("A", "INCREASE", 1250), D("B", "INCREASE", 1250), D("C", "PAUSE", 0)]);
    const out = await runAllocate(ctx(rec), deps({ maxUnits: 300 }));
    assert.deepEqual(calls.map((c) => c.yocto), [250n * UNIT, 50n * UNIT]);
    assert.match(out.entries[1].note, /capped from \+250/);
  });

  it("a zero cap blocks everything", async () => {
    const rec = record([D("A", "INCREASE", 1250), D("B", "KEEP", 1000), D("C", "PAUSE", 0)]);
    const out = await runAllocate(ctx(rec), deps({ maxUnits: 0 }));
    assert.equal(calls.length, 0);
    assert.equal(out.entries[0].kind, "blocked");
  });

  it("CUT moves nothing and says where the extra stays", async () => {
    const rec = record([D("A", "KEEP", 1000), D("B", "CUT", 800), D("C", "PAUSE", 0)]);
    const out = await runAllocate(ctx(rec), deps());
    assert.equal(calls.length, 0);
    assert.match(out.entries[1].note, /200 units above the new ceiling stay in the sub account/);
  });

  it("the reduce-only sub is never topped up", async () => {
    const rec = record([D("A", "KEEP", 900), D("B", "KEEP", 900), D("C", "INCREASE", 1100)]);
    const out = await runAllocate(ctx(rec), deps());
    assert.equal(calls.length, 0);
    assert.equal(out.entries[2].kind, "blocked");
  });

  it("blocks, with the fix, when the governor is short or the sub is not registered", async () => {
    const rec = record([D("A", "INCREASE", 1250), D("B", "KEEP", 1000), D("C", "PAUSE", 0)]);
    let out = await runAllocate(ctx(rec), deps({ governorBalance: async () => 10n * UNIT }));
    assert.equal(out.entries[0].kind, "blocked");
    assert.match(out.entries[0].note, /npm run swarm:setup/);
    out = await runAllocate(ctx(rec), deps({ isRegistered: async () => false }));
    assert.equal(out.entries[0].kind, "blocked");
    assert.match(out.entries[0].note, /not registered/);
    assert.equal(calls.length, 0);
  });

  it("a failed transfer is reported for that sub and does not stop the others", async () => {
    const rec = record([D("A", "INCREASE", 1250), D("B", "INCREASE", 1250), D("C", "PAUSE", 0)]);
    let n = 0;
    const out = await runAllocate(ctx(rec), deps({ transfer: async (to, yocto, memo) => { if (++n === 1) throw new Error("rpc down"); calls.push({ to, yocto, memo }); return { tx: "OK" }; } }));
    assert.equal(out.entries[0].kind, "failed");
    assert.match(out.entries[0].note, /rpc down/);
    assert.equal(out.entries[1].kind, "transfer");
  });

  it("falls back to print, loudly, when the swarm numbers are simulated", async () => {
    const rec = record([D("A", "INCREASE", 1250), D("B", "KEEP", 1000), D("C", "PAUSE", 0)]);
    const out = await runAllocate(ctx(rec, { source: "simulated" }), deps());
    assert.equal(out.mode, "print");
    assert.equal(calls.length, 0);
    assert.match(out.entries[0].note, /needs SWARM_STATE=onchain/);
  });
});

describe("swarm state", () => {
  const keep = { state: process.env.SWARM_STATE, scen: process.env.SWARM_SCENARIO, rpc: process.env.NEAR_RPC_URL };
  afterEach(() => {
    for (const [k, v] of [["SWARM_STATE", keep.state], ["SWARM_SCENARIO", keep.scen], ["NEAR_RPC_URL", keep.rpc]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it("simulated by default", async () => {
    delete process.env.SWARM_STATE;
    const s = await readSwarm();
    assert.equal(s.source, "simulated");
    assert.equal(s.balances, null);
  });

  it("on-chain: capital is the real balance in units; losses stay the labelled scenario", async () => {
    process.env.SWARM_STATE = "onchain";
    process.env.SWARM_SCENARIO = "stressed";
    const bal: Record<string, bigint> = { "mnemosyne-sub-a.testnet": 1234n * UNIT + 5n, "mnemosyne-sub-b.testnet": 0n, "mnemosyne-sub-c2.testnet": 900n * UNIT };
    const s = await readSwarm({ balanceOf: async (id) => bal[id] });
    assert.deepEqual(s.state.map((x) => x.capital), [1234, 0, 900]);
    assert.deepEqual(s.state.map((x) => x.lastCycleLoss), [10, 60, 120]);
    assert.equal(s.balances!.A.yocto, String(1234n * UNIT + 5n));
  });

  it("on-chain: an unreadable balance stops the cycle, it never falls back to simulated numbers", async () => {
    process.env.SWARM_STATE = "onchain";
    await assert.rejects(readSwarm({ balanceOf: async (id) => { if (id.includes("sub-b")) throw new Error("rpc down"); return UNIT; } }), /could not read the real balance of mnemosyne-sub-b.testnet: rpc down/);
  });

  it("an unknown SWARM_STATE is an error", async () => {
    process.env.SWARM_STATE = "maybe";
    await assert.rejects(readSwarm(), /unknown SWARM_STATE/);
  });

  it("ftBalance reads ft_balance_of through the NEAR RPC", async () => {
    let asked: any;
    const rpc = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      asked = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: asked.id, result: { result: [...Buffer.from('"12300000000000000000000"')], logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" } }));
    });
    await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", () => r()));
    try {
      process.env.NEAR_RPC_URL = `http://127.0.0.1:${(rpc.address() as any).port}`;
      const y = await ftBalance("mnemosyne-sub-a.testnet", "wrap.testnet");
      assert.equal(y, 12300000000000000000000n);
      assert.equal(yoctoToUnits(y, UNIT), 1230);
      assert.equal(asked.params.method_name, "ft_balance_of");
      assert.equal(asked.params.account_id, "wrap.testnet");
      assert.deepEqual(JSON.parse(Buffer.from(asked.params.args_base64, "base64").toString()), { account_id: "mnemosyne-sub-a.testnet" });
    } finally {
      rpc.close();
    }
  });
});
