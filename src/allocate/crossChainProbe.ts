/**
 * Diagnostic for the 1Click price call (Phase 7). It answers one question:
 * "why did 1Click say 400?" by sending a few dry quote requests that each
 * change one thing, and by checking 1Click's token list for our asset ids.
 *
 * PRICES ONLY. A dry quote has no deposit address; nothing is sent, signed or
 * deposited, and none of this is an allocation (it never reads a memory
 * record, is never called by the cycle, and logs nothing as a quote).
 *
 * Pure logic with an injectable fetch, so it is tested offline. The command
 * line wrapper is src/tools/crossChainProbe.ts.
 */

import { DESTINATIONS, ORIGIN_ASSET, type AllocationPlan } from "./cross_chain.js";
import { ONECLICK_DEFAULT_URL, oneClickHeaders, oneClickRequestBody } from "./crossChainProviders.js";

/** wNEAR amounts in yoctoNEAR: 0.1 wNEAR is the docs' own example size. */
export const PROBE_BIG_AMOUNT = "100000000000000000000000";
/** The burn address. A dry quote cannot send anything to it; it only tests "does 1Click like another recipient". */
export const PROBE_BURN_RECIPIENT = "0x000000000000000000000000000000000000dEaD";
/** The docs' own destination in their request example (ARB on Arbitrum): a control that has nothing to do with our ids. */
export const PROBE_CONTROL_DEST = {
  chain: "42161", chain_label: "Arbitrum", address: "0x912ce59144191c1204e64559fe8253a0e49e6548", symbol: "ARB", decimals: 18,
  oneClickId: "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near",
} as const;

export interface ProbeVariant {
  key: "A" | "B" | "C" | "D" | "E" | "F";
  label: string;
  refund: string;
  amount: string;
  body: Record<string, unknown>;
}

export interface ProbeInput {
  /** the recipient from CROSS_CHAIN_RECIPIENT (or the burn address if unset) */
  recipient: string;
  /** the refund account as currently configured */
  sender: string;
  /** the governor key's implicit account, or null when no key is available */
  implicit: string | null;
  /** the amount as currently configured, in yoctoNEAR */
  amount: string;
  slippageBps: number;
  now: number;
}

function planFor(i: ProbeInput, over: { sender: string; amount: string; recipient: string; destination?: AllocationPlan["destination"] }): AllocationPlan {
  return {
    cycle_id: "probe", decision_hash: "sha256:probe", memory_tx: null, sub: "A", action: "KEEP", units: 0,
    amount_in: over.amount, origin: ORIGIN_ASSET, destination: over.destination ?? DESTINATIONS["base:USDC"], dest_key: "base:USDC",
    recipient: over.recipient, sender: over.sender, slippage_bps: i.slippageBps, provider: "oneclick",
  };
}

