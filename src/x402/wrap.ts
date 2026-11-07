/**
 * What a payer actually holds, so /pay can offer to wrap before it asks for a payment.
 *
 * The x402 "exact" scheme on NEAR is a NEP-141 `ft_transfer` of wNEAR, but a
 * NEAR testnet faucet hands out *native* NEAR, which is not a NEP-141 token.
 * Someone who has only faucet NEAR therefore cannot pay, and the failure used
 * to surface as an opaque settlement error after they had already signed.
 *
 * The wrap cannot ride along inside the payment: @x402/near's verifier accepts
 * a delegate action only when it carries exactly one action (`actions.length
 * === 1` in its own code), so `near_deposit` + `ft_transfer` in one envelope is
 * refused. It has to be a separate, ordinary transaction the wallet signs
 * first. This module tells the page whether that step is needed, and for how
 * much, before anything is signed.
 *
 * Everything here is a read-only RPC view call against public on-chain state.
 */

/** Cost in yoctoNEAR of one byte of account storage on NEAR. */
const STORAGE_COST_PER_BYTE = 10_000_000_000_000_000_000n;
/** Left unwrapped for gas and the account's own storage, so wrapping can't strand an account. */
const NATIVE_BUFFER = 50_000_000_000_000_000_000_000n; // 0.05 NEAR

export interface PayerStatus {
  account_id: string;
  /** NEP-141 contract the price is denominated in, e.g. wrap.testnet */
  asset: string;
  /** price of one check, in the asset's smallest unit */
  price: string;
  /** spendable native NEAR (total, less what this account's own storage reserves) */
  native: string;
  /** wNEAR the payer holds now */
  wnear: string;
  /** false when the payer has never been registered for storage with the token */
  registered: boolean;
  /** the token's own minimum storage deposit, when registration is needed */
  storage_deposit: string;
  /** true when the payer already holds enough wNEAR and can pay right away */
  enough: boolean;
  /** how much more wNEAR is needed (0 when `enough`) */
  short_by: string;
  /** native NEAR this account would have to attach to cover the shortfall and, if needed, registration */
  wrap_total: string;
  /** false when even wrapping cannot get there: not enough native NEAR either */
  can_wrap: boolean;
}

export type Rpc = (method: string, params: unknown) => Promise<any>;

/** A JSON-RPC caller against one NEAR node. Returns the `result` object, or
 *  null for anything that isn't a clean answer -- callers here treat an
 *  unreachable node the same as an empty account rather than throwing. */
export function nearRpc(rpcUrl: string, doFetch: typeof fetch = fetch): Rpc {
  return async (method, params) => {
    const r = await doFetch(rpcUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "pay", method, params }),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return j?.error ? null : j?.result ?? null;
  };
}

/** One `call_function` view call, JSON in and JSON out. Null when the contract
 *  rejects the call (an unregistered account, a method that isn't there). */
async function view(rpc: Rpc, contract: string, method: string, args: unknown): Promise<any> {
  try {
    const r = await rpc("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (!r || r.error || !Array.isArray(r.result)) return null;
    const text = Buffer.from(r.result).toString("utf8");
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const big = (v: unknown): bigint => {
  try { return BigInt(String(v ?? "0")); } catch { return 0n; }
};

/**
 * Reads the payer's position against one price. Never throws for an account
 * that simply doesn't exist or holds nothing -- that reads as zero balances,
 * which is exactly what the page needs to say "you can't cover this yet".
 */
export async function readPayerStatus(opts: {
  rpc: Rpc;
  accountId: string;
  asset: string;
  price: bigint;
}): Promise<PayerStatus> {
  const { rpc, accountId, asset, price } = opts;

  const [account, balance, storage, bounds] = await Promise.all([
    rpc("query", { request_type: "view_account", finality: "final", account_id: accountId }).catch(() => null),
    view(rpc, asset, "ft_balance_of", { account_id: accountId }),
    view(rpc, asset, "storage_balance_of", { account_id: accountId }),
    view(rpc, asset, "storage_balance_bounds", {}),
  ]);

  // An account's own storage is reserved, not spendable; subtracting it keeps
  // the wrap offer from proposing an amount that would fail on-chain.
  const total = big(account?.amount);
  const reserved = big(account?.storage_usage) * STORAGE_COST_PER_BYTE;
  const native = total > reserved ? total - reserved : 0n;

  const wnear = big(balance);
  const registered = storage !== null && storage !== undefined;
  const storageDeposit = registered ? 0n : big(bounds?.min);

  const enough = wnear >= price;
  const shortBy = enough ? 0n : price - wnear;
  const wrapTotal = enough ? 0n : shortBy + storageDeposit;
  const canWrap = enough || native >= wrapTotal + NATIVE_BUFFER;

  return {
    account_id: accountId,
    asset,
    price: price.toString(),
    native: native.toString(),
    wnear: wnear.toString(),
    registered,
    storage_deposit: storageDeposit.toString(),
    enough,
    short_by: shortBy.toString(),
    wrap_total: wrapTotal.toString(),
    can_wrap: canWrap,
  };
}

/** A NEAR account id, as the RPC would accept it. */
export const isAccountId = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 2 && v.length <= 64 && /^[a-z0-9._-]+$/.test(v);
