/**
 * Paying from Base Sepolia through NEAR Chain Signatures.
 *
 * The risk here is not a wrong label, it is a wrong address or a free answer.
 * So these tests pin down: the address derivation (against a key the real MPC
 * contract actually returned), and every way the settlement check must refuse.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createMnemosyneServer } from "../x402/server.js";
import { MockFacilitator } from "../x402/facilitator.js";
import { MPC_CONTRACT_TESTNET, depositPath, evmAddress, toChecksumAddress } from "./chainsig.js";
import { balanceOf, evmRpc, fromWei } from "./evm.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const QUERY = "delete the full access key";
const PRICE_WEI = "10000000000000"; // 0.00001 ETH

/* A real answer from the real contract, recorded live from NEAR testnet:
 *   v1.signer-prod.testnet.derived_public_key({
 *     predecessor: "mnemosyne-gov.testnet", path: "base-sepolia-1" })
 * Kept as a fixture so the derivation cannot drift without a test failing. */
const REAL_KEY = "secp256k1:41jPZuRYWASBLjRKFYxzEbLRBp35gdw1qz6tPSBrGkK291GSpJP6YWts3JoXK77tfFq8b8Fjz7t9Nm7TNwFZ8Vp4";
const REAL_ADDRESS = "0x54b701a8fff8d657a5e3e712642d57b5e824b85d";

describe("deriving the address money is sent to", () => {
  it("turns the MPC contract's own key into the right EVM address", () => {
    assert.equal(evmAddress(REAL_KEY).toLowerCase(), REAL_ADDRESS);
  });

  it("checksums it, so a mistyped character is visible rather than silent", () => {
    const a = evmAddress(REAL_KEY);
    assert.notEqual(a, a.toLowerCase(), "EIP-55 mixed case");
    assert.equal(a.toLowerCase(), REAL_ADDRESS);
    // a known EIP-55 vector
    assert.equal(toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
  });

  it("refuses a key that is not a secp256k1 point of the right size", () => {
    assert.throws(() => evmAddress("ed25519:11111111111111111111111111111111"), /secp256k1/);
    assert.throws(() => evmAddress("secp256k1:2b" ), /64-byte/);
  });

  it("gives every quote its own path, so two payments can never collide", () => {
    assert.notEqual(depositPath("Q-aaa"), depositPath("Q-bbb"));
    assert.match(depositPath("Q-aaa"), /Q-aaa/);
  });

  it("names the MPC contract that actually exists on testnet", () => {
    assert.equal(MPC_CONTRACT_TESTNET, "v1.signer-prod.testnet");
  });
});

describe("reading the payment off Base Sepolia", () => {
  const rpcWith = (result: unknown) => evmRpc("http://base.test", (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 })) as unknown as typeof fetch);

  it("reads a balance as wei", async () => {
    assert.equal(await balanceOf(rpcWith("0x2386f26fc10000"), REAL_ADDRESS), 10000000000000000n);
    assert.equal(await balanceOf(rpcWith("0x0"), REAL_ADDRESS), 0n);
  });

  it("refuses a node answer that is not a hex quantity, rather than reading it as zero", async () => {
    await assert.rejects(balanceOf(rpcWith("not-hex"), REAL_ADDRESS), /hex quantity/);
    await assert.rejects(balanceOf(rpcWith(null), REAL_ADDRESS), /hex quantity/);
  });

  it("passes a node error up instead of treating it as unpaid", async () => {
    const rpc = evmRpc("http://base.test", (async () => new Response(JSON.stringify({ error: { message: "limit exceeded" } }), { status: 200 })) as unknown as typeof fetch);
    await assert.rejects(balanceOf(rpc, REAL_ADDRESS), /limit exceeded/);
  });

  it("formats wei without floating point", () => {
    assert.equal(fromWei("10000000000000"), "0.00001");
    assert.equal(fromWei("1000000000000000000"), "1");
    assert.equal(fromWei("1"), "0.000000000000000001");
  });
});

