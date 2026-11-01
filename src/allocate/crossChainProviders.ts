/**
 * Quote providers for the cross-chain allocation rail (Phase 7).
 *
 * Both are QUOTE-ONLY. Neither one sends, signs or deposits anything.
 *
 *   oneclick  NEAR Intents' 1Click API, POST /v0/quote with dry:true. A dry quote has
 *             no deposit address by design. Works without a token (a JWT only
 *             removes a small extra fee); set ONECLICK_JWT if you have one. It is
 *             sent as "Authorization: Bearer <jwt>", as the 1Click docs show.
 *   rhea      Rhea's RHEA X Chain SDK (@rhea-finance/cross-chain-aggregation-dex),
 *             SwapClient.quote(). Needs an API key from https://boss.rhea.finance
 *             (RHEA_API_KEY). Rhea routes through several routers, NEAR Intents
 *             among them; the router that won is recorded.
 *
 * Both of these networks are MAINNET. A quote costs nothing and moves nothing,
 * which is why quoting is allowed under this project's testnet-only rule and
 * executing is not wired.
 *
 * Everything the outside world tells us is checked by cross_chain.ts before it
 * is believed (amounts must not exceed what the memory record allows).
 */

import type { AllocationPlan } from "./cross_chain.js";

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderQuote {
  provider: "rhea" | "oneclick";
  /** the provider's own id for this quote, if it gives one (1Click: correlationId) */
  provider_quote_id: string | null;
  /** which router/solver network priced it, if the provider says */
  router: string | null;
  /** base units of the origin token the quote is for */
  amount_in: string;
  /** estimated output, base units of the destination token */
  amount_out: string;
  min_amount_out: string;
  received_at: number;
  /** ms epoch after which the quote must not be used; local freshness window if the provider gives none */
  expires_at: number;
  /** a dry quote never has one. If one appears, cross_chain.ts refuses the quote. */
  has_deposit_address: boolean;
}

export interface QuoteProvider {
  readonly name: "rhea" | "oneclick";
  quote(plan: AllocationPlan): Promise<ProviderQuote>;
}

/** Local freshness window when a provider gives no expiry (the Rhea SDK's own default is 30 s). */
export const QUOTE_TTL_MS = 30_000;
const TIMEOUT_MS = 15_000;
const digits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

// ------------------------------------------------------------------ 1Click

export interface OneClickOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  /** 1Click JWT. Optional: without one the quote still works, with a small extra fee. */
  jwt?: string;
  now?: () => number;
}

/** The exact JSON body POSTed to /v0/quote. Exported so the probe tool sends the same shape. */
export function oneClickRequestBody(plan: AllocationPlan, nowMs: number): Record<string, unknown> {
  return {
    dry: true, // quote only: no deposit address, nothing to send
    swapType: "EXACT_INPUT",
    slippageTolerance: plan.slippage_bps,
    originAsset: plan.origin.oneClickId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: plan.destination.oneClickId,
    amount: plan.amount_in,
    refundTo: plan.sender,
    refundType: "ORIGIN_CHAIN",
    recipient: plan.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(nowMs + 10 * 60_000).toISOString(),
  };
}

export function oneClickHeaders(jwt?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (jwt) h.authorization = `Bearer ${jwt}`;
  return h;
}

export const ONECLICK_DEFAULT_URL = "https://1click.chaindefuser.com";

export function oneClickProvider(opts: OneClickOptions = {}): QuoteProvider {
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? process.env.ONECLICK_URL ?? ONECLICK_DEFAULT_URL).replace(/\/+$/, "");
  const jwt = opts.jwt ?? (process.env.ONECLICK_JWT || process.env.ONECLICK_API_KEY || undefined);
  const now = opts.now ?? Date.now;

  return {
    name: "oneclick",
    async quote(plan) {
      const body = oneClickRequestBody(plan, now());
      const headers = oneClickHeaders(jwt);

      let res: Response;
      try {
        res = await doFetch(`${base}/v0/quote`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
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
      if (!q || !digits(q.amountIn) || !digits(q.amountOut) || !digits(q.minAmountOut)) throw new ProviderError("1Click returned a quote without usable amounts");
      const received = now();
      return {
        provider: "oneclick",
        provider_quote_id: typeof json.correlationId === "string" ? json.correlationId : null,
        router: "near-intents",
        amount_in: q.amountIn,
        amount_out: q.amountOut,
        min_amount_out: q.minAmountOut,
        received_at: received,
        expires_at: received + QUOTE_TTL_MS,
        has_deposit_address: typeof q.depositAddress === "string" && q.depositAddress.length > 0,
      };
    },
  };
}

// -------------------------------------------------------------------- Rhea

/** The one method of the Rhea SDK's SwapClient that this rail uses. Injectable for tests. */
export interface RheaQuoteClient {
  quote(request: Record<string, unknown>): Promise<any>;
}

export interface RheaOptions {
  apiKey?: string;
  baseUrl?: string;
  client?: RheaQuoteClient;
  now?: () => number;
}

async function defaultRheaClient(apiKey: string, baseUrl: string): Promise<RheaQuoteClient> {
  // imported only when this provider is used, so everything else runs without the package
  const { SwapClient } = await import("@rhea-finance/cross-chain-aggregation-dex");
  return new SwapClient({ baseUrl, apiKey, timeoutMs: TIMEOUT_MS }) as unknown as RheaQuoteClient;
}

export function rheaProvider(opts: RheaOptions = {}): QuoteProvider {
  const apiKey = opts.apiKey ?? (process.env.RHEA_API_KEY || "");
  const baseUrl = opts.baseUrl ?? process.env.RHEA_API_URL ?? "https://api.rhea.finance";
  const now = opts.now ?? Date.now;

  return {
    name: "rhea",
    async quote(plan) {
      if (!opts.client && !apiKey) throw new ProviderError("RHEA_API_KEY is not set (request one at https://boss.rhea.finance), or set CROSS_CHAIN_PROVIDER=oneclick");
      const asset = (a: AllocationPlan["origin"]) => ({ chain: a.chain, address: a.address, symbol: a.symbol, decimals: a.decimals });
      const request = {
        fromChain: plan.origin.chain,
        toChain: plan.destination.chain,
        tokenIn: asset(plan.origin),
        tokenOut: asset(plan.destination),
        amountIn: plan.amount_in,
        slippageBps: plan.slippage_bps,
        sender: plan.sender,
        recipient: plan.recipient,
      };
      let q: any;
      try {
        const client = opts.client ?? (await defaultRheaClient(apiKey, baseUrl));
        q = await client.quote(request);
      } catch (err) {
        throw new ProviderError(`Rhea quote failed (${(err as Error).message})`);
      }
      if (!q || !digits(q.amountIn) || !digits(q.estimatedOut) || !digits(q.minAmountOut)) throw new ProviderError("Rhea returned a quote without usable amounts");
      const received = Number.isFinite(q.receivedAt) ? Number(q.receivedAt) : now();
      return {
        provider: "rhea",
        provider_quote_id: typeof q.id === "string" && q.id ? q.id : null,
        router: typeof q.route?.router === "string" ? q.route.router : null,
        amount_in: q.amountIn,
        amount_out: q.estimatedOut,
        min_amount_out: q.minAmountOut,
        received_at: received,
        expires_at: Number.isFinite(q.expiresAt) ? Number(q.expiresAt) : received + QUOTE_TTL_MS,
        has_deposit_address: false, // the SDK's quote() never carries one
      };
    },
  };
}
