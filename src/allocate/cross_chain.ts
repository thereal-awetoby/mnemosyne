/**
 * Phase 7: cross-chain allocation, after the memory commit.
 *
 * "post_commit_cross_chain_allocate": once a cycle's memory record is committed,
 * ALLOCATE may ask Rhea / NEAR Intents what it would cost to move a small slice
 * of one sub's allocation to another chain. THIS BUILD ONLY QUOTES.
 *
 *   - A quote is a price, not a fill. Nothing is sent, signed or deposited, and
 *     every log line says so. Both networks are mainnet; the project stays on
 *     testnet, so executing is deliberately not wired (see executeAllocation).
 *   - Off by default. CROSS_CHAIN_ALLOCATE=1 turns it on. Offline demos and CI
 *     never touch the network.
 *
 * Rules, all fail-closed (docs/CROSS_CHAIN.md):
 *   1. assertMemoryGate(): no committed record that matches its own decision_hash,
 *      no quote at all. (Same gate as the same-chain rail.)
 *   2. Only what the memory allows: the sub must be KEEP or INCREASE in the
 *      committed record (never PAUSE, CUT or the reduce-only sub), and the amount
 *      can never exceed that sub's committed target_capital or the hard caps.
 *   3. Destination allowlist in code: one chain and token today. Anything else is refused.
 *   4. A provider's answer is checked before it is believed: a quote bigger than
 *      the request, with a deposit address, with no minimum out, or expired, is refused.
 *   5. Every quote is logged with the decision hash and the memory tx that allowed it.
 *
 * Subs never create intents. This is the governor's rail, operator-side only.
 * (A future per-user layer must not be able to reach it.)
 */

import { createHash } from "node:crypto";
import { SUB_AGENTS } from "../subAgents.js";
import { capitalUnitYocto, fmtWnear, unitsToYocto } from "../swarmState.js";
import type { SubAction, SubId } from "../types.js";
import { AllocationGateError, assertMemoryGate, type AllocationContext, type AllocationEntry } from "./index.js";
import { ProviderError, oneClickProvider, rheaProvider, type ProviderQuote, type QuoteProvider } from "./crossChainProviders.js";

// ---------------------------------------------------------------- the route

export interface RouteAsset {
  /** chain id in the Rhea SDK's format ("near", "8453", "solana"...) */
  chain: string;
  chain_label: string;
  address: string;
  symbol: string;
  decimals: number;
  /** the same asset in 1Click / NEAR Intents' id format */
  oneClickId: string;
}

/** The one thing a cross-chain allocation is paid from: wNEAR on NEAR (the swarm's own asset). */
export const ORIGIN_ASSET: RouteAsset = { chain: "near", chain_label: "NEAR", address: "wrap.near", symbol: "wNEAR", decimals: 24, oneClickId: "nep141:wrap.near" };

/** The destination allowlist. One path only (Step A of the spec); add a line to allow another. */
export const DESTINATIONS: Readonly<Record<string, RouteAsset>> = {
  "base:USDC": { chain: "8453", chain_label: "Base", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6, oneClickId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near" },
};

/** Never more than this, whatever the environment says: 1000 units is the usual whole sub allocation. */
export const HARD_MAX_UNITS = 1000;

// ------------------------------------------------------------------- config

export interface CrossChainConfig {
  provider: "rhea" | "oneclick";
  sub: SubId;
  /** key of DESTINATIONS */
  dest: string;
  /** address on the destination chain; null until the owner sets one */
  recipient: string | null;
  /** the origin-side account named on the quote (refund address) */
  sender: string;
  units: number;
  maxUnits: number;
  slippageBps: number;
}

export function crossChainEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CROSS_CHAIN_ALLOCATE ?? "").trim();
  if (v === "" || v === "0") return false;
  if (v === "1") return true;
  throw new Error(`CROSS_CHAIN_ALLOCATE must be 1 or 0 (got "${v}")`);
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

