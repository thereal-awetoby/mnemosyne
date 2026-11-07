/**
 * The little bit of EVM this server needs: has an address been paid yet?
 *
 * Deliberately small. Each quote gets an address of its own (see chainsig.ts),
 * so "was this quote paid?" is "does that address hold at least the quoted
 * amount?" -- one `eth_getBalance` call. No log scanning, no ERC-20 decimals
 * to get wrong, no token contract address to mistype, and no way for one
 * payment to be counted against two quotes.
 */

export type EvmRpc = (method: string, params: unknown[]) => Promise<any>;

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
export const BASE_SEPOLIA_EXPLORER = "https://sepolia.basescan.org";

export function evmRpc(url: string, doFetch: typeof fetch = fetch, timeoutMs = 15_000): EvmRpc {
  let id = 0;
  return async (method, params) => {
    const r = await doFetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!r.ok) throw new Error(`the Base Sepolia node answered ${r.status}`);
    const j: any = await r.json();
    if (j?.error) throw new Error(`the Base Sepolia node refused the call: ${String(j.error.message ?? "").slice(0, 120)}`);
    return j?.result;
  };
}

const hexToBig = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error("the node returned a balance that is not a hex quantity");
  return BigInt(v === "0x" ? "0x0" : v);
};

/** Confirmed balance in wei. `latest` and not `pending`: an answer must not be
 *  released against a transaction that has not actually landed. */
export async function balanceOf(rpc: EvmRpc, address: string): Promise<bigint> {
  return hexToBig(await rpc("eth_getBalance", [address, "latest"]));
}

/** wei -> a plain decimal string of ETH, without floating point. */
export function fromWei(wei: string | bigint, decimals = 18): string {
  const v = BigInt(wei);
  const d = BigInt(10) ** BigInt(decimals);
  const whole = v / d;
  const frac = (v % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
