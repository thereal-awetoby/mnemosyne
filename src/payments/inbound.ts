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
  /** true when this route can actually be paid, not only priced */
  payable?: boolean;
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

/**
 * The route that can actually be paid, as opposed to only priced.
 *
 * Nothing bridges to NEAR testnet (1Click has no testnet and never will;
 * Omni Bridge's testnet EVM->NEAR path is broken), so this route does not try
 * to bridge. The payer pays on Base Sepolia and the governor *receives on
 * Base Sepolia*, at an address derived from `mnemosyne-gov.testnet` through
 * NEAR Chain Signatures -- an address only that NEAR account can spend from.
 * Real money movement, real testnet, no bridge in the middle.
 *
 * Native ETH rather than USDC on purpose: settlement is then a balance check
 * on an address that exists for exactly one quote, with no token contract to
 * mistype, no decimals to mismatch, and no log parsing to get subtly wrong.
 */
export const PAYABLE_ROUTE = {
  key: "base-sepolia:ETH",
  chain: "base-sepolia",
  chain_label: "Base Sepolia",
  symbol: "ETH",
  decimals: 18,
} as const;

/** How long a quoted price is offered for. Short on purpose: it is a market price. */
export const QUOTE_TTL_MS = 120_000;
/** A payable quote lasts longer: someone has to actually go and send a transaction. */
export const PAYABLE_TTL_MS = 30 * 60_000;
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

/** A quote that can be paid: where to send, how much, and on which chain. */
export interface PayableQuote {
  quote_id: string;
  kind: "payable";
  decision_hash: string | null;
  source_chain: string;
  source_chain_label: string;
  source_asset: string;
  /** what to send, in wei */
  source_amount: string;
  source_amount_display: string;
  /** the address to send it to, controlled by the governor's NEAR account via MPC */
  deposit_address: string;
  /** the NEAR account that can spend what arrives, and the path it derives by */
  controlled_by: string;
  deposit_path: string;
  explorer: string;
  expires_at: string;
  quote_only: false;
  how: string;
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
  /** set when a quote is redeemed. A quote is single-use. */
  used_at: string | null;
  /** "price" quotes cannot be redeemed at all; only "payable" ones can. */
  kind?: "price" | "payable";
  /** payable only: where the payer sends, and the path it derives by */
  deposit_address?: string;
  deposit_path?: string;
  source_chain?: string;
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
  quote: (args: { query: string; routeKey: string; decisionHash: string | null }) => Promise<InboundQuote | PayableQuote>;
  /** Present only when a payable route is configured. */
  settle?: (args: { query: string; quoteId: string }) => Promise<SettlementProof>;
}

/** What a redeemed payment proves, and what goes on the receipt. */
export interface SettlementProof {
  quote_id: string;
  source_chain: string;
  source_asset: string;
  source_amount: string;
  deposit_address: string;
  controlled_by: string;
  explorer: string;
}

export class SettlementError extends Error {
  constructor(message: string, readonly paid = false) {
    super(message);
    this.name = "SettlementError";
  }
}