export function loadCrossChainConfig(env: NodeJS.ProcessEnv = process.env): CrossChainConfig {
  const wanted = (env.CROSS_CHAIN_PROVIDER ?? "").trim().toLowerCase();
  const provider = wanted === "" ? (env.RHEA_API_KEY ? "rhea" : "oneclick") : wanted;
  if (provider !== "rhea" && provider !== "oneclick") throw new Error(`unknown CROSS_CHAIN_PROVIDER "${wanted}" (rhea | oneclick)`);

  const sub = (env.CROSS_CHAIN_SUB ?? "A").trim().toUpperCase();
  if (!SUB_AGENTS.some((a) => a.id === sub)) throw new Error(`unknown CROSS_CHAIN_SUB "${sub}" (A | B | C)`);

  return {
    provider,
    sub: sub as SubId,
    dest: (env.CROSS_CHAIN_DEST ?? "base:USDC").trim(),
    recipient: (env.CROSS_CHAIN_RECIPIENT ?? "").trim() || null,
    sender: (env.CROSS_CHAIN_SENDER ?? env.GOVERNOR_ACCOUNT_ID ?? "").trim(),
    units: intEnv(env, "CROSS_CHAIN_UNITS", 100, 1, HARD_MAX_UNITS),
    maxUnits: intEnv(env, "CROSS_CHAIN_MAX_UNITS", 100, 0, HARD_MAX_UNITS),
    slippageBps: intEnv(env, "CROSS_CHAIN_SLIPPAGE_BPS", 50, 1, 300),
  };
}

export function makeProvider(cfg: CrossChainConfig): QuoteProvider {
  return cfg.provider === "rhea" ? rheaProvider() : oneClickProvider();
}

// --------------------------------------------------------------------- plan

export class CrossChainRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrossChainRefusal";
  }
}
const refuse = (m: string): never => { throw new CrossChainRefusal(m); };

export interface AllocationPlan {
  cycle_id: string;
  decision_hash: string;
  /** the NEAR tx of the memory commit that allows this */
  memory_tx: string | null;
  sub: SubId;
  action: "KEEP" | "INCREASE";
  units: number;
  /** origin token base units */
  amount_in: string;
  origin: RouteAsset;
  destination: RouteAsset;
  dest_key: string;
  recipient: string;
  sender: string;
  slippage_bps: number;
  provider: "rhea" | "oneclick";
}

/**
 * What the committed memory record allows, as a concrete request. Throws
 * AllocationGateError if the memory gate fails, CrossChainRefusal if the record
 * or the configuration does not allow a cross-chain allocation. No network.
 */
