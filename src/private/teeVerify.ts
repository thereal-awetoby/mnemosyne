/**
 * Verification of a NEAR AI Cloud private (TEE) completion.
 *
 * Five independent checks, each reported on its own so nothing is overclaimed:
 *
 *   1. hashes      sha256(exact request bytes) and sha256(exact response bytes)
 *                  equal the hashes inside the signed text
 *   2. signature   EIP-191 ECDSA signature over that text recovers to the
 *                  claimed signing_address, signature_kind = provider_tee
 *   3. binding     the Intel TDX quote's report_data = signing_address (padded)
 *                  || our fresh random nonce  -> that key lives in this TEE now
 *   4. tdx         the TDX quote verifies against Intel's collateral
 *                  (pure-JS @phala/dcap-qvl 0.7.0, includes the CVE-2026-22696 fix)
 *   5. gpu         NVIDIA NRAS says the GPU evidence is valid for our nonce,
 *                  and the NRAS token's ES384 signature checks against
 *                  NVIDIA's published JWKS
 *
 * Mirrors https://github.com/nearai/nearai-cloud-verifier, with the NRAS JWT
 * signature check added.
 */

import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export interface SignaturePayload {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: string | null;
}

export interface ModelAttestation {
  signing_address: string;
  intel_quote: string;
  nvidia_payload?: string;
  request_nonce?: string;
}

export const sha256Hex = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

