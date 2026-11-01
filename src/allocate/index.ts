/**
 * Step 4 of a cycle: ALLOCATE. It only ever runs after the memory commit.
 *
 *   ALLOCATE_MODE=print   (default) log what would happen. No transfers. Offline-safe.
 *   ALLOCATE_MODE=wnear   the governor tops up a sub that was told to INCREASE with a
 *                         real, tiny wNEAR transfer on NEAR testnet.
 *
 * Rules that hold for every rail, now and for any rail added later (e.g. the
 * Phase 7 cross-chain rail):
 *
 *   1. assertMemoryGate(): no committed memory record, or a record that does
 *      not match its own decision_hash, means no allocation at all.
 *   2. An allocation can never exceed what the committed record says: a sub's
 *      target_capital, and the swarm's max_total_exposure.
 *   3. Money only moves one way. The governor tops subs up. It cannot pull
 *      funds back, because the sub keys are report-only on purpose. A CUT
 *      lowers the sub's ceiling; the extra stays in the sub account and is
 *      reported as such, never hidden.
 *   4. Every transfer carries the decision hash prefix in its memo, so the
 *      transfer on NEAR can be matched to the memory commit that allowed it.
 *
 * Allocation problems never crash the cycle. They are logged per sub and the
 * sub-agent window still runs.
 */

import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas } from "near-api-js";
import "dotenv/config";
import { hashDecision } from "../memory.js";
import { txFailure, txHashOf, txLogs } from "../nearTx.js";
import { capitalUnitYocto, fmtWnear, ftBalance, rpcUrl, swarmAsset, unitsToYocto, type SwarmSource } from "../swarmState.js";
import type { FakeSubState } from "../subAgents.js";
import { SUB_AGENTS, subAccountId } from "../subAgents.js";
import type { MemoryRecord, SubAction, SubId } from "../types.js";

export type AllocateMode = "print" | "wnear";

export function allocateMode(): AllocateMode {
  const v = (process.env.ALLOCATE_MODE ?? "print").trim().toLowerCase();
  if (v === "" || v === "print") return "print";
  if (v === "wnear") return "wnear";
  throw new Error(`unknown ALLOCATE_MODE "${v}" (print | wnear)`);
}

/** Hard cap on what one cycle may move, in capital units (default 1000 = 0.01 wNEAR). */
export function maxUnitsPerCycle(): number {
  const raw = process.env.ALLOCATE_MAX_UNITS;
  if (!raw || !raw.trim()) return 1000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error("ALLOCATE_MAX_UNITS must be a whole number of units, 0 or more");
  return n;
}

export interface AllocationContext {
  record: MemoryRecord;
  commit: { committed: boolean; txHash?: string };
  /** what READ saw: capital per sub, in units */
  state: FakeSubState[];
  source: SwarmSource;
}

export interface AllocationEntry {
  sub: SubId;
  action: SubAction;
  rail: AllocateMode;
  kind: "transfer" | "none" | "blocked" | "failed";
  units: number;
  /** wNEAR moved, for display ("0.00250"); only on a real transfer */
  wnear?: string;
  tx?: string;
  note: string;
}

export class AllocationGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationGateError";
  }
}

/** Active (non-PAUSE) targets of a record, in units. */
export function memoryTargets(record: MemoryRecord): Map<SubId, number> {
  const m = new Map<SubId, number>();
  for (const d of record.decisions) if (d.action !== "PAUSE") m.set(d.sub, Number(d.target_capital ?? 0));
  return m;
}

/**
 * No allocation without memory. Throws AllocationGateError unless the record
 * was committed, matches its own hash, and is inside its own exposure limit.
 */
export function assertMemoryGate(ctx: AllocationContext): void {
  if (!ctx.commit.committed) throw new AllocationGateError("memory commit missing: no allocation without memory");
  const { decision_hash, ...rest } = ctx.record;
  if (!decision_hash || hashDecision(rest) !== decision_hash) {
    throw new AllocationGateError("record does not match its decision_hash: no allocation");
  }
  const cap = Number(ctx.record.swarm_risk.max_total_exposure);
  let total = 0;
  for (const t of memoryTargets(ctx.record).values()) {
    if (!Number.isFinite(t) || t < 0) throw new AllocationGateError("record has an invalid target_capital: no allocation");
    total += t;
  }
  if (Number.isFinite(cap) && total > cap) {
    throw new AllocationGateError(`record targets ${total} exceed its own max_total_exposure ${cap}: no allocation`);
  }
}