/** Chain-signature settlement: the payable route's configuration. */
export interface ChainSigConfig {
  /** NEAR account whose chain-signature key controls the deposit address */
  predecessor: string;
  /** the MPC signer contract (testnet: v1.signer-prod.testnet) */
  mpcContract: string;
  nearRpc: (method: string, params: unknown) => Promise<any>;
  evmRpc: (method: string, params: unknown[]) => Promise<any>;
  /** price of one check on the source chain, in wei */
  priceWei: string;
  explorerBase?: string;
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
  /** reads a stored quote back, for redeeming it */
  load?: (quoteId: string) => StoredQuote | undefined;
  /** marks a quote spent. Must be atomic with respect to other redemptions. */
  markUsed?: (quoteId: string, at: string) => boolean;
  oneClick?: OneClickInboundOptions;
  /** the route that can actually be paid; absent means price-only quotes */
  chainSig?: ChainSigConfig;
  now?: () => number;
}): InboundQuoter {
  const opts = cfg.oneClick ?? {};
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? process.env.ONECLICK_URL ?? ONECLICK_DEFAULT_URL).replace(/\/+$/, "");
  const jwt = opts.jwt ?? (process.env.ONECLICK_JWT || process.env.ONECLICK_API_KEY || undefined);
  const now = cfg.now ?? opts.now ?? Date.now;
  const cs = cfg.chainSig;

  /** The route that can be paid, if one is configured. */
  const payableRoute: InboundRoute | null = cs
    ? { ...PAYABLE_ROUTE, oneClickId: "", payable: true }
    : null;

  /** A quote that is paid by sending to an address the governor controls on
   *  the source chain. Nothing is deployed there and nothing is signed to
   *  receive: the address is derived, and derivation is a free view call. */
  async function payableQuote(query: string, decisionHash: string | null): Promise<PayableQuote> {
    const nowMs = now();
    const quote_id = "Q-" + randomUUID().replace(/-/g, "").slice(0, 20);
    const { depositAddressFor } = await import("./chainsig.js");
    const { address, path } = await depositAddressFor(cs!.nearRpc, {
      contract: cs!.mpcContract, predecessor: cs!.predecessor, quoteId: quote_id,
    });
    const explorerBase = (cs!.explorerBase ?? "https://sepolia.basescan.org").replace(/\/$/, "");

    cfg.record({
      quote_id,
      request_sha256: quoteRequestHash(query),
      route_key: PAYABLE_ROUTE.key,
      source_amount: cs!.priceWei,
      amount: cs!.priceWei,
      pay_to: address,
      decision_hash: decisionHash,
      created_at: new Date(nowMs).toISOString(),
      expires_at_ms: nowMs + PAYABLE_TTL_MS,
      provider_quote_id: null,
      used_at: null,
      kind: "payable",
      deposit_address: address,
      deposit_path: path,
      source_chain: PAYABLE_ROUTE.chain,
    });

    return {
      quote_id,
      kind: "payable",
      decision_hash: decisionHash,
      source_chain: PAYABLE_ROUTE.chain,
      source_chain_label: PAYABLE_ROUTE.chain_label,
      source_asset: PAYABLE_ROUTE.symbol,
      source_amount: cs!.priceWei,
      source_amount_display: fromBaseUnits(cs!.priceWei, PAYABLE_ROUTE.decimals),
      deposit_address: address,
      controlled_by: cs!.predecessor,
      deposit_path: path,
      explorer: `${explorerBase}/address/${address}`,
      expires_at: new Date(nowMs + PAYABLE_TTL_MS).toISOString(),
      quote_only: false,
      how: `Send exactly this much ETH on Base Sepolia to the address above, then ask again with this quote id. The address is controlled by ${cs!.predecessor} through NEAR Chain Signatures.`,
    };
  }

  return {
    routes: () => [...Object.values(INBOUND_ROUTES), ...(payableRoute ? [payableRoute] : [])],

    ...(cs && cfg.load && cfg.markUsed ? {
      /**
       * Has this quote been paid? Settlement is a balance check on an address
       * that exists for exactly one quote, so there is no amount-matching
       * guesswork and one payment can never satisfy two quotes.
       *
       * Fail-closed throughout: an unreadable node, an expired quote, a
       * question that does not match the one quoted, or a quote already spent
       * all refuse, and none of them release an answer.
       */
      async settle({ query, quoteId }): Promise<SettlementProof> {
        const q = cfg.load!(quoteId);
        if (!q) throw new SettlementError("no such quote");
        if (q.kind !== "payable" || !q.deposit_address) throw new SettlementError("that quote is a price only; it cannot be paid");
        if (q.used_at) throw new SettlementError("that quote has already been used");
        if (q.request_sha256 !== quoteRequestHash(query)) throw new SettlementError("that quote was for a different question");
        if (now() > q.expires_at_ms) throw new SettlementError("that quote has expired; ask for a new price");

        const { balanceOf } = await import("./evm.js");
        let held: bigint;
        try { held = await balanceOf(cs.evmRpc, q.deposit_address); } catch (err) { throw new SettlementError(`could not check the payment on Base Sepolia: ${(err as Error).message}`); }
        if (held < BigInt(q.source_amount)) { throw new SettlementError(`not paid yet: that address holds ${fromBaseUnits(held.toString(), PAYABLE_ROUTE.decimals)} ETH of the ${fromBaseUnits(q.source_amount, PAYABLE_ROUTE.decimals)} ETH asked for`); }

        // Spend the quote before the answer is computed. If two requests race,
        // only the one that wins this claim gets an answer for this payment.
        if (!cfg.markUsed!(quoteId, new Date(now()).toISOString())) throw new SettlementError("that quote has already been used");

        const explorerBase = (cs.explorerBase ?? "https://sepolia.basescan.org").replace(/\/$/, "");
        return { quote_id: quoteId, source_chain: PAYABLE_ROUTE.chain, source_asset: PAYABLE_ROUTE.symbol, source_amount: q.source_amount, deposit_address: q.deposit_address, controlled_by: cs.predecessor, explorer: `${explorerBase}/address/${q.deposit_address}` };
      },
    } : {}),

    async quote({ query, routeKey, decisionHash }) {
      if (cs && routeKey === PAYABLE_ROUTE.key) return payableQuote(query, decisionHash);
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
      if (typeof q.depositAddress === "string" && q.depositAddress.length > 0) {
        throw new ProviderError("1Click returned a deposit address for a dry quote; refusing it");
      }
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
        note: "Indicative price only. Nothing is settled from this quote yet.",
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
