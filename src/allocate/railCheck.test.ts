/** Rail check: the same gate and memo as a cycle, against injected fakes (no network, no keys). */

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashDecision } from "../memory.js";
import { DEFAULT_ENVELOPE } from "../private/decide.js";
import { envelopeToSwarmRisk } from "../limits/index.js";
import type { MemoryRecord, SubDecision } from "../types.js";
import { AllocationGateError } from "./index.js";
import { RailCheckError, runRailCheck, type RailCheckDeps } from "./railCheck.js";

const UNIT = 10n ** 19n;
const dec = (sub: "A" | "B" | "C", target: number): SubDecision => ({ sub, action: "KEEP", target_capital: String(target), max_position: String(target / 5), max_loss_cycle: String(target / 20), mandate: sub === "A" ? "mean_reversion_only" : sub === "B" ? "inventory_liquidity_only" : "defensive_reduce_only" });

function record(cycle: string, targets = [800, 800, 800]): MemoryRecord {
  const rest = { cycle_id: cycle, governor: "mnemosyne-gov.testnet", prev_memory_hash: null, decisions: [dec("A", targets[0]), dec("B", targets[1]), dec("C", targets[2])], swarm_risk: envelopeToSwarmRisk(DEFAULT_ENVELOPE), schema_version: 2 as const };
  return { ...rest, decision_hash: hashDecision(rest) };
}

let sent: Array<{ to: string; yocto: bigint; memo: string }> = [];
let balances: Record<string, bigint> = {};
const GOV = "mnemosyne-gov.testnet";

const newest = record("2026-11-01T09:00:00.000Z-new");
const older = record("2026-11-01T08:00:00.000Z-old", [700, 700, 700]);

const deps = (over: Partial<RailCheckDeps> = {}): RailCheckDeps => ({
  unitYocto: UNIT,
  governorId: GOV,
  head: async () => ({ latest_hash: newest.decision_hash, commit_count: 2 }),
  localRecords: () => [newest, older],
  balanceOf: async (id) => balances[id] ?? 0n,
  isRegistered: async () => true,
  transfer: async (to, yocto, memo) => {
    sent.push({ to, yocto, memo });
    balances[to] = (balances[to] ?? 0n) + yocto;
    balances[GOV] -= yocto;
    return { tx: "TXHASH", logs: [`EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{"memo":"${memo}"}]}`] };
  },
  ...over,
});

beforeEach(() => {
  sent = [];
  balances = { [GOV]: 1000n * UNIT, "mnemosyne-sub-a.testnet": 800n * UNIT, "mnemosyne-sub-b.testnet": 800n * UNIT };
});

describe("rail check", () => {
  it("sends the units with the newest commit's hash prefix as the memo, and reads the balance before and after", async () => {
    const r = await runRailCheck({ sub: "A", units: 3 }, deps());
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { to: "mnemosyne-sub-a.testnet", yocto: 3n * UNIT, memo: `mnemosyne ${newest.decision_hash.slice(7, 19)}` });
    assert.equal(r.decision_hash, newest.decision_hash);
    assert.equal(r.cycle_id, newest.cycle_id);
    assert.equal(r.tx, "TXHASH");
    assert.equal(r.wnear, "0.00003");
    assert.equal(r.before_units, 800);
    assert.equal(r.after_units, 803);
    assert.equal(r.memo_in_logs, true);
  });

  it("says so, and still succeeds, when the token does not echo the memo in its log", async () => {
    const r = await runRailCheck({ sub: "b", units: 1 }, deps({ transfer: async (to, y, memo) => { sent.push({ to, yocto: y, memo }); return { tx: "T2" }; } }));
    assert.equal(r.sub, "B");
    assert.equal(r.memo_in_logs, false);
  });

  it("refuses when the chain holds no memory commit, and moves nothing", async () => {
    await assert.rejects(runRailCheck({ sub: "A", units: 1 }, deps({ head: async () => ({ latest_hash: null, commit_count: 0 }) })), /no memory commit/);
    assert.equal(sent.length, 0);
  });

  it("refuses when the newest on-chain commit has no record here (only an older one does)", async () => {
    await assert.rejects(runRailCheck({ sub: "A", units: 1 }, deps({ localRecords: () => [older] })), (e: Error) => e instanceof RailCheckError && /no record on this machine/.test(e.message));
    assert.equal(sent.length, 0);
  });

  it("refuses a local record that no longer matches its own hash", async () => {
    const tampered = structuredClone(newest);
    tampered.decisions[0].target_capital = "2900"; // changed after the hash was made
    await assert.rejects(runRailCheck({ sub: "A", units: 1 }, deps({ localRecords: () => [tampered] })), (e: Error) => e instanceof AllocationGateError && /does not match its decision_hash/.test(e.message));
    assert.equal(sent.length, 0);
  });

  it("never tops up the reduce-only sub, an unknown sub, or an out-of-range amount", async () => {
    await assert.rejects(runRailCheck({ sub: "C", units: 1 }, deps()), /reduce-only/);
    await assert.rejects(runRailCheck({ sub: "Z", units: 1 }, deps()), /unknown sub/);
    for (const units of [0, -1, 1.5, 101, NaN]) await assert.rejects(runRailCheck({ sub: "A", units }, deps()), /whole number from 1 to 100/, String(units));
    assert.equal(sent.length, 0);
  });

  it("blocks, with the fix, when the governor is short or the sub is not registered", async () => {
    balances[GOV] = 2n * UNIT;
    await assert.rejects(runRailCheck({ sub: "A", units: 5 }, deps()), /governor holds .* needs .*swarm:setup/);
    balances[GOV] = 1000n * UNIT;
    await assert.rejects(runRailCheck({ sub: "A", units: 5 }, deps({ isRegistered: async () => false })), /not registered.*swarm:setup/);
    assert.equal(sent.length, 0);
  });
});
