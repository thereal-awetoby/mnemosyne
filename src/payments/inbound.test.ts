/**
 * Paying for a check from another chain -- Phase 1, which is a price and
 * nothing else.
 *
 * The thing most worth testing here is the boundary: a quote must never turn
 * into an answer, a dead pricing API must never take the NEAR path down with
 * it, and nothing a provider says is believed without checking it first.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createMnemosyneServer } from "../x402/server.js";
import { MockFacilitator } from "../x402/facilitator.js";
import { INBOUND_ROUTES, fromBaseUnits, inboundQuoteBody, quoteRequestHash } from "./inbound.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PRICE = "1000000000000000000000"; // 0.001 wNEAR, the documented default
const PAY_TO = "mnemosyne-gov.testnet";
const QUERY = "delete the full access key";

/** 1Click, as far as this server is concerned. `answer` decides what comes back. */
function fake1Click(answer: () => { status?: number; body?: unknown } | Promise<never>) {
  const calls: any[] = [];
  const f = (async (_url: string, init: any) => {
    calls.push(JSON.parse(String(init.body)));
    const a = await answer();
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const goodQuote = (amountIn = "1050000") => ({
  body: { quote: { amountIn, amountOut: PRICE, minAmountOut: PRICE }, correlationId: "corr-123" },
});

async function serverWith(oneClickFetch: typeof fetch, dataDir: string) {
  const s = createMnemosyneServer({
    dataDir, seedPath: join(ROOT, "data/seed-memory.json"),
    payTo: PAY_TO, network: "near:testnet", asset: "NEAR", priceAmount: PRICE, maxTimeoutSeconds: 300,
    facilitator: new MockFacilitator(dataDir), mockSettlement: true,
    inboundQuotes: { refundTo: PAY_TO, oneClick: { fetch: oneClickFetch, baseUrl: "http://1click.test" } },
    dashboardData: async () => ({ cycles: [] }),
    readChainHead: async () => ({ latest_hash: "sha256:head", prev_hash: null }),
  });
  await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", () => r()));
  return { base: `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`, close: () => s.server.close() };
}

describe("the inbound quote request", () => {
  it("asks for an exact OUTPUT: what arrives on NEAR is fixed, what the payer sends is not", () => {
    const body = inboundQuoteBody(INBOUND_ROUTES["base:USDC"], PRICE, PAY_TO, PAY_TO, 0);
    assert.equal(body.swapType, "EXACT_OUTPUT", "the price is the thing that must arrive, not the thing sent");
    assert.equal(body.amount, PRICE);
    assert.equal(body.recipient, PAY_TO);
    assert.equal(body.dry, true, "a price request must never be able to take money");
    assert.equal(body.originAsset, INBOUND_ROUTES["base:USDC"].oneClickId);
  });

  it("formats base units without floating point", () => {
    assert.equal(fromBaseUnits("1050000", 6), "1.05");
    assert.equal(fromBaseUnits("1000000", 6), "1");
    assert.equal(fromBaseUnits("1", 6), "0.000001");
    assert.equal(fromBaseUnits("0", 6), "0");
    // 24 decimals is past what a double can hold exactly; it must still be right
    assert.equal(fromBaseUnits("1000000000000000000000", 24), "0.001");
  });

  it("binds to the question by hash, never by keeping the text", () => {
    const a = quoteRequestHash(QUERY);
    assert.match(a, /^sha256:[0-9a-f]{64}$/);
    assert.equal(a, quoteRequestHash(QUERY));
    assert.notEqual(a, quoteRequestHash(QUERY + " "));
  });
});

describe("POST /memory/quote", () => {
  let base = "", close = () => {}, dir = "";
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-inbound-"));
    ({ base, close } = await serverWith(fake1Click(() => goodQuote()).fetch, dir));
  });
  after(() => { close(); rmSync(dir, { recursive: true, force: true }); });

  const quote = (body: unknown) =>
    fetch(`${base}/memory/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("NEAR is the default and is answered from the rail's own terms", async () => {
    for (const body of [{ query: QUERY }, { query: QUERY, chain: "near" }]) {
      const r = await quote(body);
      assert.equal(r.status, 200);
      const j: any = await r.json();
      assert.equal(j.chain, "near");
      assert.equal(j.amount, PRICE, "the NEAR price is unchanged by any of this");
      assert.equal(j.pay_to, PAY_TO);
      assert.equal(j.quote_only, false, "NEAR is the one that can actually be paid");
      assert.deepEqual(j.other_chains, ["base:USDC"]);
    }
  });

  it("prices Base USDC, and says in the answer that it is only a price", async () => {
    const r = await quote({ query: QUERY, chain: "base:USDC" });
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(j.source_chain, "base");
    assert.equal(j.source_asset, "USDC");
    assert.equal(j.source_amount, "1050000");
    assert.equal(j.source_amount_display, "1.05", "a payer reads 1.05 USDC, not 1050000");
    assert.equal(j.amount, PRICE, "what must arrive is the listed price, untouched");
    assert.equal(j.pay_to, PAY_TO);
    assert.equal(j.quote_only, true);
    assert.equal(j.provider, "1click");
    assert.equal(j.provider_quote_id, "corr-123");
    assert.match(j.quote_id, /^Q-[0-9a-f]{20}$/);
    assert.equal(j.decision_hash, "sha256:head", "logged against the memory chain head it was priced at");
    assert.ok(Date.parse(j.expires_at) > Date.now(), "a price is offered for a limited time");
  });

  it("records the quote bound to the question, single-use, and never stores the question", async () => {
    const r = await quote({ query: QUERY, chain: "base:USDC" });
    const j: any = await r.json();
    const stored = JSON.parse(readFileSync(join(dir, "quotes.json"), "utf8"));
    const q = stored.quotes[j.quote_id];
    assert.ok(q, "the quote was written down");
    assert.equal(q.request_sha256, quoteRequestHash(QUERY), "bound to this question and no other");
    assert.equal(q.used_at, null, "unused: Phase 2 redeems it exactly once");
    assert.equal(q.amount, PRICE);
    assert.ok(!JSON.stringify(stored).includes(QUERY), "the question itself is never kept");
  });

  it("a quote buys nothing: /memory/check still demands a payment", async () => {
    const j: any = await (await quote({ query: QUERY, chain: "base:USDC" })).json();
    // the whole point of Phase 1 -- a quote id is not a payment, and presenting
    // one must not get an answer out of the server
    for (const body of [{ query: QUERY, quote_id: j.quote_id }, { query: QUERY }]) {
      const r = await fetch(`${base}/memory/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(r.status, 402, "still payment required");
      const b: any = await r.json();
      assert.ok(!b.advice && !b.citation_id, "no part of an answer leaks out with the 402");
    }
  });

  it("refuses a chain it does not have a route for, and says what it does have", async () => {
    const r = await quote({ query: QUERY, chain: "solana:SOL" });
    assert.equal(r.status, 400);
    const j: any = await r.json();
    assert.match(j.error, /near/);
    assert.match(j.error, /base:USDC/);
  });

  it("still validates the question itself", async () => {
    assert.equal((await quote({ chain: "near" })).status, 400);
    assert.equal((await quote({ query: "   " })).status, 400);
    assert.equal((await quote({ query: "x".repeat(5000) })).status, 400);
  });
});

