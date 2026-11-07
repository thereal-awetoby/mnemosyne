/**
 * NEAR Chain Signatures: an address on another chain that this NEAR account
 * controls, used here to receive an inbound payment for a memory check.
 *
 * Why this and not a bridge. NEAR Intents / 1Click has no testnet and says it
 * never will, and Omni Bridge's testnet EVM->NEAR path is openly broken
 * (wrong decimals, funds credited to the bridge account, no refund path). So
 * there is no honest way to *bridge* a testnet payment to NEAR. Chain
 * Signatures sidesteps the problem instead of fighting it: the payer sends on
 * Base Sepolia, and the governor receives on Base Sepolia, at an address only
 * its own NEAR account can ever spend from.
 *
 * The property this whole design rests on: a derived address is
 * deterministic, and RECEIVING at it costs nothing and needs no signature,
 * no transaction and no deployment. Only *spending* from it needs an MPC
 * `sign` call from the NEAR account. So a payment can be taken on another
 * chain with nothing deployed there at all.
 *
 * The derivation is not reimplemented here. The MPC contract exposes
 * `derived_public_key({predecessor, path})` as a view method, so the contract
 * that owns the key tells us the key. That is both simpler and safer than
 * re-deriving it locally: an epsilon-derivation bug would produce a
 * plausible-looking address that nobody can ever spend from.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58Decode } from "../nearTx.js";

/** The MPC signer on NEAR testnet. (`v1.signer.testnet` does not exist; this is the one.) */
export const MPC_CONTRACT_TESTNET = "v1.signer-prod.testnet";

export type NearRpc = (method: string, params: unknown) => Promise<any>;

/** One derivation path per quote, so each payment has an address of its own.
 *  That is what makes "has it been paid?" a plain balance question, and makes
 *  replaying a payment against a second quote impossible. */
export const depositPath = (quoteId: string) => `mnemosyne-check-${quoteId}`;

/**
 * The secp256k1 public key the MPC contract will sign with for
 * (predecessor, path). A view call: free, no gas, nothing on-chain changes.
 */
export async function derivedPublicKey(rpc: NearRpc, opts: { contract: string; predecessor: string; path: string }): Promise<string> {
  const r = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: opts.contract,
    method_name: "derived_public_key",
    args_base64: Buffer.from(JSON.stringify({ predecessor: opts.predecessor, path: opts.path })).toString("base64"),
  });
  if (!r || r.error || !Array.isArray(r.result)) throw new Error("the MPC contract did not return a derived key");
  const text = Buffer.from(r.result, "base64").toString("utf8");
  let key: unknown;
  try { key = JSON.parse(text); } catch { throw new Error("the MPC contract returned an unreadable key"); }
  if (typeof key !== "string" || !key.startsWith("secp256k1:")) throw new Error(`expected a secp256k1 key, got ${String(key).slice(0, 40)}`);
  return key;
}

/**
 * EVM address for a NEAR-format secp256k1 key: keccak256 of the 64-byte
 * uncompressed point (without its 0x04 prefix), last 20 bytes, EIP-55 cased.
 */
export function evmAddress(nearPublicKey: string): string {
  const [curve, encoded] = nearPublicKey.split(":");
  if (curve !== "secp256k1" || !encoded) throw new Error("not a secp256k1 public key");
  let raw = base58Decode(encoded);
  // NEAR stores the 64-byte point; tolerate a leading 0x04 if one ever appears
  if (raw.length === 65 && raw[0] === 4) raw = raw.subarray(1);
  if (raw.length !== 64) throw new Error(`expected a 64-byte public key, got ${raw.length}`);
  return toChecksumAddress(Buffer.from(keccak_256(raw).slice(-20)).toString("hex"));
}

/** EIP-55 mixed-case checksum, so a wrong character is visible rather than silent. */
export function toChecksumAddress(hex20: string): string {
  const lower = hex20.replace(/^0x/, "").toLowerCase();
  const hash = Buffer.from(keccak_256(Buffer.from(lower, "utf8"))).toString("hex");
  let out = "0x";
  for (let i = 0; i < lower.length; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/** Address on the source chain that one quote is to be paid at. */
export async function depositAddressFor(rpc: NearRpc, opts: { contract: string; predecessor: string; quoteId: string }): Promise<{ address: string; path: string; public_key: string }> {
  const path = depositPath(opts.quoteId);
  const public_key = await derivedPublicKey(rpc, { contract: opts.contract, predecessor: opts.predecessor, path });
  return { address: evmAddress(public_key), path, public_key };
}
