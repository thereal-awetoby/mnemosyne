/**
 * Per-user accounts for Mnemosyne: NEAR wallet login, sign-up, sessions and
 * personal guardrails.
 *
 * THE RULE: login is identity plus personal policy. It is never root.
 * Nothing in src/auth imports the governor, the cycle, the allocation rails or
 * the cross-chain rail, and a test keeps it that way. A signed-in person can
 * only (1) prove which NEAR account is theirs, (2) keep a small profile, and
 * (3) set limits for payments made FROM THEIR OWN ACCOUNT to the paid memory
 * API. They can never lower the owner's protocol limits' hard bounds, never
 * raise their own above them, and never touch the operator's admin routes.
 *
 * State: users.json (profiles + guardrails) and sessions.json (only a sha256 of
 * each session token), both in DATA_DIR with atomic writes.
 */

import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { JsonStore } from "../x402/jsonStore.js";
import { fullAccessKeyOnAccount, isAccountId, type KeyCheck } from "./accounts.js";
import { verifyNep413 } from "./nep413.js";

// ------------------------------------------------------------------ limits

/** Hard bounds in code. A person can choose anything inside them, never outside. */
export const PROTOCOL = {
  max_queries_per_day: { min: 0, max: 1000, default: 50 },
  /** yoctoNEAR; 1 wNEAR = 1e24 */
  max_spend_per_day: { min: 0n, max: 10n ** 24n, default: 5n * 10n ** 22n },
} as const;

export interface Guardrails {
  /** kill switch: nothing paid from this account is accepted while true */
  pause_all: boolean;
  max_queries_per_day: number;
  /** yoctoNEAR as a decimal string */
  max_spend_per_day: string;
}

export interface UserProfile {
  account_id: string;
  display_name: string | null;
  created_at: string;
  last_login_at: string;
  guardrails: Guardrails;
  updated_at: string;
  /** the last 20 changes, newest first; who changed what */
  history: { at: string; by: string; change: string }[];
}

export const defaultGuardrails = (): Guardrails => ({
  pause_all: false,
  max_queries_per_day: PROTOCOL.max_queries_per_day.default,
  max_spend_per_day: PROTOCOL.max_spend_per_day.default.toString(),
});

export type GuardrailResult = { ok: true; guardrails: Guardrails; changes: string[] } | { ok: false; errors: string[] };

const GUARD_KEYS = ["pause_all", "max_queries_per_day", "max_spend_per_day"];
const fmtWnear = (yocto: bigint) => `${Number(yocto / 10n ** 18n) / 1e6} wNEAR`;

/** Strict: unknown keys, wrong types and anything outside the protocol bounds are errors. */
export function validateGuardrails(patch: unknown, base: Guardrails): GuardrailResult {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, errors: ["send an object of guardrails to change"] };
  const errors: string[] = [];
  const next: Guardrails = { ...base };
  const changes: string[] = [];
  const p = patch as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!GUARD_KEYS.includes(k)) errors.push(`unknown guardrail "${k}"`);
  if (Object.keys(p).length === 0) errors.push("nothing to change");

  if ("pause_all" in p) {
    if (typeof p.pause_all !== "boolean") errors.push("pause_all must be true or false");
    else if (p.pause_all !== base.pause_all) { next.pause_all = p.pause_all; changes.push(`pause ${p.pause_all ? "on" : "off"}`); }
  }
  if ("max_queries_per_day" in p) {
    const v = p.max_queries_per_day;
    const b = PROTOCOL.max_queries_per_day;
    if (typeof v !== "number" || !Number.isInteger(v)) errors.push("max_queries_per_day must be a whole number");
    else if (v < b.min) errors.push(`max_queries_per_day cannot be below ${b.min}`);
    else if (v > b.max) errors.push(`max_queries_per_day cannot be above the protocol limit of ${b.max}`);
    else if (v !== base.max_queries_per_day) { next.max_queries_per_day = v; changes.push(`queries per day ${base.max_queries_per_day} -> ${v}`); }
  }
  if ("max_spend_per_day" in p) {
    const v = p.max_spend_per_day;
    const b = PROTOCOL.max_spend_per_day;
    if (typeof v !== "string" || !/^\d{1,30}$/.test(v)) errors.push("max_spend_per_day must be a whole number of yoctoNEAR, as a string");
    else {
      const n = BigInt(v);
      if (n < b.min) errors.push(`max_spend_per_day cannot be below ${b.min}`);
      else if (n > b.max) errors.push(`max_spend_per_day cannot be above the protocol limit of ${fmtWnear(b.max)}`);
      else if (n.toString() !== base.max_spend_per_day) { next.max_spend_per_day = n.toString(); changes.push(`spend per day ${fmtWnear(BigInt(base.max_spend_per_day))} -> ${fmtWnear(n)}`); }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, guardrails: next, changes };
}

