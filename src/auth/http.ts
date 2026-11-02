/**
 * HTTP side of login and personal guardrails. Hooked into the main server by
 * createMnemosyneServer; nothing here can reach the operator's admin routes,
 * the governor, the cycle or any allocation rail.
 *
 *   GET    /login                  the sign-in / sign-up page (loads wallet code)
 *   GET    /login/near-connect.js  the wallet connector bundle (served from this server, not a CDN)
 *   GET    /pay                    pay for one memory check with your own connected wallet (also loads wallet
 *                                   code, via the same bundle; redirects to /login first if not signed in)
 *   POST   /auth/challenge         a one-time message for the wallet to sign
 *   POST   /auth/verify            the signed message -> a session cookie (HttpOnly, SameSite=Strict)
 *   POST   /auth/logout
 *   GET    /me                     who am I, my profile, my limits, my usage today
 *   POST   /me/signup              first time only: create the profile (default guardrails)
 *   PUT    /me                     change the display name
 *   PUT    /me/guardrails          change my own limits (inside the protocol's hard bounds)
 *   GET    /me/receipts            paid checks made from my account
 *   DELETE /me                     delete my profile and sessions
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import { HttpError, readJson, send } from "../http.js";
import { RateLimiter } from "./rateLimit.js";
import { AuthError, PROTOCOL, type AuthService } from "./service.js";

export const SESSION_COOKIE = "mn_session";

export interface ReceiptView {
  receipt_id: string; at: string; amount: string; match: boolean; citation_id: string | null;
  settlement: string; explorer: string | null; mock: boolean;
}

export interface AuthRoutesConfig {
  service: AuthService;
  /** pinned public origin, if the server has one */
  publicUrl?: string;
  /** price of one check in yoctoNEAR */
  price: () => bigint;
  receiptsFor: (payer: string, limit: number) => ReceiptView[];
  loginHtml?: string;
  loginScript?: Buffer;
  payHtml?: string;
  now?: () => number;
}

