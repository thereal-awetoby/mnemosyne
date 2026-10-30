/**
 * Ed25519 helpers using NEAR key formats, on node:crypto only (no deps).
 *
 *   public key  "ed25519:" + base58(32 bytes)
 *   secret key  "ed25519:" + base58(seed32 || pub32)   (near-api-js layout)
 *
 * NEAR implicit accounts: the account id IS hex(public key), 64 lowercase hex
 * chars. That lets the facilitator prove "this key belongs to the payer
 * account" offline, with no RPC, for implicit-account payers.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { base58Decode, base58Encode } from "../nearTx.js";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function decodeKey(s: string, expectedLen: number, what: string): Buffer {
  if (!s.startsWith("ed25519:")) throw new Error(`${what} must start with "ed25519:"`);
  const raw = base58Decode(s.slice("ed25519:".length));
  if (raw.length !== expectedLen) throw new Error(`${what} decodes to ${raw.length} bytes, expected ${expectedLen}`);
  return raw;
}

export function publicKeyBytes(publicKey: string): Buffer {
  return decodeKey(publicKey, 32, "public key");
}

export function publicKeyOfSecret(secretKey: string): string {
  return "ed25519:" + base58Encode(decodeKey(secretKey, 64, "secret key").subarray(32));
}

export function implicitAccountId(publicKey: string): string {
  return publicKeyBytes(publicKey).toString("hex");
}

export function isImplicitAccountId(id: string): boolean {
  return /^[0-9a-f]{64}$/.test(id);
}

export function signMessage(secretKey: string, message: Buffer): string {
  const raw = decodeKey(secretKey, 64, "secret key");
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, raw.subarray(0, 32)]),
    format: "der",
    type: "pkcs8",
  });
  return "ed25519:" + base58Encode(sign(null, message, key));
}

export function verifyMessage(publicKey: string, message: Buffer, signature: string): boolean {
  try {
    const sig = decodeKey(signature, 64, "signature");
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKeyBytes(publicKey).toString("base64url") },
      format: "jwk",
    });
    return verify(null, message, key, sig);
  } catch {
    return false;
  }
}

/** Deterministic JSON: object keys sorted recursively. Both sides must hash
 *  and sign exactly the same bytes, whatever order fields were written in. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
      .join(",") +
    "}"
  );
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function b64json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function fromB64json<T = unknown>(s: string): T {
  return JSON.parse(Buffer.from(s, "base64").toString("utf8")) as T;
}

/** Fresh NEAR-format ed25519 keypair (same layout near-api-js uses). */
export function generateNearKeyPair(): { publicKey: string; secretKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  return {
    publicKey: "ed25519:" + base58Encode(pub),
    secretKey: "ed25519:" + base58Encode(Buffer.concat([seed, pub])),
  };
}