/** Same wording the print-only log used before real transfers existed. */
function describe(d: MemoryRecord["decisions"][number]): string {
  return d.action === "PAUSE"
    ? `PAUSE (${d.reason_code})`
    : `${d.action} -> target_capital=${d.target_capital}, max_position=${d.max_position}, max_loss_cycle=${d.max_loss_cycle}, mandate=${d.mandate}`;
}

interface Planned { entry: AllocationEntry; account?: string; requestUnits: number }

/** Decide, per sub, what the committed record allows. Pure: no network. */
export function planAllocation(ctx: AllocationContext, mode: AllocateMode, budgetUnits: number): Planned[] {
  let budget = budgetUnits;
  return ctx.record.decisions.map((d): Planned => {
    const base = { sub: d.sub, action: d.action, rail: mode, units: 0 } as const;
    if (mode === "print") return { entry: { ...base, kind: "none", note: `${describe(d)} (print-only, nothing moved)` }, requestUnits: 0 };
    if (d.action === "PAUSE") return { entry: { ...base, kind: "none", note: `PAUSE (${d.reason_code}): nothing to move` }, requestUnits: 0 };

    const target = Number(d.target_capital ?? 0);
    const current = ctx.state.find((s) => s.sub === d.sub)?.capital ?? 0;
    if (d.action === "KEEP") return { entry: { ...base, kind: "none", note: `KEEP at ${target} units: nothing to move` }, requestUnits: 0 };
    if (d.action === "CUT") {
      const extra = Math.max(0, current - target);
      return { entry: { ...base, kind: "none", note: `CUT to ${target} units: no transfer${extra ? `, ${extra} units above the new ceiling stay in the sub account (its report-only key cannot send funds back)` : ""}` }, requestUnits: 0 };
    }
    // INCREASE
    const profile = SUB_AGENTS.find((a) => a.id === d.sub)!;
    if (profile.mandate === "defensive_reduce_only") {
      return { entry: { ...base, kind: "blocked", note: "INCREASE blocked: a reduce-only sub is never topped up" }, requestUnits: 0 };
    }
    const want = target - current;
    if (want <= 0) return { entry: { ...base, kind: "none", note: `INCREASE to ${target} units: already holds ${current}` }, requestUnits: 0 };
    const units = Math.min(want, budget);
    if (units <= 0) return { entry: { ...base, kind: "blocked", note: `INCREASE +${want} units blocked: the per-cycle cap of ${budgetUnits} units is used up` }, requestUnits: 0 };
    budget -= units;
    const capped = units < want ? ` (capped from +${want} by the ${budgetUnits}-unit per-cycle limit)` : "";
    return { entry: { ...base, kind: "transfer", units, note: `INCREASE ${current} -> ${current + units} units${capped}` }, account: subAccountId(d.sub), requestUnits: units };
  });
}

export interface AllocateDeps {
  unitYocto?: bigint;
  maxUnits?: number;
  governorBalance?: () => Promise<bigint>;
  isRegistered?: (accountId: string) => Promise<boolean>;
  transfer?: (to: string, yocto: bigint, memo: string) => Promise<{ tx: string; logs?: string[] }>;
}

/** The memo on every transfer: ties it to the memory commit that allowed it. */
export function memoFor(decisionHash: string): string {
  return `mnemosyne ${decisionHash.replace(/^sha256:/, "").slice(0, 12)}`;
}

export async function defaultIsRegistered(accountId: string): Promise<boolean> {
  const provider = new JsonRpcProvider({ url: rpcUrl() });
  const res = await provider.callFunction({ contractId: swarmAsset(), method: "storage_balance_of", args: { account_id: accountId } });
  return res !== null && res !== undefined;
}