describe("when the pricing provider misbehaves", () => {
  let dir = "";
  before(() => { dir = mkdtempSync(join(tmpdir(), "mnemo-inbound-bad-")); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const askBase = async (fetchImpl: typeof fetch) => {
    const d = mkdtempSync(join(dir, "s-"));
    const { base, close } = await serverWith(fetchImpl, d);
    try {
      const r = await fetch(`${base}/memory/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: QUERY, chain: "base:USDC" }) });
      return { status: r.status, body: (await r.json()) as any };
    } finally { close(); }
  };

  it("provider unreachable: 503 that still points at the rail that works", async () => {
    const r = await askBase((async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
    assert.equal(r.status, 503);
    assert.match(r.body.error, /could not reach 1Click/i);
    assert.match(r.body.error, /NEAR still works/i, "a dead side rail must not look like a dead server");
  });

  it("provider errors are passed on as a refusal, not as a price", async () => {
    const r = await askBase(fake1Click(() => ({ status: 400, body: { message: "unsupported asset" } })).fetch);
    assert.equal(r.status, 503);
    assert.match(r.body.error, /unsupported asset/);
  });

  it("a dry quote that comes back with somewhere to send money is refused", async () => {
    // dry:true means no deposit address. One appearing means this is not the
    // harmless price request it was asked to be.
    const r = await askBase(fake1Click(() => ({ body: { quote: { amountIn: "1050000", amountOut: PRICE, minAmountOut: PRICE, depositAddress: "0xdeadbeef" } } })).fetch);
    assert.equal(r.status, 503);
    assert.match(r.body.error, /deposit address/i);
  });

  it("a quote that would deliver less than the listed price is refused", async () => {
    const short = (BigInt(PRICE) - 1n).toString();
    const r = await askBase(fake1Click(() => ({ body: { quote: { amountIn: "1050000", amountOut: short, minAmountOut: short } } })).fetch);
    assert.equal(r.status, 503);
    assert.match(r.body.error, /smaller delivery/i);
  });

  it("a quote with no usable amount is refused rather than shown as zero", async () => {
    const r = await askBase(fake1Click(() => ({ body: { quote: { amountOut: PRICE } } })).fetch);
    assert.equal(r.status, 503);
    assert.match(r.body.error, /usable amount/i);
  });
});

describe("a server with no inbound route configured", () => {
  it("quotes NEAR and says plainly that other chains are not set up", async () => {
    const d = mkdtempSync(join(tmpdir(), "mnemo-inbound-off-"));
    const s = createMnemosyneServer({
      dataDir: d, seedPath: join(ROOT, "data/seed-memory.json"),
      payTo: PAY_TO, network: "near:testnet", asset: "NEAR", priceAmount: PRICE, maxTimeoutSeconds: 300,
      facilitator: new MockFacilitator(d), mockSettlement: true,
      dashboardData: async () => ({ cycles: [] }),
    });
    await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
    try {
      const near: any = await (await fetch(`${base}/memory/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: QUERY }) })).json();
      assert.equal(near.chain, "near");
      assert.deepEqual(near.other_chains, []);

      const other = await fetch(`${base}/memory/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: QUERY, chain: "base:USDC" }) });
      assert.equal(other.status, 503);

      // and the desk is told there is no choice to offer
      const dash: any = await (await fetch(`${base}/dashboard.json`)).json();
      assert.deepEqual(dash.x402.chains.map((c: any) => c.key), ["near"]);
    } finally { s.server.close(); rmSync(d, { recursive: true, force: true }); }
  });
});
