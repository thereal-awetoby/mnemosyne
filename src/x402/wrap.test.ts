/**
 * What a payer holds, and what wrapping would cost them.
 *
 * This decides whether someone is asked to sign one transaction or two, and
 * for how much, so the arithmetic is worth pinning down: an amount that is
 * too low leaves the payment to fail at settlement (the exact failure this
 * step exists to prevent), and one that is too high quietly converts more of
 * someone's NEAR than the check needs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nearRpc, readPayerStatus, isAccountId } from "./wrap.js";

const NEAR = 1_000_000_000_000_000_000_000_000n; // 1 NEAR in yocto
const PRICE = NEAR / 1000n;                      // 0.001, the documented default
const STORAGE_MIN = 1_250_000_000_000_000_000_000n;
const ASSET = "wrap.testnet";

/** A NEAR RPC that answers from a fixed picture of the chain. */
function fakeRpc(chain: {
  amount?: bigint;
  storageUsage?: number;
  wnear?: bigint | null;
  storage?: unknown;
  bounds?: { min: string };
}) {
  const encode = (v: unknown) => ({ result: [...Buffer.from(JSON.stringify(v), "utf8")] });
  return async (_method: string, params: any) => {
    if (params.request_type === "view_account") {
      if (chain.amount === undefined) return null; // account does not exist
      return { amount: chain.amount.toString(), storage_usage: chain.storageUsage ?? 0 };
    }
    if (params.request_type === "call_function") {
      if (params.method_name === "ft_balance_of") return chain.wnear === null ? null : encode((chain.wnear ?? 0n).toString());
      if (params.method_name === "storage_balance_of") return encode(chain.storage ?? null);
      if (params.method_name === "storage_balance_bounds") return encode(chain.bounds ?? { min: STORAGE_MIN.toString(), max: null });
    }
    return null;
  };
}

const status = (chain: Parameters<typeof fakeRpc>[0]) =>
  readPayerStatus({ rpc: fakeRpc(chain), accountId: "payer.testnet", asset: ASSET, price: PRICE });

describe("what the payer holds", () => {
  it("already holds enough wNEAR: nothing to wrap, one signature", async () => {
    const s = await status({ amount: 5n * NEAR, wnear: PRICE, storage: { total: "1", available: "0" } });
    assert.equal(s.enough, true);
    assert.equal(s.short_by, "0");
    assert.equal(s.wrap_total, "0");
    assert.equal(s.registered, true);
    assert.equal(s.can_wrap, true);
  });

  it("faucet NEAR only: wraps exactly the price, plus registration the first time", async () => {
    // the case this whole step exists for -- a testnet faucet pays out native
    // NEAR, and the price is in wNEAR, so nothing can be paid without this
    const s = await status({ amount: 5n * NEAR, wnear: 0n, storage: null });
    assert.equal(s.enough, false);
    assert.equal(s.registered, false);
    assert.equal(s.short_by, PRICE.toString());
    assert.equal(s.storage_deposit, STORAGE_MIN.toString());
    assert.equal(s.wrap_total, (PRICE + STORAGE_MIN).toString(), "the shortfall AND the one-time storage deposit");
    assert.equal(s.can_wrap, true);
  });

  it("already registered, just short: wraps the shortfall only, never the whole price again", async () => {
    const held = PRICE / 4n;
    const s = await status({ amount: 5n * NEAR, wnear: held, storage: { total: "1", available: "0" } });
    assert.equal(s.short_by, (PRICE - held).toString());
    assert.equal(s.wrap_total, (PRICE - held).toString(), "no second storage deposit once registered");
  });

  it("not enough native NEAR to wrap with: says so instead of proposing a doomed transaction", async () => {
    const s = await status({ amount: PRICE, wnear: 0n, storage: null });
    assert.equal(s.enough, false);
    assert.equal(s.can_wrap, false, "wrapping would leave nothing for NEAR's own fees");
  });

  it("leaves a buffer: a balance that only just covers the wrap still cannot wrap", async () => {
    // exactly wrap_total and not a yocto more -- gas has to come from somewhere
    const s = await status({ amount: PRICE + STORAGE_MIN, wnear: 0n, storage: null });
    assert.equal(s.can_wrap, false);
  });

  it("an account's own storage is reserved, not spendable", async () => {
    // 10,000 bytes of state = 0.1 NEAR locked; it must not be offered for wrapping
    const s = await status({ amount: 1n * NEAR, storageUsage: 10_000, wnear: 0n, storage: null });
    assert.equal(s.native, (1n * NEAR - 100_000_000_000_000_000_000_000n).toString());
  });

  it("an account that does not exist reads as empty, and never throws", async () => {
    const s = await status({ wnear: null, storage: null });
    assert.equal(s.native, "0");
    assert.equal(s.wnear, "0");
    assert.equal(s.enough, false);
    assert.equal(s.can_wrap, false);
  });

  it("an unreachable RPC is reported as empty rather than as free money", async () => {
    const s = await readPayerStatus({
      rpc: async () => { throw new Error("network down"); },
      accountId: "payer.testnet", asset: ASSET, price: PRICE,
    });
    assert.equal(s.wnear, "0");
    assert.equal(s.enough, false, "never claim a payment can go ahead on no evidence");
  });

  it("carries the price and asset it judged against, so the page cannot drift from the server", async () => {
    const s = await status({ amount: 5n * NEAR, wnear: 0n, storage: null });
    assert.equal(s.price, PRICE.toString());
    assert.equal(s.asset, ASSET);
    assert.equal(s.account_id, "payer.testnet");
  });
});

describe("the RPC caller", () => {
  it("returns the result, and null for an error answer or a bad status", async () => {
    const ok = nearRpc("http://rpc.invalid", (async () => new Response(JSON.stringify({ result: { amount: "1" } }), { status: 200 })) as unknown as typeof fetch);
    assert.deepEqual(await ok("query", {}), { amount: "1" });

    const err = nearRpc("http://rpc.invalid", (async () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 200 })) as unknown as typeof fetch);
    assert.equal(await err("query", {}), null);

    const down = nearRpc("http://rpc.invalid", (async () => new Response("", { status: 503 })) as unknown as typeof fetch);
    assert.equal(await down("query", {}), null);
  });
});

describe("account ids", () => {
  it("accepts real ids and refuses anything that isn't one", () => {
    for (const good of ["payer.testnet", "a-b_c.near", "ab"]) assert.ok(isAccountId(good), good);
    for (const bad of ["", "a", "UPPER.testnet", "has space", "x".repeat(65), "semi;colon"]) assert.ok(!isAccountId(bad), String(bad));
  });
});