/** Each variant changes one thing from the one before it. B, D, E need the implicit account and are left out without one. */
export function buildProbeVariants(i: ProbeInput): ProbeVariant[] {
  const mk = (key: ProbeVariant["key"], label: string, o: { sender: string; amount: string; recipient: string; destination?: AllocationPlan["destination"] }): ProbeVariant =>
    ({ key, label, refund: o.sender, amount: o.amount, body: oneClickRequestBody(planFor(i, o), i.now) });
  const out: ProbeVariant[] = [
    mk("A", "as configured", { sender: i.sender, amount: i.amount, recipient: i.recipient }),
    mk("C", "bigger amount (0.1 wNEAR)", { sender: i.sender, amount: PROBE_BIG_AMOUNT, recipient: i.recipient }),
  ];
  if (i.implicit) {
    out.push(mk("B", "mainnet-style refund account", { sender: i.implicit, amount: i.amount, recipient: i.recipient }));
    out.push(mk("D", "refund account + bigger amount", { sender: i.implicit, amount: PROBE_BIG_AMOUNT, recipient: i.recipient }));
    if (i.recipient.toLowerCase() !== PROBE_BURN_RECIPIENT.toLowerCase()) {
      out.push(mk("E", "... and a different recipient", { sender: i.implicit, amount: PROBE_BIG_AMOUNT, recipient: PROBE_BURN_RECIPIENT }));
    }
  }
  out.push(mk("F", "control: docs' own pair (wNEAR -> ARB)", { sender: i.implicit ?? i.sender, amount: PROBE_BIG_AMOUNT, recipient: i.recipient, destination: PROBE_CONTROL_DEST }));
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// ------------------------------------------------------------------ running

export interface ProbeResult {
  key: ProbeVariant["key"];
  label: string;
  refund: string;
  amount: string;
  ok: boolean;
  /** HTTP status, or null if the request never got an answer */
  status: number | null;
  /** 1Click's own message on a refusal; "quote ok, ..." summary on success */
  message: string;
}

export interface TokenCheck {
  reachable: boolean;
  error?: string;
  count: number;
  wrapNear: boolean;
  /** is the destination asset id we use listed? */
  ourDest: boolean;
  /** the asset ids 1Click lists as USDC on Base */
  baseUsdc: string[];
}

const TIMEOUT_MS = 15_000;

export async function checkTokens(f: typeof fetch, baseUrl: string): Promise<TokenCheck> {
  const bad = (error: string): TokenCheck => ({ reachable: false, error, count: 0, wrapNear: false, ourDest: false, baseUsdc: [] });
  try {
    const res = await f(`${baseUrl}/v0/tokens`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) return bad(`answered ${res.status}: ${text.slice(0, 120)}`);
    const json: any = JSON.parse(text);
    const list: any[] = Array.isArray(json) ? json : Array.isArray(json?.tokens) ? json.tokens : [];
    if (list.length === 0) return bad("the token list was empty or in a shape this tool does not know");
    const ids = new Set(list.map((t) => String(t?.assetId ?? "")));
    return {
      reachable: true,
      count: list.length,
      wrapNear: ids.has(ORIGIN_ASSET.oneClickId),
      ourDest: ids.has(DESTINATIONS["base:USDC"].oneClickId),
      baseUsdc: list.filter((t) => String(t?.blockchain).toLowerCase() === "base" && String(t?.symbol).toUpperCase() === "USDC").map((t) => String(t.assetId)),
    };
  } catch (err) {
    return bad((err as Error).message);
  }
}

export async function runVariant(f: typeof fetch, baseUrl: string, v: ProbeVariant, jwt?: string): Promise<ProbeResult> {
  const head = { key: v.key, label: v.label, refund: v.refund, amount: v.amount };
  try {
    const res = await f(`${baseUrl}/v0/quote`, { method: "POST", headers: oneClickHeaders(jwt), body: JSON.stringify(v.body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep the raw text */ }
    if (!res.ok) {
      const why = typeof json?.message === "string" ? json.message : text.slice(0, 160);
      return { ...head, ok: false, status: res.status, message: String(why || "(no message)").slice(0, 160) };
    }
    const q = json?.quote;
    if (!q?.amountOut) return { ...head, ok: false, status: res.status, message: "answered 200 but without a quote" };
    return { ...head, ok: true, status: res.status, message: `quote ok, would pay out ${q.amountOut} base units` };
  } catch (err) {
    return { ...head, ok: false, status: null, message: `no answer (${(err as Error).message})` };
  }
}

// ---------------------------------------------------------------- reading it

export interface Diagnosis {
  lines: string[];
  /** the settings to use, if the probe found a working combination */
  env: Record<string, string>;
}

/** Turn the raw results into plain advice. Pure. */
export function diagnose(tokens: TokenCheck, results: ProbeResult[], implicit: string | null): Diagnosis {
  const ok = (k: string) => results.find((r) => r.key === k)?.ok === true;
  const ran = (k: string) => results.some((r) => r.key === k);
  const lines: string[] = [];
  const env: Record<string, string> = {};

  if (tokens.reachable && !tokens.wrapNear) lines.push(`1Click's token list does not contain ${ORIGIN_ASSET.oneClickId}, our origin asset.`);
  if (tokens.reachable && !tokens.ourDest) {
    lines.push(tokens.baseUsdc.length
      ? `Our Base USDC id is NOT in 1Click's token list. It lists USDC on Base as: ${tokens.baseUsdc.join(", ")}. Put that id in DESTINATIONS in src/allocate/cross_chain.ts.`
      : "Our Base USDC id is NOT in 1Click's token list, and the list shows no USDC on Base at all.");
  }

  if (ok("A")) {
    lines.push("Variant A (your exact config) got a quote now, so the earlier 400 did not come from your settings. Run npm run crosschain:check again.");
  } else if (ok("B") || ok("C") || ok("D") || ok("E")) {
    if (ok("B") && implicit) {
      env.CROSS_CHAIN_SENDER = implicit;
      lines.push("The refund account was the problem: 1Click wants a mainnet-style account, not a .testnet name. Using your governor key's own account fixes it (it is only a label while nothing executes).");
    } else if (ok("C")) {
      env.CAPITAL_UNIT_YOCTO = "1000000000000000000000";
      lines.push("The amount was the problem: 0.001 wNEAR is too small for 1Click to price. In the window where you run crosschain:check, this makes 100 units = 0.1 wNEAR.");
    } else if (ok("D") && implicit) {
      env.CROSS_CHAIN_SENDER = implicit;
      env.CAPITAL_UNIT_YOCTO = "1000000000000000000000";
      lines.push("Both were needed: a mainnet-style refund account and a bigger amount.");
    } else if (ok("E")) {
      lines.push("Variant E worked and D did not, and they differ only in the recipient. 1Click did not like your recipient address; use a different Base address that you own.");
    }
  } else if (ok("F")) {
    lines.push("The docs' own example pair (wNEAR -> ARB) gets a quote, but every wNEAR -> Base USDC request failed. So the trouble is in the Base USDC side (its asset id, or 1Click not routing it), not in your account or amount.");
  } else if (results.length > 0 && results.every((r) => r.status === null)) {
    lines.push(`No request got an answer from 1Click at all (${results[0].message}). That is this machine's network (offline, a firewall, a VPN or a proxy), not 1Click refusing anything. Check you can open https://1click.chaindefuser.com/v0/tokens in a browser, then run this again.`);
  } else if (ran("F")) {
    const why = [...new Set(results.map((r) => r.message))].slice(0, 3).join(" | ");
    lines.push(`1Click rejected every variant, even the docs' own example pair (${why}). That points at 1Click itself (a bad moment, or it wants a JWT: set ONECLICK_JWT). Nothing in this build is wrong that this probe can see; try again later. The cycle is unaffected: a failed quote is logged and the cycle carries on.`);
  }
  if (lines.length === 0) lines.push("Nothing conclusive: no variant got a quote and the token list could not be read.");
  return { lines, env };
}

// ---------------------------------------------------------------------- all

export async function runProbe(input: ProbeInput, opts: { fetch?: typeof fetch; baseUrl?: string; jwt?: string } = {}): Promise<{ tokens: TokenCheck; results: ProbeResult[]; variants: ProbeVariant[]; diagnosis: Diagnosis }> {
  const f = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? process.env.ONECLICK_URL ?? ONECLICK_DEFAULT_URL).replace(/\/+$/, "");
  const jwt = opts.jwt ?? (process.env.ONECLICK_JWT || process.env.ONECLICK_API_KEY || undefined);
  const tokens = await checkTokens(f, base);
  const variants = buildProbeVariants(input);
  const results: ProbeResult[] = [];
  for (const v of variants) results.push(await runVariant(f, base, v, jwt));
  return { tokens, results, variants, diagnosis: diagnose(tokens, results, input.implicit) };
}
