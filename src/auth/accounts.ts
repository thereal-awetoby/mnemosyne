/**
 * Does this public key really control this NEAR account?
 *
 * A valid signature only proves someone holds *a* key. Login needs the key to
 * be a FULL-ACCESS key of the claimed account, because a function-call key
 * (for example one a dapp or one of Mnemosyne's report-only subs holds) must
 * never be able to log in as the account.
 *
 * Implicit accounts (64 hex characters = the public key) are controlled by
 * that key by definition, even before they exist on chain.
 */

import { parsePublicKey } from "./nep413.js";

/** NEAR account id rules: 2-64 chars, lowercase letters/digits, separators - _ . between parts. */
export const ACCOUNT_ID = /^(?=.{2,64}$)[a-z\d]+(?:[-_.][a-z\d]+)*$/;
export const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;

export const isAccountId = (s: unknown): s is string => typeof s === "string" && ACCOUNT_ID.test(s);

export interface KeyCheck {
  ok: boolean;
  /** why not, in words fit to show the person */
  reason?: string;
}

export interface KeyCheckOptions {
  rpcUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export async function fullAccessKeyOnAccount(accountId: string, publicKey: string, opts: KeyCheckOptions): Promise<KeyCheck> {
  if (!isAccountId(accountId)) return { ok: false, reason: "that is not a valid NEAR account id" };
  let raw: Uint8Array;
  try { raw = parsePublicKey(publicKey); } catch (e) { return { ok: false, reason: (e as Error).message }; }

  if (IMPLICIT_ACCOUNT.test(accountId)) {
    if (Buffer.from(raw).toString("hex") === accountId) return { ok: true };
    // an implicit account can also have had other keys added once it exists: fall through to the chain
  }

  const doFetch = opts.fetch ?? fetch;
  let json: any;
  try {
    const r = await doFetch(opts.rpcUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "login", method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } }),
    });
    if (!r.ok) return { ok: false, reason: `NEAR RPC answered ${r.status}; try again in a moment` };
    json = await r.json();
  } catch {
    return { ok: false, reason: "could not reach NEAR RPC to check the key; try again in a moment" };
  }
  if (json?.error || json?.result?.error) return { ok: false, reason: "that key is not on this account (this server is on NEAR testnet)" };
  const perm = json?.result?.permission;
  if (perm === "FullAccess") return { ok: true };
  if (perm && typeof perm === "object") return { ok: false, reason: "that is a limited (function-call) key; sign in with a full-access key of the account" };
  return { ok: false, reason: "could not confirm the key on that account" };
}