const LOGIN_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; " +
  // wallets load their own code and talk to their own servers, so this page (and only this page) may reach https
  "connect-src 'self' https:; frame-src https: blob: data:; child-src https: blob: data:; " +
  "img-src 'self' data: https:; font-src 'self' data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function createAuthRoutes(cfg: AuthRoutesConfig) {
  const { service } = cfg;
  const now = cfg.now ?? Date.now;
  const perIp = {
    challenge: new RateLimiter(30, 60_000, now),
    verify: new RateLimiter(20, 60_000, now),
    signup: new RateLimiter(10, 60_000, now),
  };
  const perAccount = new RateLimiter(30, 60_000, now);

  const ip = (req: IncomingMessage) => req.socket.remoteAddress ?? "unknown";
  const token = (req: IncomingMessage) => cookies(req)[SESSION_COOKIE];
  const sessionAccount = (req: IncomingMessage) => service.sessionAccount(token(req));
  const isHttps = (req: IncomingMessage) =>
    cfg.publicUrl ? cfg.publicUrl.startsWith("https:") : String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
  const hostOf = (req: IncomingMessage) => (cfg.publicUrl ? new URL(cfg.publicUrl).host : String(req.headers.host ?? ""));

  /** Browsers send Origin on cross-site writes: it must be this site. */
  function sameOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let h: string;
      try { h = new URL(String(origin)).host; } catch { throw new HttpError(403, "bad origin"); }
      if (h !== hostOf(req)) throw new HttpError(403, "cross-site request refused");
    }
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && !["same-origin", "none"].includes(String(site))) throw new HttpError(403, "cross-site request refused");
  }
  const jsonBody = (req: IncomingMessage) => {
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "send JSON (content-type: application/json)");
    return readJson(req);
  };
  const need = (req: IncomingMessage): string => {
    const a = sessionAccount(req);
    if (!a) throw new HttpError(401, "sign in first");
    return a;
  };
  const cookie = (req: IncomingMessage, value: string, maxAge: number) =>
    `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;

  function me(account: string) {
    const profile = service.profile(account);
    return {
      account_id: account,
      signed_up: !!profile,
      profile: profile && { display_name: profile.display_name, created_at: profile.created_at, last_login_at: profile.last_login_at, guardrails: profile.guardrails, history: profile.history },
      usage: service.usage(account),
      price: cfg.price().toString(),
      protocol: {
        max_queries_per_day: PROTOCOL.max_queries_per_day,
        max_spend_per_day: { min: PROTOCOL.max_spend_per_day.min.toString(), max: PROTOCOL.max_spend_per_day.max.toString(), default: PROTOCOL.max_spend_per_day.default.toString() },
      },
    };
  }

  /** Returns true if it answered the request. */
  async function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
    try {
      if (method === "GET" && path === "/login") {
        if (!cfg.loginHtml) throw new HttpError(404, "login page not configured");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": LOGIN_CSP });
        res.end(cfg.loginHtml);
        return true;
      }
      if (method === "GET" && path === "/login/near-connect.js") {
        if (!cfg.loginScript) throw new HttpError(404, "not found");
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" });
        res.end(cfg.loginScript);
        return true;
      }
      if (method === "GET" && path === "/pay") {
        if (!cfg.payHtml) throw new HttpError(404, "not configured");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": LOGIN_CSP });
        res.end(cfg.payHtml);
        return true;
      }

      if (method === "POST" && path === "/auth/challenge") {
        sameOrigin(req);
        if (!perIp.challenge.allow(ip(req))) throw new HttpError(429, "too many sign-in attempts; wait a minute");
        await readJson(req);
        send(res, 200, service.challenge(hostOf(req)));
        return true;
      }
      if (method === "POST" && path === "/auth/verify") {
        sameOrigin(req);
        if (!perIp.verify.allow(ip(req))) throw new HttpError(429, "too many sign-in attempts; wait a minute");
        const b = await jsonBody(req);
        const r = await service.verify({ account_id: b?.account_id, public_key: b?.public_key, signature: b?.signature, nonce: b?.nonce });
        send(res, 200, { account_id: r.account_id, signed_up: r.signed_up }, { "set-cookie": cookie(req, r.token, 7 * 24 * 3600) });
        return true;
      }
      if (method === "POST" && path === "/auth/logout") {
        sameOrigin(req);
        service.logout(token(req));
        send(res, 200, { ok: true }, { "set-cookie": cookie(req, "", 0) });
        return true;
      }

      if (path === "/me" || path.startsWith("/me/")) {
        if (method === "GET" && path === "/me") { send(res, 200, me(need(req))); return true; }
        if (method === "GET" && path === "/me/receipts") {
          send(res, 200, { receipts: cfg.receiptsFor(need(req), 50) });
          return true;
        }
        // everything below changes something: same site only, and rate limited
        if (method !== "GET") sameOrigin(req);
        if (method === "POST" && path === "/me/signup") {
          const account = need(req);
          if (!perIp.signup.allow(ip(req))) throw new HttpError(429, "too many sign-up attempts; wait a minute");
          const b = await jsonBody(req);
          service.signUp(account, { display_name: b?.display_name, accepted: b?.accepted });
          send(res, 201, me(account));
          return true;
        }
        if (method === "PUT" && path === "/me") {
          const account = need(req);
          if (!perAccount.allow(account)) throw new HttpError(429, "too many changes; wait a minute");
          const b = await jsonBody(req);
          service.updateProfile(account, { display_name: b?.display_name });
          send(res, 200, me(account));
          return true;
        }
        if (method === "PUT" && path === "/me/guardrails") {
          const account = need(req);
          if (!perAccount.allow(account)) throw new HttpError(429, "too many changes; wait a minute");
          const r = service.updateGuardrails(account, await jsonBody(req));
          if (!r.ok) { send(res, 400, { error: "invalid guardrails", errors: r.errors }); return true; }
          send(res, 200, me(account));
          return true;
        }
        if (method === "DELETE" && path === "/me") {
          const account = need(req);
          service.deleteAccount(account);
          send(res, 200, { deleted: true }, { "set-cookie": cookie(req, "", 0) });
          return true;
        }
        throw new HttpError(404, "not found");
      }
    } catch (err) {
      if (err instanceof AuthError) throw new HttpError(err.status, err.message);
      throw err;
    }
    return false;
  }

  return {
    handle,
    sessionAccount,
    /** Before answering /memory/check at all: a signed-in browser whose owner paused payments gets 403 before any 402. */
    guardSession(req: IncomingMessage): void {
      const a = sessionAccount(req);
      if (!a) return;
      const d = service.access(a, cfg.price());
      if (!d.ok) throw new HttpError(d.status, d.reason);
    },
    /** After the payment verified, BEFORE anything is settled: the paying account's own limits. */
    guardPayer(payer: string): void {
      const d = service.access(payer, cfg.price());
      if (!d.ok) throw new HttpError(d.status, d.reason);
    },
  };
}

export type AuthRoutes = ReturnType<typeof createAuthRoutes>;
