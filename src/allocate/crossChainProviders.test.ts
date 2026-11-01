/** The two quote providers against fake fetch / a fake Rhea client: request shape, answer mapping, errors. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashDecision } from "../memory.js";
import { DEFAULT_ENVELOPE } from "../private/decide.js";
import { envelopeToSwarmRisk } from "../limits/index.js";
import type { MemoryRecord } from "../types.js";
import { DESTINATIONS, ORIGIN_ASSET, planCrossChain, type CrossChainConfig } from "./cross_chain.js";
import { ProviderError, QUOTE_TTL_MS, oneClickProvider, rheaProvider } from "./crossChainProviders.js";

const UNIT = 10n ** 19n;
const NOW = 1_800_000_000_000;
const CFG: CrossChainConfig = { provider: "oneclick", sub: "A", dest: "base:USDC", recipient: "0x" + "cd".repeat(20), sender: "mnemosyne-gov.testnet", units: 100, maxUnits: 100, slippageBps: 50 };
const rest = { cycle_id: "c1", governor: "mnemosyne-gov.testnet", prev_memory_hash: null, decisions: [{ sub: "A" as const, action: "KEEP" as const, target_capital: "800", max_position: "160", max_loss_cycle: "40", mandate: "mean_reversion_only" }], swarm_risk: envelopeToSwarmRisk(DEFAULT_ENVELOPE), schema_version: 2 as const };
const rec: MemoryRecord = { ...rest, decision_hash: hashDecision(rest) };
const plan = planCrossChain({ record: rec, commit: { committed: true, txHash: "TX" }, state: [], source: "onchain" }, CFG, UNIT);

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const oneClickAnswer = (over: Record<string, unknown> = {}) => ({
  correlationId: "550e8400-e29b-41d4-a716-446655440000", timestamp: "2026-11-01T12:00:00Z", signature: "sig",
  quote: { amountIn: plan.amount_in, amountOut: "3100", minAmountOut: "3000", timeEstimate: 120, ...over },
});

describe("1Click provider", () => {
  it("sends a dry EXACT_INPUT quote request with the plan's assets, and nothing secret when there is no key", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const p = oneClickProvider({ now: () => NOW, jwt: "", fetch: (async (url: string, init: RequestInit) => { seen = { url, init }; return json(200, oneClickAnswer()); }) as any });
    await p.quote(plan);
    assert.equal(seen!.url, "https://1click.chaindefuser.com/v0/quote");
    assert.equal(seen!.init.method, "POST");
    assert.equal((seen!.init.headers as Record<string, string>).authorization, undefined);
    const body = JSON.parse(String(seen!.init.body));
    assert.deepEqual(body, {
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: 50,
      originAsset: ORIGIN_ASSET.oneClickId, depositType: "ORIGIN_CHAIN",
      destinationAsset: DESTINATIONS["base:USDC"].oneClickId, amount: plan.amount_in,
      refundTo: "mnemosyne-gov.testnet", refundType: "ORIGIN_CHAIN",
      recipient: CFG.recipient, recipientType: "DESTINATION_CHAIN",
      deadline: new Date(NOW + 600_000).toISOString(),
    });
  });

  it("sends the JWT as 'Authorization: Bearer' only when one is set", async () => {
    let headers: Record<string, string> = {};
    const p = oneClickProvider({ now: () => NOW, jwt: "K-123", fetch: (async (_u: string, init: RequestInit) => { headers = init.headers as Record<string, string>; return json(200, oneClickAnswer()); }) as any });
    await p.quote(plan);
    assert.equal(headers.authorization, "Bearer K-123");
    assert.equal(headers["x-api-key"], undefined);
  });

  it("maps the answer: correlation id, amounts, a local expiry, no deposit address", async () => {
    const q = await oneClickProvider({ now: () => NOW, fetch: (async () => json(200, oneClickAnswer())) as any }).quote(plan);
    assert.deepEqual(q, { provider: "oneclick", provider_quote_id: "550e8400-e29b-41d4-a716-446655440000", router: "near-intents", amount_in: plan.amount_in, amount_out: "3100", min_amount_out: "3000", received_at: NOW, expires_at: NOW + QUOTE_TTL_MS, has_deposit_address: false });
  });

  it("flags a deposit address if one ever comes back (cross_chain.ts then refuses the quote)", async () => {
    const q = await oneClickProvider({ now: () => NOW, fetch: (async () => json(200, oneClickAnswer({ depositAddress: "0xdeposit" }))) as any }).quote(plan);
    assert.equal(q.has_deposit_address, true);
  });

  it("turns failures into ProviderError and never leaks the key", async () => {
    const mk = (f: () => Promise<Response>) => oneClickProvider({ now: () => NOW, jwt: "SECRET-KEY", fetch: f as any });
    await assert.rejects(mk(async () => json(401, { message: "Unauthorized" })).quote(plan), (e: Error) => e instanceof ProviderError && /1Click answered 401: Unauthorized/.test(e.message) && !e.message.includes("SECRET-KEY"));
    await assert.rejects(mk(async () => json(400, { message: "Amount is too low" })).quote(plan), /400: Amount is too low/);
    await assert.rejects(mk(async () => new Response("<html>bad gateway</html>", { status: 502 })).quote(plan), /502: <html>bad gateway/);
    await assert.rejects(mk(async () => { throw new Error("getaddrinfo ENOTFOUND"); }).quote(plan), /could not reach 1Click \(getaddrinfo ENOTFOUND\)/);
    await assert.rejects(mk(async () => json(200, { quote: { amountIn: "1.5", amountOut: "3", minAmountOut: "3" } })).quote(plan), /without usable amounts/);
    await assert.rejects(mk(async () => json(200, {})).quote(plan), /without usable amounts/);
  });
});

describe("Rhea provider", () => {
  const rheaAnswer = (over: Record<string, unknown> = {}) => ({ id: "q-9", amountIn: plan.amount_in, estimatedOut: "3050", minAmountOut: "3000", route: { router: "near_intents" }, receivedAt: NOW, expiresAt: NOW + 20_000, ...over });

  it("asks the SDK for a standard quote built from the plan", async () => {
    let req: any;
    await rheaProvider({ client: { quote: async (r) => { req = r; return rheaAnswer(); } }, now: () => NOW }).quote(plan);
    assert.deepEqual(req, {
      fromChain: "near", toChain: "8453",
      tokenIn: { chain: "near", address: "wrap.near", symbol: "wNEAR", decimals: 24 },
      tokenOut: { chain: "8453", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 },
      amountIn: plan.amount_in, slippageBps: 50, sender: "mnemosyne-gov.testnet", recipient: CFG.recipient,
    });
  });

  it("maps the answer, keeping the router that won and the SDK's own expiry", async () => {
    const q = await rheaProvider({ client: { quote: async () => rheaAnswer() }, now: () => NOW }).quote(plan);
    assert.deepEqual(q, { provider: "rhea", provider_quote_id: "q-9", router: "near_intents", amount_in: plan.amount_in, amount_out: "3050", min_amount_out: "3000", received_at: NOW, expires_at: NOW + 20_000, has_deposit_address: false });
  });

  it("copes with a quote that has no id or expiry", async () => {
    const q = await rheaProvider({ client: { quote: async () => rheaAnswer({ id: undefined, expiresAt: undefined, route: undefined }) }, now: () => NOW }).quote(plan);
    assert.equal(q.provider_quote_id, null);
    assert.equal(q.router, null);
    assert.equal(q.expires_at, NOW + QUOTE_TTL_MS);
  });

  it("says how to get a key, and wraps SDK errors", async () => {
    const saved = process.env.RHEA_API_KEY;
    delete process.env.RHEA_API_KEY;
    try {
      await assert.rejects(rheaProvider({ apiKey: "" }).quote(plan), (e: Error) => e instanceof ProviderError && /RHEA_API_KEY is not set.*boss\.rhea\.finance.*oneclick/.test(e.message));
    } finally {
      if (saved !== undefined) process.env.RHEA_API_KEY = saved;
    }
    await assert.rejects(rheaProvider({ client: { quote: async () => { throw new Error("401 invalid key"); } } }).quote(plan), /Rhea quote failed \(401 invalid key\)/);
    await assert.rejects(rheaProvider({ client: { quote: async () => ({ id: "x" }) } }).quote(plan), /without usable amounts/);
  });

  it("the real SDK is installed and exposes the SwapClient the provider builds", async () => {
    const sdk = await import("@rhea-finance/cross-chain-aggregation-dex");
    const client = new sdk.SwapClient({ baseUrl: "https://api.rhea.finance", apiKey: "unused" });
    assert.equal(typeof client.quote, "function"); // constructing it makes no request
  });
});
