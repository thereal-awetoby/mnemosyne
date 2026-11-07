/**
 * Inbound cross-chain payment for a memory check (Multi-chain Phase 1).
 *
 * Today a caller pays for `/memory/check` in wNEAR on NEAR. This adds a second
 * way to be quoted: "how much USDC on Base would I have to send for the
 * governor to receive the price on NEAR?" -- priced by NEAR Intents' 1Click.
 *
 * PHASE 1 IS QUOTE-ONLY, and that is a hard boundary, not a default:
 *
 *   - Nothing here settles, verifies a settlement, or releases an answer. A
 *     quote on its own never buys a memory check; `/memory/check` does not
 *     accept a quote id and is untouched by this file.
 *   - 1Click is asked with `dry: true`, so the answer carries no deposit
 *     address. If one ever appears, the quote is refused rather than shown --
 *     the same rule the outbound rail uses (src/allocate/cross_chain.ts).
 *   - A quote is bound to the exact question it was asked for (a hash of it,
 *     never the text) and to one use, so Phase 2 can redeem it exactly once
 *     without re-opening what was asked.
 *
 * MAINNET/TESTNET, stated plainly because it decides what Phase 3 can be:
 * 1Click prices real mainnet assets (Base USDC, wrap.near). This server
 * settles on NEAR *testnet*. So an inbound quote is a real market price for a
 * route that cannot currently deliver to `mnemosyne-gov.testnet`. It is shown
 * as an indicative price and labelled as one. Making it real means either a
 * testnet route or tiny mainnet amounts, which is Phase 3's problem.
 */

import { createHash, randomUUID } from "node:crypto";
import { ONECLICK_DEFAULT_URL, ProviderError, oneClickHeaders } from "../allocate/crossChainProviders.js";

/** Where an inbound payment can come from. One route today; add a line to allow another. */
export interface InboundRoute {
  /** stable key used on the wire, e.g. "base:USDC" */
  key: string;
  /** short id for the chain, as the receipt will record it */
  chain: string;
  chain_label: string;
  symbol: string;
  decimals: number;
  /** the asset in 1Click / NEAR Intents' own id format */
  oneClickId: string;
}

export const INBOUND_ROUTES: Readonly<Record<string, InboundRoute>> = {
  "base:USDC": {
    key: "base:USDC",
    chain: "base",
    chain_label: "Base",
    symbol: "USDC",
    decimals: 6,
    oneClickId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  },
};

/** What has to arrive on the NEAR side: the governor's own asset, at the listed price. */
export const INBOUND_DESTINATION = { oneClickId: "nep141:wrap.near", symbol: "wNEAR", decimals: 24 };

/** How long a quoted price is offered for. Short on purpose: it is a market price. */
export const QUOTE_TTL_MS = 120_000;
const TIMEOUT_MS = 15_000;

export interface InboundQuote {
  quote_id: string;
  /** the memory chain head this quote was priced against, if the server knows it */
  decision_hash: string | null;
  source_chain: string;
  source_chain_label: string;
  source_asset: string;
  /** what the payer sends, in the source asset's base units */
  source_amount: string;
  /** the same, as a human decimal string */
  source_amount_display: string;
  /** what must arrive on NEAR, in yoctoNEAR -- the unchanged listed price */
  amount: string;
  asset: string;
  pay_to: string;
  expires_at: string;
  provider: "1click";
  provider_quote_id: string | null;
  /** always true in this phase; there is no path that settles one of these yet */
  quote_only: true;
  note: string;
}

/** The stored side of a quote: what Phase 2 needs to redeem it exactly once,
 *  and nothing that would reveal what was asked. */
export interface StoredQuote {
  quote_id: string;
  /** sha256 of the canonical question -- binding without keeping the text */
  request_sha256: string;
  route_key: string;
  source_amount: string;
  amount: string;
  pay_to: string;
  decision_hash: string | null;
  created_at: string;
  expires_at_ms: number;
  provider_quote_id: string | null;
  /** Phase 2 sets this when a quote is redeemed. A quote is single-use. */
  used_at: string | null;
}

export const quoteRequestHash = (query: string) => "sha256:" + createHash("sha256").update(query, "utf8").digest("hex");