export function validateDisplayName(v: unknown): { ok: true; name: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null || v === "") return { ok: true, name: null };
  if (typeof v !== "string") return { ok: false, error: "display_name must be text" };
  const name = v.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 32) return { ok: false, error: "display_name must be 2 to 32 characters" };
  if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) return { ok: false, error: "display_name may use letters, numbers, spaces and . _ - only" };
  return { ok: true, name };
}

// ------------------------------------------------------------------- stores

interface UsersFile { users: Record<string, UserProfile> }
interface SessionsFile { sessions: Record<string, { account_id: string; created_at: string; expires_at: string }> }
interface Challenge { message: string; recipient: string; expires: number }

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
const MAX_OPEN_CHALLENGES = 2000;
const MAX_USERS = 100_000;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export interface PaidCheck { at: string; amount: string }

export interface AuthOptions {
  dataDir: string;
  rpcUrl: string;
  /** every paid check made by this payer account (from the receipts) */
  paidChecks: (payer: string) => PaidCheck[];
  fetch?: typeof fetch;
  now?: () => number;
}

export interface Usage { queries: number; spend: string; window: "24h" }

export type AccessDecision = { ok: true } | { ok: false; status: 403 | 429; reason: string };

export class AuthService {
  private readonly users: JsonStore<UsersFile>;
  private readonly sessions: JsonStore<SessionsFile>;
  private readonly challenges = new Map<string, Challenge>();
  private readonly now: () => number;

  constructor(private readonly opts: AuthOptions) {
    this.users = new JsonStore<UsersFile>(join(opts.dataDir, "users.json"), () => ({ users: {} }));
    this.sessions = new JsonStore<SessionsFile>(join(opts.dataDir, "sessions.json"), () => ({ sessions: {} }));
    this.now = opts.now ?? Date.now;
  }

  // ---- login ---------------------------------------------------------