/** Ethereum personal_sign recovery (EIP-191), as ethers.verifyMessage. */
export function recoverEip191Address(text: string, signatureHex: string): string {
  const msg = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const digest = keccak_256(new Uint8Array([...prefix, ...msg]));
  const raw = Buffer.from(signatureHex.replace(/^0x/i, ""), "hex");
  if (raw.length !== 65) throw new Error(`signature must be 65 bytes, got ${raw.length}`);
  let v = raw[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error(`bad recovery byte ${raw[64]}`);
  const pub = secp256k1.Signature.fromBytes(raw.subarray(0, 64), "compact").addRecoveryBit(v).recoverPublicKey(digest).toBytes(false);
  return "0x" + Buffer.from(keccak_256(pub.subarray(1)).subarray(12)).toString("hex");
}

export interface SignatureCheck {
  hashes_match: boolean;
  signature_valid: boolean;
  provider_tee: boolean;
  model_matches: boolean;
  request_hash: string;
  response_hash: string;
  signing_address: string;
}

/** Checks 1 + 2. `rawRequest`/`rawResponse` must be the exact bytes sent/received. */
export function checkSignature(sig: SignaturePayload, model: string, rawRequest: string, rawResponse: string): SignatureCheck {
  const request_hash = sha256Hex(rawRequest);
  const response_hash = sha256Hex(rawResponse);
  const parts = sig.text.split(":");
  // provider_tee format: "{model_id}:{request_hash}:{response_hash}" (model ids contain no ':')
  const [m, rq, rs] = parts.length === 3 ? parts : [null, parts[0], parts[1]];
  let recovered = "";
  try { recovered = recoverEip191Address(sig.text, sig.signature); } catch { /* invalid */ }
  return {
    hashes_match: rq === request_hash && rs === response_hash,
    signature_valid: recovered !== "" && recovered.toLowerCase() === sig.signing_address.toLowerCase(),
    provider_tee: sig.signature_kind === "provider_tee" && sig.signing_algo === "ecdsa",
    model_matches: m === model,
    request_hash,
    response_hash,
    signing_address: sig.signing_address.toLowerCase(),
  };
}

/** TDX quote v4: 48-byte header, then the TD report; report_data is the last
 *  64 bytes of the 584-byte TD10 report body. */
export function tdxReportData(quoteHex: string): Buffer {
  const q = Buffer.from(quoteHex, "hex");
  if (q.length < 48 + 584) throw new Error("quote too short");
  const version = q.readUInt16LE(0);
  const teeType = q.readUInt32LE(4);
  if (version !== 4 || teeType !== 0x81) throw new Error(`not a TDX v4 quote (version ${version}, tee ${teeType.toString(16)})`);
  return q.subarray(48 + 520, 48 + 584);
}

/** Check 3: the quote commits to this signing key and to our fresh nonce. */
export function checkBinding(att: ModelAttestation, nonceHex: string): { binds_address: boolean; binds_nonce: boolean } {
  const rd = tdxReportData(att.intel_quote);
  const addr = Buffer.from(att.signing_address.replace(/^0x/i, ""), "hex");
  const padded = Buffer.concat([addr, Buffer.alloc(32 - addr.length)]);
  return { binds_address: rd.subarray(0, 32).equals(padded), binds_nonce: rd.subarray(32, 64).toString("hex") === nonceHex.toLowerCase() };
}

export const INTEL_PCS = "https://api.trustedservices.intel.com";

/** Check 4: Intel DCAP verification of the TDX quote, using the pure-JS
 *  @phala/dcap-qvl >= 0.3.9. The WASM @phala/dcap-qvl-node is NOT used: it
 *  skips the QE Identity signature/policy check (CVE-2026-22696,
 *  GHSA-796p-j2gh-9m2q) and has no fixed release. Intel's root CA is pinned
 *  inside the library, so the collateral source needn't be trusted.
 *  "OutOfDate" still means the quote is cryptographically valid (platform
 *  TCB below Intel's latest advisory baseline); the status is recorded verbatim. */
export async function checkTdxQuote(quoteHex: string): Promise<{ verified: boolean; status: string }> {
  const { getCollateral, verify } = await import("@phala/dcap-qvl");
  const quote = Buffer.from(quoteHex, "hex");
  let collateral;
  try {
    collateral = await getCollateral(INTEL_PCS, quote);
  } catch (err) {
    return { verified: false, status: `collateral_unavailable: ${String((err as any)?.message ?? err)}` };
  }
  let r: any;
  try {
    r = verify(quote, collateral, Math.floor(Date.now() / 1000));
  } catch (err) {
    return { verified: false, status: `quote_invalid: ${String((err as any)?.message ?? err)}` };
  }
  const status = typeof r?.status === "string" ? r.status : "unknown";
  return { verified: status === "UpToDate" || status === "OutOfDate", status };
}

export const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
export const NRAS_JWKS = "https://nras.attestation.nvidia.com/.well-known/jwks.json";

const b64urlJson = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/** Verify an ES384 JWT against a JWKS (node:crypto, no deps). */
export function verifyEs384Jwt(token: string, jwks: { keys: any[] }): { valid: boolean; payload: any; reason?: string } {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return { valid: false, payload: null, reason: "malformed_jwt" };
  let header: any, payload: any;
  try {
    header = b64urlJson(h);
    payload = b64urlJson(p);
  } catch {
    return { valid: false, payload: null, reason: "malformed_jwt" };
  }
  if (header.alg !== "ES384") return { valid: false, payload, reason: `unexpected alg ${header.alg}` };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { valid: false, payload, reason: "kid_not_in_jwks" };
  let key;
  try {
    key = jwk.x5c?.length && !jwk.x
      ? createPublicKey(`-----BEGIN CERTIFICATE-----\n${jwk.x5c[0]}\n-----END CERTIFICATE-----`)
      : createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
  } catch (err) {
    return { valid: false, payload, reason: `bad_jwk: ${(err as Error).message}` };
  }
  const ok = nodeVerify("sha384", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return { valid: ok, payload, reason: ok ? undefined : "bad_signature" };
}

/** Check 5: NVIDIA GPU attestation via NRAS, token signature verified. */
export async function checkGpu(att: ModelAttestation, nonceHex: string): Promise<{ verdict: boolean; nonce_matches: boolean; token_signature_valid: boolean; reason?: string }> {
  if (!att.nvidia_payload) return { verdict: false, nonce_matches: false, token_signature_valid: false, reason: "no_nvidia_payload" };
  const payload = JSON.parse(att.nvidia_payload);
  const nonce_matches = String(payload.nonce).toLowerCase() === nonceHex.toLowerCase();
  const r = await fetch(NRAS_URL, { method: "POST", headers: { "content-type": "application/json" }, body: att.nvidia_payload, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) return { verdict: false, nonce_matches, token_signature_valid: false, reason: `nras_http_${r.status}` };
  const body: any = await r.json();
  const token: string = body?.[0]?.[1];
  const jwks: any = await (await fetch(NRAS_JWKS, { signal: AbortSignal.timeout(20_000) })).json();
  const v = verifyEs384Jwt(token, jwks);
  const claims = v.payload ?? {};
  return {
    verdict: claims["x-nvidia-overall-att-result"] === true && String(claims.eat_nonce ?? "").toLowerCase() === nonceHex.toLowerCase(),
    nonce_matches,
    token_signature_valid: v.valid,
    reason: v.reason,
  };
}