/** base units -> a plain decimal string, without floating point. */
export function fromBaseUnits(amount: string, decimals: number): string {
  const v = BigInt(amount);
  if (decimals === 0) return v.toString();
  const d = BigInt(10) ** BigInt(decimals);
  const whole = v / d;
  const frac = (v % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export interface OneClickInboundOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  jwt?: string;
  now?: () => number;
}

/**
 * The exact body POSTed to 1Click for an inbound price. Exported so a probe
 * tool can send the same shape.
 *
 * EXACT_OUTPUT, not EXACT_INPUT: the thing that is fixed is what the governor
 * must receive (the listed price). What varies is how much the payer sends on
 * the source chain. The outbound rail asks the opposite question, which is why
 * this does not reuse `oneClickRequestBody`.
 */
export function inboundQuoteBody(route: InboundRoute, priceYocto: string, payTo: string, refundTo: string, nowMs: number): Record<string, unknown> {
  return {
    dry: true, // price only: no deposit address, nothing to send
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100, // 1%
    originAsset: route.oneClickId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: INBOUND_DESTINATION.oneClickId,
    amount: priceYocto,
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: payTo,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(nowMs + 10 * 60_000).toISOString(),
  };
}

const digits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

export interface InboundQuoter {
  routes: () => InboundRoute[];
  quote: (args: { query: string; routeKey: string; decisionHash: string | null }) => Promise<InboundQuote>;
}

/**
 * Builds the quoter the server hands to `POST /memory/quote`.
 *
 * `record` persists the binding; it is passed in rather than opened here so
 * the server keeps one store and tests can watch what was written.
 */
export function createInboundQuoter(cfg: {
  price: () => string;
  payTo: string;
  /** where a refund would go on the source chain if this were ever real. */
  refundTo: string;
  record: (q: StoredQuote) => void;
  oneClick?: OneClickInboundOptions;
}): InboundQuoter {
  const opts = cfg.oneClick ?? {};
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? process.env.ONECLICK_URL ?? ONECLICK_DEFAULT_URL).replace(/\/+$/, "");
  const jwt = opts.jwt ?? (process.env.ONECLICK_JWT || process.env.ONECLICK_API_KEY || undefined);
  const now = opts.now ?? Date.now;

  return {
    routes: () => Object.values(INBOUND_ROUTES),

    async quote({ query, routeKey, decisionHash }) {
      const route = INBOUND_ROUTES[routeKey];
      if (!route) throw new ProviderError(`no inbound route for "${routeKey}"`);

      const price = cfg.price();
      const nowMs = now();
      const body = inboundQuoteBody(route, price, cfg.payTo, cfg.refundTo, nowMs);

      let res: Response;
      try {
        res = await doFetch(`${base}/v0/quote`, {
          method: "POST",
          headers: oneClickHeaders(jwt),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new ProviderError(`could not reach 1Click (${(err as Error).message})`);
      }
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }
      if (!res.ok) {
        const why = typeof json?.message === "string" ? json.message : text.slice(0, 200);
        throw new ProviderError(`1Click answered ${res.status}${why ? `: ${String(why).slice(0, 200)}` : ""}`);
      }

      const q = json?.quote;
      if (!q || !digits(q.amountIn)) throw new ProviderError("1Click returned a quote without a usable amount to send");
      // A dry quote must not carry anywhere to send money. If one does, something
      // other than a price came back: refuse it rather than show it.
      if (typeof q.depositAddress === "string" && q.depositAddress.length > 0) {
        throw new ProviderError("1Click returned a deposit address for a dry quote; refusing it");
      }
      // The price that must arrive is ours, not theirs: if the provider priced a
      // different output than the one asked for, the quote is not about this check.
      if (digits(q.amountOut) && BigInt(q.amountOut) < BigInt(price)) {
        throw new ProviderError("1Click priced a smaller delivery than the listed price; refusing it");
      }

      const quote: InboundQuote = {
        quote_id: "Q-" + randomUUID().replace(/-/g, "").slice(0, 20),
        decision_hash: decisionHash,
        source_chain: route.chain,
        source_chain_label: route.chain_label,
        source_asset: route.symbol,
        source_amount: q.amountIn,
        source_amount_display: fromBaseUnits(q.amountIn, route.decimals),
        amount: price,
        asset: INBOUND_DESTINATION.symbol,
        pay_to: cfg.payTo,
        expires_at: new Date(nowMs + QUOTE_TTL_MS).toISOString(),
        provider: "1click",
        provider_quote_id: typeof json.correlationId === "string" ? json.correlationId : null,
        quote_only: true,
        note: "Indicative price only. Nothing is settled from this quote yet, and 1Click prices mainnet assets while this server settles on NEAR testnet.",
      };

      cfg.record({
        quote_id: quote.quote_id,
        request_sha256: quoteRequestHash(query),
        route_key: route.key,
        source_amount: quote.source_amount,
        amount: quote.amount,
        pay_to: quote.pay_to,
        decision_hash: decisionHash,
        created_at: new Date(nowMs).toISOString(),
        expires_at_ms: nowMs + QUOTE_TTL_MS,
        provider_quote_id: quote.provider_quote_id,
        used_at: null,
      });

      return quote;
    },
  };
}
