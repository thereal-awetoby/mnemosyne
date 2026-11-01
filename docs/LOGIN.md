# Login and sign-up with a NEAR wallet

One page, `/login`, does both: sign in if you already have an account here, create one if you don't. It gives a person **their own settings and nothing else**.

> **Login is identity plus personal policy. It is never root.** It cannot run a cycle, change the governor's limits, write memory, move capital or touch a governor key. Those stay behind `ADMIN_TOKEN` on the operator's machine, and the tests prove a session cookie cannot reach them.

## What a signed-in person gets

- Personal guardrails for **paid memory checks** (`POST /memory/check`): a daily query cap (0 to 1000, default 50), a daily spend cap (0 to 1 NEAR, default 0.05) and a pause switch. They can only choose inside the protocol's hard bounds, never above them.
- "Your paid checks": the receipts whose payer is their account, and nobody else's.
- Edit the display name, and delete the account (profile and sessions go; paid receipts stay in the public audit log, which holds no personal data).

An account with no profile has no personal limits, exactly as before. Sign-up is opt-in.

## The flow

1. **Continue with NEAR wallet.** The page loads the wallet connector from this server (`/login/near-connect.js`, a pinned 60 KB bundle of `@hot-labs/near-connect`, no CDN) and opens its wallet list. No wallet yet? Pick one there and create a testnet account in it, then come back.
2. The server hands out a one-time challenge (`POST /auth/challenge`): a short text with the site name and an expiry, plus a random 32-byte nonce. It lives in memory for 5 minutes and works once.
3. The wallet signs it as a **NEP-413** message. It is not a transaction, costs nothing and moves nothing.
4. `POST /auth/verify` checks the ed25519 signature over the exact NEP-413 bytes (tag, message, nonce, this site as recipient), then asks NEAR RPC whether that public key is a **FullAccess key of that account** (`view_access_key`). A function-call key, or a key the account doesn't have, is refused with the reason. An implicit account (64 hex characters = the key) is accepted without RPC.
5. On success the server sets one cookie, `mn_session`: a random 32-byte token, `HttpOnly`, `SameSite=Strict` (and `Secure` over https), 7 days. Only its SHA-256 is stored.
6. First time here: **Create your account**, an optional display name and a tick-box that says in plain words what login does not give you. Then `/dashboard`. Next time the same button signs you straight in.

## Routes

| route | needs | does |
| --- | --- | --- |
| `GET /login`, `GET /login/near-connect.js` | nothing | the page and its wallet bundle |
| `POST /auth/challenge`, `POST /auth/verify`, `POST /auth/logout` | same-origin, JSON | sign in / out |
| `GET /me` | session | account, profile, guardrails, usage in the last 24 h, price, protocol bounds |
| `POST /me/signup` | session | create the profile (needs `accepted: true`) |
| `PUT /me`, `PUT /me/guardrails`, `DELETE /me` | session, same-origin, JSON | edit name / limits, delete |
| `GET /me/receipts` | session | paid checks made from this account |

## How the guardrails bite

- A signed-in browser session that is **paused** or **over its caps** is answered `403` / `429` *before* the server answers `402`: the API never even quotes a price.
- Any request, signed in or not, is also checked against the **verified payer** account after the payment verifies and before it settles: a payer who has signed up and is paused or capped gets `403` / `429` and nothing is charged or settled. This is what makes an agent's own wallet limits work for `npm run x402:demo` too.

## Safety design

- Wallet code is isolated on `/login`, which has its own CSP (`connect-src 'self' https:`, wallet frames allowed). `/dashboard` keeps the strict policy: no third-party origins, no wallet code, the cookie is `HttpOnly` so its script never sees the token.
- Writes need a same-site `Origin` / `Sec-Fetch-Site`, a JSON content type, and are rate limited per IP and per account.
- A test bans anything under `src/auth` from importing the cycle, allocation, memory, limits or sub-agent modules, or mentioning `GOVERNOR_PRIVATE_KEY`, `ADMIN_TOKEN` or `runAllocate`. Another proves the operator routes still answer 401 with a valid session cookie.
- Turn all of it off with `LOGIN=0` (`/login` and `/me` then answer 404).

## Try it

```
npm run server
# open http://localhost:8402/login
```

Not testable without a real wallet in a browser: the wallet list itself (it comes from the connector's manifest on GitHub). The server side is covered by tests that sign real NEP-413 challenges with ed25519 keys.

## Not built

- The browser paying x402 from the user's wallet. A wallet can sign delegate actions (`signDelegateActions`), so a real in-browser payment is possible later. Today the dashboard's "Pay & retry" is a clearly labelled demo agent on the mock rail, and on the real rail it points to `npm run x402:demo:real`.
- Per-user trading-style limits: allocation is not user-scoped, so there is nothing to limit yet.