export async function defaultTransfer(to: string, yocto: bigint, memo: string): Promise<{ tx: string; logs: string[] }> {
  const id = process.env.GOVERNOR_ACCOUNT_ID ?? "";
  const key = process.env.GOVERNOR_PRIVATE_KEY ?? "";
  if (!id || !key) throw new Error("Missing GOVERNOR_ACCOUNT_ID / GOVERNOR_PRIVATE_KEY -- check .env");
  const account = new Account(id, new JsonRpcProvider({ url: rpcUrl() }), KeyPairSigner.fromSecretKey(key as any));
  const res: any = await account.signAndSendTransaction({
    receiverId: swarmAsset(),
    actions: [actions.functionCall("ft_transfer", { receiver_id: to, amount: yocto.toString(), memo }, teraToGas(20), 1n)],
    waitUntil: "FINAL",
  });
  const failure = txFailure(res);
  if (failure) throw new Error(failure);
  const tx = txHashOf(res);
  if (!tx) throw new Error("transfer returned no transaction hash");
  return { tx, logs: txLogs(res) };
}

/**
 * Run the allocation step. Throws AllocationGateError if the memory gate is not
 * met (the caller treats that as fail-closed). Anything else is reported per sub.
 */
export async function runAllocate(ctx: AllocationContext, deps: AllocateDeps = {}): Promise<{ mode: AllocateMode; entries: AllocationEntry[] }> {
  assertMemoryGate(ctx);
  let mode = allocateMode();
  const unit = deps.unitYocto ?? capitalUnitYocto();

  // Real transfers only make sense against real balances. Otherwise we would
  // top up toward a simulated number.
  if (mode === "wnear" && ctx.source !== "onchain") {
    const entries = planAllocation(ctx, "print", 0).map((p) => ({ ...p.entry, note: `${p.entry.note}; ALLOCATE_MODE=wnear needs SWARM_STATE=onchain, so nothing was moved` }));
    return { mode: "print", entries };
  }

  const planned = planAllocation(ctx, mode, deps.maxUnits ?? maxUnitsPerCycle());
  if (mode === "print") return { mode, entries: planned.map((p) => p.entry) };

  const isRegistered = deps.isRegistered ?? defaultIsRegistered;
  const transfer = deps.transfer ?? defaultTransfer;
  const governorBalance = deps.governorBalance ?? (() => ftBalance(process.env.GOVERNOR_ACCOUNT_ID ?? ""));
  const memo = memoFor(ctx.record.decision_hash);
  const memoryCap = memoryTargets(ctx.record);

  let remaining: bigint | null = null;
  for (const p of planned) {
    if (p.entry.kind !== "transfer" || !p.account) continue;
    const e = p.entry;
    const current = ctx.state.find((s) => s.sub === e.sub)?.capital ?? 0;
    // belt and braces: never let a transfer push a sub above the committed target
    if (current + p.requestUnits > (memoryCap.get(e.sub) ?? 0)) {
      Object.assign(e, { kind: "blocked", units: 0, note: "INCREASE blocked: it would exceed the committed target_capital" });
      continue;
    }
    const yocto = unitsToYocto(p.requestUnits, unit);
    try {
      if (remaining === null) remaining = await governorBalance();
      if (remaining < yocto) {
        Object.assign(e, { kind: "blocked", units: 0, note: `INCREASE blocked: the governor holds ${fmtWnear(remaining)} wNEAR and needs ${fmtWnear(yocto)} (run npm run swarm:setup)` });
        continue;
      }
      if (!(await isRegistered(p.account))) {
        Object.assign(e, { kind: "blocked", units: 0, note: `INCREASE blocked: ${p.account} is not registered with ${swarmAsset()} (run npm run swarm:setup)` });
        continue;
      }
      const { tx } = await transfer(p.account, yocto, memo);
      remaining -= yocto;
      Object.assign(e, { tx, wnear: fmtWnear(yocto), note: `${e.note}: sent ${fmtWnear(yocto)} wNEAR to ${p.account}` });
    } catch (err) {
      Object.assign(e, { kind: "failed", units: 0, note: `INCREASE failed: ${(err as Error).message}` });
    }
  }
  return { mode, entries: planned.map((p) => p.entry) };
}