describe("paying for a check from Base Sepolia, end to end", () => {
  let base = "", close = () => {}, dir = "";
  let balance = 0n;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-csig-"));
    const nearRpc = async (_m: string, p: any) => {
      // the MPC contract's derived_public_key view call
      if (p?.method_name === "derived_public_key") return { result: [...Buffer.from(JSON.stringify(REAL_KEY), "utf8")] };
      return null;
    };
    const evmRpcFake = async (method: string) => {
      if (method === "eth_getBalance") return "0x" + balance.toString(16);
      throw new Error(`unexpected ${method}`);
    };
    const s = createMnemosyneServer({
      dataDir: dir, seedPath: join(ROOT, "data/seed-memory.json"),
      payTo: "mnemosyne-gov.testnet", network: "near:testnet", asset: "NEAR",
      priceAmount: "1000000000000000000000", maxTimeoutSeconds: 300,
      facilitator: new MockFacilitator(dir), mockSettlement: true,
      inboundQuotes: {
        refundTo: "mnemosyne-gov.testnet",
        chainSig: { predecessor: "mnemosyne-gov.testnet", mpcContract: MPC_CONTRACT_TESTNET, nearRpc, evmRpc: evmRpcFake, priceWei: PRICE_WEI },
      },
      dashboardData: async () => ({ cycles: [] }),
    });
    await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
    close = () => s.server.close();
  });
  after(() => { close(); rmSync(dir, { recursive: true, force: true }); });

  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const getQuote = async (query = QUERY) => (await post("/memory/quote", { query, chain: "base-sepolia:ETH" })).body;

  it("quotes an address that the governor's NEAR account controls", async () => {
    const q = await getQuote();
    assert.equal(q.quote_only, false, "this one can actually be paid");
    assert.equal(q.source_chain, "base-sepolia");
    assert.equal(q.source_asset, "ETH");
    assert.equal(q.source_amount, PRICE_WEI);
    assert.equal(q.source_amount_display, "0.00001");
    assert.equal(q.deposit_address.toLowerCase(), REAL_ADDRESS);
    assert.equal(q.controlled_by, "mnemosyne-gov.testnet");
    assert.match(q.deposit_path, /^mnemosyne-check-Q-/);
    assert.match(q.explorer, /sepolia\.basescan\.org/);
  });

  it("no payment, no answer", async () => {
    balance = 0n;
    const q = await getQuote();
    const r = await post("/memory/check", { query: QUERY, quote_id: q.quote_id });
    assert.equal(r.status, 402);
    assert.match(r.body.error, /not paid yet/);
    assert.ok(!r.body.advice && !r.body.citation_id, "nothing of the answer leaks");
  });

  it("underpaying is not paying", async () => {
    const q = await getQuote();
    balance = BigInt(PRICE_WEI) - 1n;
    const r = await post("/memory/check", { query: QUERY, quote_id: q.quote_id });
    assert.equal(r.status, 402);
    assert.match(r.body.error, /not paid yet/);
  });

  it("paid in full: the answer comes back with a receipt naming the source chain", async () => {
    const q = await getQuote();
    balance = BigInt(PRICE_WEI);
    const r = await post("/memory/check", { query: QUERY, quote_id: q.quote_id });
    assert.equal(r.status, 200);
    assert.equal(r.body.match, true);
    assert.ok(r.body.receipt_id);

    const receipt: any = await (await fetch(`${base}/memory/receipt/${r.body.receipt_id}`)).json();
    assert.equal(receipt.source_chain, "base-sepolia");
    assert.equal(receipt.source_address.toLowerCase(), REAL_ADDRESS);
    assert.equal(receipt.source_controlled_by, "mnemosyne-gov.testnet");
    assert.equal(receipt.amount, PRICE_WEI);
    assert.equal(receipt.asset, "ETH");
    assert.equal(receipt.mock, false, "real money moved, on a real chain");
    assert.ok(!JSON.stringify(receipt).includes(QUERY), "the question is never stored");
  });

  it("a quote is single-use: the same payment cannot buy a second answer", async () => {
    const q = await getQuote();
    balance = BigInt(PRICE_WEI);
    assert.equal((await post("/memory/check", { query: QUERY, quote_id: q.quote_id })).status, 200);
    const again = await post("/memory/check", { query: QUERY, quote_id: q.quote_id });
    assert.equal(again.status, 402);
    assert.match(again.body.error, /already been used/);
  });

  it("a quote is bound to its question: the same payment cannot answer a different one", async () => {
    const q = await getQuote("something else entirely");
    balance = BigInt(PRICE_WEI);
    const r = await post("/memory/check", { query: QUERY, quote_id: q.quote_id });
    assert.equal(r.status, 402);
    assert.match(r.body.error, /different question/);
  });

  it("concurrent redemptions of one payment settle exactly once", async () => {
    const q = await getQuote();
    balance = BigInt(PRICE_WEI);
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => post("/memory/check", { query: QUERY, quote_id: q.quote_id })));
    assert.equal(results.filter((r) => r.status === 200).length, 1, "exactly one answer for one payment");
    for (const r of results.filter((x) => x.status !== 200)) assert.equal(r.status, 402);
  });

  it("an unknown quote id buys nothing", async () => {
    const r = await post("/memory/check", { query: QUERY, quote_id: "Q-deadbeefdeadbeefdead" });
    assert.equal(r.status, 402);
    assert.match(r.body.error, /no such quote/);
  });

  it("a Base Sepolia node that cannot be read refuses the check, never releases it", async () => {
    // the failure mode that matters: an unreadable chain must not read as paid
    const d2 = mkdtempSync(join(tmpdir(), "mnemo-csig-down-"));
    const s2 = createMnemosyneServer({
      dataDir: d2, seedPath: join(ROOT, "data/seed-memory.json"),
      payTo: "mnemosyne-gov.testnet", network: "near:testnet", asset: "NEAR",
      priceAmount: "1000000000000000000000", maxTimeoutSeconds: 300,
      facilitator: new MockFacilitator(d2), mockSettlement: true,
      inboundQuotes: {
        refundTo: "mnemosyne-gov.testnet",
        chainSig: {
          predecessor: "mnemosyne-gov.testnet", mpcContract: MPC_CONTRACT_TESTNET,
          nearRpc: async (_m: string, p: any) => (p?.method_name === "derived_public_key" ? { result: [...Buffer.from(JSON.stringify(REAL_KEY), "utf8")] } : null),
          evmRpc: async () => { throw new Error("ECONNREFUSED"); },
          priceWei: PRICE_WEI,
        },
      },
      dashboardData: async () => ({ cycles: [] }),
    });
    await new Promise<void>((r) => s2.server.listen(0, "127.0.0.1", () => r()));
    const b2 = `http://127.0.0.1:${(s2.server.address() as AddressInfo).port}`;
    try {
      const q: any = await (await fetch(`${b2}/memory/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: QUERY, chain: "base-sepolia:ETH" }) })).json();
      const r = await fetch(`${b2}/memory/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: QUERY, quote_id: q.quote_id }) });
      assert.equal(r.status, 402);
      assert.match((await r.json() as any).error, /could not check the payment/);
    } finally { s2.server.close(); rmSync(d2, { recursive: true, force: true }); }
  });

  it("the desk is offered both routes, and told which can be paid", async () => {
    const d: any = await (await fetch(`${base}/dashboard.json`)).json();
    const keys = d.x402.chains.map((c: any) => c.key);
    assert.deepEqual(keys, ["near", "base:USDC", "base-sepolia:ETH"]);
    assert.equal(d.x402.chains.find((c: any) => c.key === "base-sepolia:ETH").quote_only, false);
    assert.equal(d.x402.chains.find((c: any) => c.key === "base:USDC").quote_only, true);
  });
});

describe("a server with no payable route", () => {
  it("refuses a quote id outright rather than pretending to check it", async () => {
    const d = mkdtempSync(join(tmpdir(), "mnemo-csig-off-"));
    const s = createMnemosyneServer({
      dataDir: d, seedPath: join(ROOT, "data/seed-memory.json"),
      payTo: "mnemosyne-gov.testnet", network: "near:testnet", asset: "NEAR",
      priceAmount: "1000000000000000000000", maxTimeoutSeconds: 300,
      facilitator: new MockFacilitator(d), mockSettlement: true,
      dashboardData: async () => ({ cycles: [] }),
    });
    await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", () => r()));
    const b = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
    try {
      const r = await fetch(`${b}/memory/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: QUERY, quote_id: "Q-whatever" }) });
      assert.equal(r.status, 402);
      assert.match((await r.json() as any).error, /does not take payment from another chain/);
    } finally { s.server.close(); rmSync(d, { recursive: true, force: true }); }
  });
});
