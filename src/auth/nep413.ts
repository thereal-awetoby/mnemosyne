/**
 * NEP-413 "sign a message" verification: how a NEAR wallet proves, without a
 * transaction and without any cost, that the person logging in holds the key.
 *
 * The wallet signs sha256( borsh(tag) ++ borsh(payload) ) with ed25519, where
 *   tag     = 2^31 + 413 = 2147484061 as a u32
 *   payload = { message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string> }
 * Borsh: integers little-endian, a string is a u32 byte length then UTF-8,
 * an Option is 0x00 (none) or 0x01 followed by the value.
 *
 * Whether the key belongs to the account is a separate question (accounts.ts).
 * No private key is ever handled here: this file only verifies.
 */

import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Decode, base58Encode } from "../nearTx.js";

export const NEP413_TAG = 2147484061;

export interface Nep413Payload {
  message: string;
  /** exactly 32 bytes */
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string | null;
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const str = (s: string): Buffer => {
  const body = Buffer.from(s, "utf8");
  return Buffer.concat([u32(body.length), body]);
};

/** The exact bytes the wallet hashes and signs. */
export function nep413Preimage(p: Nep413Payload): Buffer {
  if (p.nonce.length !== 32) throw new Error("nonce must be exactly 32 bytes");
  return Buffer.concat([
    u32(NEP413_TAG),
    str(p.message),
    Buffer.from(p.nonce),
    str(p.recipient),
    p.callbackUrl ? Buffer.concat([Buffer.from([1]), str(p.callbackUrl)]) : Buffer.from([0]),
  ]);
}

export const nep413Hash = (p: Nep413Payload): Buffer => createHash("sha256").update(nep413Preimage(p)).digest();

/** "ed25519:<base58>" -> 32 raw bytes. Anything else is refused. */
export function parsePublicKey(key: string): Uint8Array {
  if (typeof key !== "string" || !key.startsWith("ed25519:")) throw new Error('public key must start with "ed25519:"');
  let raw: Buffer;
  try { raw = base58Decode(key.slice("ed25519:".length)); } catch { throw new Error("public key is not valid base58"); }
  if (raw.length !== 32) throw new Error(`public key decodes to ${raw.length} bytes, expected 32`);
  return new Uint8Array(raw);
}

export const formatPublicKey = (raw: Uint8Array): string => "ed25519:" + base58Encode(raw);

/** Wallets differ: base64, base64url, or "ed25519:<base58>". All mean the same 64 bytes. */
export function parseSignature(sig: unknown): Uint8Array {
  if (typeof sig !== "string" || sig.length === 0 || sig.length > 200) throw new Error("signature must be a short string");
  let raw: Buffer;
  if (sig.startsWith("ed25519:")) {
    try { raw = base58Decode(sig.slice("ed25519:".length)); } catch { throw new Error("signature is not valid base58"); }
  } else {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(sig)) throw new Error("signature is not valid base64");
    raw = Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  }
  if (raw.length !== 64) throw new Error(`signature decodes to ${raw.length} bytes, expected 64`);
  return new Uint8Array(raw);
}

/** True only if `signature` is a valid ed25519 signature by `publicKey` over this exact payload. Never throws. */
export function verifyNep413(p: Nep413Payload, publicKey: string, signature: unknown): boolean {
  try {
    return ed25519.verify(parseSignature(signature), new Uint8Array(nep413Hash(p)), parsePublicKey(publicKey));
  } catch {
    return false;
  }
}