export function planCrossChain(ctx: AllocationContext, cfg: CrossChainConfig, unit: bigint = capitalUnitYocto()): AllocationPlan {
  assertMemoryGate(ctx);

  const d = ctx.record.decisions.find((x) => x.sub === cfg.sub);
  if (!d) return refuse(`sub ${cfg.sub} has no decision in the committed record`);
  if (d.action === "PAUSE") return refuse(`sub ${cfg.sub} is PAUSE in the committed record (${d.reason_code}): nothing is allowed`);
  if (d.action === "CUT") return refuse(`sub ${cfg.sub} is CUT in the committed record: no new cross-chain allocation`);
  if (SUB_AGENTS.find((a) => a.id === cfg.sub)?.mandate === "defensive_reduce_only") return refuse(`sub ${cfg.sub} is reduce-only: it is never allocated more`);

  const target = Number(d.target_capital);
  if (!Number.isFinite(target) || target <= 0) return refuse(`sub ${cfg.sub} has no usable target_capital in the committed record`);
  const cap = Math.min(cfg.maxUnits, HARD_MAX_UNITS);
  if (cfg.units > cap) return refuse(`${cfg.units} units is over the cross-chain cap of ${cap} units`);
  if (cfg.units > target) return refuse(`${cfg.units} units is over sub ${cfg.sub}'s committed target_capital of ${target}`);

  const destination = DESTINATIONS[cfg.dest];
  if (!destination) return refuse(`destination "${cfg.dest}" is not allowlisted (allowed: ${Object.keys(DESTINATIONS).join(", ")})`);
  if (!cfg.recipient) return refuse(`CROSS_CHAIN_RECIPIENT is not set: give it an address you own on ${destination.chain_label}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.recipient)) return refuse(`CROSS_CHAIN_RECIPIENT is not a valid ${destination.chain_label} address`);
  if (!cfg.sender) return refuse("no sender account: set CROSS_CHAIN_SENDER (or GOVERNOR_ACCOUNT_ID)");

  return {
    cycle_id: ctx.record.cycle_id,
    decision_hash: ctx.record.decision_hash,
    memory_tx: ctx.commit.txHash ?? null,
    sub: cfg.sub,
    action: d.action,
    units: cfg.units,
    amount_in: unitsToYocto(cfg.units, unit).toString(),
    origin: ORIGIN_ASSET,
    destination,
    dest_key: cfg.dest,
    recipient: cfg.recipient,
    sender: cfg.sender,
    slippage_bps: cfg.slippageBps,
    provider: cfg.provider,
  };
}

// -------------------------------------------------------------------- quote

export interface AllocationQuote extends ProviderQuote {
  mode: "quote_only";
  /** local digest tying this provider answer to the decision hash (the provider may give no id) */
  quote_ref: string;
  decision_hash: string;
  cycle_id: string;
  memory_tx: string | null;
}

export function quoteRef(plan: Pick<AllocationPlan, "decision_hash">, q: ProviderQuote): string {
  return createHash("sha256").update(JSON.stringify({
    decision_hash: plan.decision_hash, provider: q.provider, id: q.provider_quote_id, router: q.router,
    amount_in: q.amount_in, amount_out: q.amount_out, min_amount_out: q.min_amount_out, received_at: q.received_at,
  })).digest("hex").slice(0, 16);
}

/** Is a provider's answer inside the envelope the memory record set? Throws CrossChainRefusal if not. */
export function checkQuote(plan: AllocationPlan, q: ProviderQuote, now: number): void {
  const want = BigInt(plan.amount_in), got = BigInt(q.amount_in), out = BigInt(q.amount_out), min = BigInt(q.min_amount_out);
  if (got <= 0n) refuse("the quote is for nothing");
  if (got > want) refuse(`quote outside the memory envelope: it is for ${fmtWnear(got)} wNEAR but the record allows ${fmtWnear(want)}`);
  if (min <= 0n || out < min) refuse("quote outside the memory envelope: no usable minimum output");
  if (q.has_deposit_address) refuse("a quote-only request came back with a deposit address: refused");
  if (q.expires_at <= now) refuse("the quote has expired");
}

export interface CrossChainDeps {
  config: CrossChainConfig;
  provider: QuoteProvider;
  now?: () => number;
  unitYocto?: bigint;
}

/**
 * Ask the provider for a price (no spend) for what the memory allows, and check
 * the answer before returning it. Throws AllocationGateError, CrossChainRefusal
 * or ProviderError.
 */
export async function quoteAllocation(ctx: AllocationContext, deps: CrossChainDeps): Promise<{ plan: AllocationPlan; quote: AllocationQuote }> {
  const now = deps.now ?? Date.now;
  const plan = planCrossChain(ctx, deps.config, deps.unitYocto);
  const q = await deps.provider.quote(plan);
  checkQuote(plan, q, now());
  const quote: AllocationQuote = { ...q, mode: "quote_only", quote_ref: quoteRef(plan, q), decision_hash: plan.decision_hash, cycle_id: plan.cycle_id, memory_tx: plan.memory_tx };
  return { plan, quote };
}

// ------------------------------------------------------------------ execute

export interface AllocationExecutor {
  execute(plan: AllocationPlan, quote: AllocationQuote): Promise<{ status: "submitted" | "completed"; intent_id: string; tx?: string }>;
}

export interface ExecutionResult {
  status: "submitted" | "completed";
  intent_id: string;
  tx?: string;
  decision_hash: string;
  memory_tx: string | null;
  quote_ref: string;
}

/**
 * Execute a quote. NOT CALLED BY THE CYCLE in this release: both networks are
 * mainnet and the project is testnet-only, so no executor is wired and the
 * default is a refusal. The checks are real and tested so that wiring an
 * executor later cannot skip them: memory gate, plan still matches the record,
 * quote belongs to this record, quote still inside the envelope and fresh.
 * A "completed" status comes only from the executor, never assumed here.
 */
export async function executeAllocation(
  ctx: AllocationContext,
  plan: AllocationPlan,
  quote: AllocationQuote,
  deps: { config: CrossChainConfig; executor?: AllocationExecutor; now?: () => number; unitYocto?: bigint },
): Promise<ExecutionResult> {
  const now = deps.now ?? Date.now;
  const fresh = planCrossChain(ctx, deps.config, deps.unitYocto); // re-runs the memory gate
  for (const k of ["decision_hash", "sub", "amount_in", "dest_key", "recipient", "sender"] as const) {
    if (fresh[k] !== plan[k]) refuse(`the plan no longer matches the committed record (${k})`);
  }
  if (quote.decision_hash !== ctx.record.decision_hash) refuse("the quote belongs to a different memory record");
  checkQuote(plan, quote, now());
  if (!deps.executor) refuse("execution is not wired in this build: quote only, nothing was sent");
  const out = await deps.executor!.execute(plan, quote);
  return { status: out.status, intent_id: out.intent_id, tx: out.tx, decision_hash: plan.decision_hash, memory_tx: plan.memory_tx, quote_ref: quote.quote_ref };
}

// ------------------------------------------------------- the ALLOCATE step

export interface CrossChainRunLog {
  /** always quote_only in this release */
  mode: "quote_only";
  status: "quoted" | "refused" | "unavailable";
  provider: string | null;
  router: string | null;
  sub: SubId | null;
  destination: string | null;
  units: number | null;
  amount_in: string | null;
  amount_out: string | null;
  min_amount_out: string | null;
  provider_quote_id: string | null;
  quote_ref: string | null;
  expires_at: number | null;
  decision_hash: string;
  cycle_id: string;
  memory_tx: string | null;
  memory_tx_url: string | null;
  reason: string | null;
  note: string;
}

const NOTE = "A quote is a price, not a fill. Nothing was sent. The networks quoted are mainnet; no funds are involved.";
const NEAR_TX = "https://testnet.nearblocks.io/txns/";

export function fmtUnits(raw: string | bigint, decimals: number, maxFrac = 6): string {
  const v = BigInt(raw), base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}

/**
 * Run the cross-chain step for one cycle. Refusals and provider outages are
 * reported as entries and never crash the cycle. A failed memory gate throws
 * AllocationGateError (the caller reports it as fail-closed).
 */
export async function runCrossChainAllocate(ctx: AllocationContext, deps: Partial<CrossChainDeps> = {}): Promise<{ entries: AllocationEntry[]; summary: CrossChainRunLog }> {
  const base = {
    mode: "quote_only" as const,
    decision_hash: ctx.record.decision_hash,
    cycle_id: ctx.record.cycle_id,
    memory_tx: ctx.commit.txHash ?? null,
    memory_tx_url: ctx.commit.txHash ? NEAR_TX + ctx.commit.txHash : null,
    note: NOTE,
  };
  const empty = { provider: null, router: null, sub: null, destination: null, units: null, amount_in: null, amount_out: null, min_amount_out: null, provider_quote_id: null, quote_ref: null, expires_at: null };
  const report = (status: "refused" | "unavailable", sub: SubId, text: string, extra: Partial<CrossChainRunLog> = {}) => ({
    entries: [{ sub, action: (ctx.record.decisions.find((d) => d.sub === sub)?.action ?? "PAUSE") as SubAction, rail: "cross_chain" as const, kind: "blocked" as const, units: 0, note: `CROSS-CHAIN ${status === "refused" ? "blocked" : "quote unavailable"}: ${text} (nothing was sent)` }],
    summary: { ...base, ...empty, ...extra, status, sub, reason: text },
  });

  let cfg: CrossChainConfig;
  try {
    cfg = deps.config ?? loadCrossChainConfig();
  } catch (err) {
    assertMemoryGate(ctx); // a failed gate is still fail-closed, not a config message
    return report("refused", "A", `configuration: ${(err as Error).message}`);
  }

  try {
    const { plan, quote } = await quoteAllocation(ctx, { config: cfg, provider: deps.provider ?? makeProvider(cfg), now: deps.now, unitYocto: deps.unitYocto });
    const route = quote.router ?? quote.provider;
    const id = quote.provider_quote_id ?? `ref ${quote.quote_ref}`;
    const text = `CROSS-CHAIN QUOTE via ${route}: ${fmtWnear(BigInt(quote.amount_in))} wNEAR -> about ${fmtUnits(quote.amount_out, plan.destination.decimals)} ${plan.destination.symbol} on ${plan.destination.chain_label} (at least ${fmtUnits(quote.min_amount_out, plan.destination.decimals)}), quote ${id}; quote only, nothing was sent`;
    return {
      entries: [{ sub: plan.sub, action: plan.action as SubAction, rail: "cross_chain", kind: "quote", units: plan.units, note: text }],
      summary: {
        ...base, status: "quoted", provider: quote.provider, router: quote.router, sub: plan.sub, destination: plan.dest_key, units: plan.units,
        amount_in: quote.amount_in, amount_out: quote.amount_out, min_amount_out: quote.min_amount_out,
        provider_quote_id: quote.provider_quote_id, quote_ref: quote.quote_ref, expires_at: quote.expires_at, reason: null,
      },
    };
  } catch (err) {
    if (err instanceof AllocationGateError) throw err;
    if (err instanceof CrossChainRefusal) return report("refused", cfg.sub, err.message, { provider: cfg.provider, destination: cfg.dest, units: cfg.units });
    if (err instanceof ProviderError) return report("unavailable", cfg.sub, err.message, { provider: cfg.provider, destination: cfg.dest, units: cfg.units });
    throw err;
  }
}
