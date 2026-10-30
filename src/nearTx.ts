/**
 * Small helpers shared by memory.ts and report.ts.
 *
 * Why txFailure() exists: a NEAR transaction can be *accepted and executed*
 * yet still fail (e.g. the contract panics with "chain broken"). Depending on
 * the near-api-js version / waitUntil level, that may come back as a normal
 * result whose `status` is `{ Failure: ... }` rather than as a thrown error.
 * The memory gate is fail-closed, so "no exception" must never be read as
 * "committed" -- we check the outcome explicitly.
 */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  let z = 0;
  while (z < bytes.length && bytes[z] === 0) z++;
  return "1".repeat(z) + out;
}

export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character "${c}"`);
    n = n * 58n + BigInt(i);
  }
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let z = 0;
  while (s[z] === "1") z++;
  return Buffer.concat([Buffer.alloc(z), Buffer.from(hex, "hex")]);
}

/** Public key for a NEAR "ed25519:<b58 seed||pub>" secret key, without any
 *  library call -- the last 32 bytes ARE the public key. Lets the user match
 *  the key in .env against `near account list-keys` output. */
export function publicKeyFromSecret(secretKey: string): string {
  if (!secretKey.startsWith("ed25519:")) throw new Error('secret key must start with "ed25519:"');
  const raw = base58Decode(secretKey.slice("ed25519:".length));
  if (raw.length !== 64) throw new Error(`secret key decodes to ${raw.length} bytes, expected 64`);
  return "ed25519:" + base58Encode(raw.subarray(32));
}

/** Returns a failure description if the execution outcome failed, else null. */
export function txFailure(res: any): string | null {
  if (!res || typeof res !== "object") return null;
  const status = res.status;
  if (status && typeof status === "object" && "Failure" in status) {
    return "transaction failed: " + JSON.stringify(status.Failure);
  }
  const receipts: any[] = Array.isArray(res.receipts_outcome) ? res.receipts_outcome : [];
  for (const r of receipts) {
    const s = r?.outcome?.status;
    if (s && typeof s === "object" && "Failure" in s) {
      return "receipt failed: " + JSON.stringify(s.Failure);
    }
  }
  return null;
}

export function txHashOf(res: any): string | undefined {
  return res?.transaction?.hash ?? res?.transaction_outcome?.id;
}

/** All log lines emitted by the transaction's receipts. */
export function txLogs(res: any): string[] {
  const receipts: any[] = Array.isArray(res?.receipts_outcome) ? res.receipts_outcome : [];
  return receipts.flatMap((r) => (Array.isArray(r?.outcome?.logs) ? r.outcome.logs : []));
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a character.
 *  The contract rejects reason strings over 200 bytes. */
export function clampUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let out = "";
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, "utf8") > maxBytes) break;
    out += ch;
  }
  return out;
}