  /** A one-time challenge the wallet signs. `host` is bound into the text and used as the NEP-413 recipient. */
  challenge(host: string): { nonce: string; message: string; recipient: string; expires_at: string } {
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) || host.length > 100) throw new AuthError(400, "invalid host");
    const t = this.now();
    for (const [k, c] of this.challenges) if (c.expires <= t) this.challenges.delete(k);
    if (this.challenges.size >= MAX_OPEN_CHALLENGES) throw new AuthError(429, "too many sign-in attempts right now; try again in a minute");
    const nonce = randomBytes(32);
    const expires = t + CHALLENGE_TTL_MS;
    const message = [
      "Sign in to Mnemosyne",
      "This proves you control this NEAR account. It is not a transaction and costs nothing.",
      `Site: ${host}`,
      `Expires: ${new Date(expires).toISOString()}`,
    ].join("\n");
    const key = nonce.toString("base64");
    this.challenges.set(key, { message, recipient: host, expires });
    return { nonce: key, message, recipient: host, expires_at: new Date(expires).toISOString() };
  }

  /**
   * Check the signed challenge. The challenge is consumed on the first attempt,
   * right or wrong, so a signature can never be tried twice. The key must be a
   * FULL-ACCESS key of the account (see accounts.ts).
   */
  async verify(input: { account_id: unknown; public_key: unknown; signature: unknown; nonce: unknown }): Promise<{ token: string; account_id: string; signed_up: boolean }> {
    const { account_id, public_key, signature, nonce } = input;
    if (typeof nonce !== "string" || nonce.length > 60 || !/^[A-Za-z0-9+/]{43}=$/.test(nonce)) throw new AuthError(400, "bad nonce");
    const ch = this.challenges.get(nonce);
    this.challenges.delete(nonce);
    if (!ch) throw new AuthError(401, "that sign-in request is unknown or was already used; start again");
    if (ch.expires <= this.now()) throw new AuthError(401, "that sign-in request expired; start again");
    if (!isAccountId(account_id)) throw new AuthError(400, "that is not a valid NEAR account id");
    if (typeof public_key !== "string") throw new AuthError(400, "public_key is required");

    const ok = verifyNep413({ message: ch.message, nonce: Buffer.from(nonce, "base64"), recipient: ch.recipient }, public_key, signature);
    if (!ok) throw new AuthError(401, "the signature does not match; sign the message your wallet shows");
    const key: KeyCheck = await fullAccessKeyOnAccount(account_id, public_key, { rpcUrl: this.opts.rpcUrl, fetch: this.opts.fetch });
    if (!key.ok) throw new AuthError(401, key.reason ?? "could not confirm the key");

    const token = randomBytes(32).toString("base64url");
    const t = this.now();
    this.sessions.update((s) => {
      for (const [h, v] of Object.entries(s.sessions)) if (Date.parse(v.expires_at) <= t) delete s.sessions[h];
      s.sessions[hashToken(token)] = { account_id, created_at: new Date(t).toISOString(), expires_at: new Date(t + SESSION_TTL_MS).toISOString() };
    });
    const profile = this.users.get().users[account_id];
    if (profile) this.users.update((u) => { u.users[account_id].last_login_at = new Date(t).toISOString(); });
    return { token, account_id, signed_up: !!profile };
  }

  /** The account a session token belongs to, or null (unknown, expired, or malformed). */
  sessionAccount(token: string | undefined): string | null {
    if (!token || token.length > 100 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const s = this.sessions.get().sessions[hashToken(token)];
    if (!s || Date.parse(s.expires_at) <= this.now()) return null;
    return s.account_id;
  }

  logout(token: string | undefined): void {
    if (!token) return;
    const h = hashToken(token);
    if (this.sessions.get().sessions[h]) this.sessions.update((s) => { delete s.sessions[h]; });
  }

  // ---- sign-up and profile ------------------------------------------

  profile(account: string): UserProfile | null {
    return this.users.get().users[account] ?? null;
  }

  /** Sign-up: the first time a verified account asks for a profile. It must accept that login is not root. */
  signUp(account: string, input: { display_name?: unknown; accepted?: unknown }): UserProfile {
    if (this.profile(account)) throw new AuthError(409, "this account already has a profile");
    if (input.accepted !== true) throw new AuthError(400, "please confirm that signing in gives access to your own settings only, never to the governor or to any capital");
    const name = validateDisplayName(input.display_name);
    if (!name.ok) throw new AuthError(400, name.error);
    if (Object.keys(this.users.get().users).length >= MAX_USERS) throw new AuthError(503, "sign-ups are full");
    const at = new Date(this.now()).toISOString();
    const p: UserProfile = {
      account_id: account, display_name: name.name, created_at: at, last_login_at: at, updated_at: at,
      guardrails: defaultGuardrails(), history: [{ at, by: account, change: "signed up with default guardrails" }],
    };
    this.users.update((u) => { u.users[account] = p; });
    return p;
  }

  updateProfile(account: string, input: { display_name?: unknown }): UserProfile {
    const cur = this.profile(account);
    if (!cur) throw new AuthError(403, "sign up first");
    const name = validateDisplayName(input.display_name);
    if (!name.ok) throw new AuthError(400, name.error);
    const at = new Date(this.now()).toISOString();
    this.users.update((u) => {
      const p = u.users[account];
      p.display_name = name.name; p.updated_at = at;
      p.history = [{ at, by: account, change: "display name changed" }, ...p.history].slice(0, 20);
    });
    return this.profile(account)!;
  }

  updateGuardrails(account: string, patch: unknown): { ok: true; profile: UserProfile } | { ok: false; errors: string[] } {
    const cur = this.profile(account);
    if (!cur) throw new AuthError(403, "sign up first");
    const r = validateGuardrails(patch, cur.guardrails);
    if (!r.ok) return r;
    if (r.changes.length === 0) return { ok: true, profile: cur };
    const at = new Date(this.now()).toISOString();
    this.users.update((u) => {
      const p = u.users[account];
      p.guardrails = r.guardrails; p.updated_at = at;
      p.history = [{ at, by: account, change: r.changes.join("; ") }, ...p.history].slice(0, 20);
    });
    return { ok: true, profile: this.profile(account)! };
  }

  /** Remove the profile and every session of the account. Receipts stay (they are the API's audit trail). */
  deleteAccount(account: string): void {
    if (this.profile(account)) this.users.update((u) => { delete u.users[account]; });
    this.sessions.update((s) => { for (const [h, v] of Object.entries(s.sessions)) if (v.account_id === account) delete s.sessions[h]; });
  }

  // ---- limits in force ------------------------------------------------

  usage(account: string): Usage {
    const since = this.now() - 24 * 3600_000;
    let queries = 0;
    let spend = 0n;
    for (const c of this.opts.paidChecks(account)) {
      if (Date.parse(c.at) >= since) { queries++; try { spend += BigInt(c.amount); } catch { /* ignore a malformed amount */ } }
    }
    return { queries, spend: spend.toString(), window: "24h" };
  }

  /**
   * May this account make (and pay for) one more check at `price` yocto?
   * An account with no profile is unaffected: guardrails are opt-in by signing
   * up. Called before the 402 for a signed-in browser session, and again for the
   * verified payer before anything is settled.
   */
  access(account: string, price: bigint): AccessDecision {
    const p = this.profile(account);
    if (!p) return { ok: true };
    const g = p.guardrails;
    if (g.pause_all) return { ok: false, status: 403, reason: `payments from ${account} are paused by its owner` };
    const u = this.usage(account);
    if (u.queries >= g.max_queries_per_day) return { ok: false, status: 429, reason: `${account} reached its limit of ${g.max_queries_per_day} paid checks in 24 hours` };
    if (BigInt(u.spend) + price > BigInt(g.max_spend_per_day)) return { ok: false, status: 429, reason: `${account} would go over its spend limit of ${fmtWnear(BigInt(g.max_spend_per_day))} in 24 hours` };
    return { ok: true };
  }

  userCount(): number {
    return Object.keys(this.users.get().users).length;
  }
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
