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

## Paying with your own wallet

`GET /pay?q=<question>` pays for one memory check with the same wallet just
signed in on `/login` — a real NEP-366 delegate action, signed by the
visitor, relayed by the server so they never pay gas. It shares `/login`'s
CSP (the only other page allowed to load wallet code) and bounces a
signed-out visitor to `/login?next=/pay?q=...` first, landing back here
after sign-in. The dashboard's "Pay & retry" links here when real payments
are on and the visitor is signed in; signed out, it offers a link to sign
in first. See `docs/X402.md` for how the payment itself is built and what
it does and doesn't cover (real `near-exact` rail only; no automatic wNEAR
registration or wrapping).

## Routes

| route | needs | does |
| --- | --- | --- |
| `GET /login`, `GET /login/near-connect.js` | nothing | the page and its wallet bundle |
| `GET /pay` | nothing (redirects to `/login` if not signed in) | pay for one check with your own connected wallet |
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

Proven live on 2026-11-01 (Windows machine): sign-in and sign-up with a real NEAR wallet, then Run cycle from the desk. The server side is also covered by tests that sign real NEP-413 challenges with ed25519 keys. Not yet reported live: personal guardrails (pause, caps) on a real signed-in account.

## Not built

- Registering a payer for wNEAR storage, or wrapping NEAR into wNEAR, on their behalf. `/pay` tells them plainly when settlement fails for either reason and points at their wallet's own "wrap" feature, rather than doing it itself.
- **Not every NEAR wallet can sign a delegate action.** Proven live on 2026-11-02: MyNearWallet (the wallet most people reach for first) does not implement `signDelegateActions` in near-connect's own wallet manifest, so `/pay` first hit a bare "Method not found" when it silently reused the wallet session from `/login`. Fixed: `/pay` now checks the resumed wallet's own advertised features before trusting it, and if it can't sign, asks for a different one (the wallet picker is pre-filtered to the ones that can) instead of failing opaquely. As of the manifest checked that day, **Meteor Wallet** and **Intear Wallet** support it; MyNearWallet, OKX, Nightly, Hana and WalletConnect do not.
- Per-user trading-style limits: allocation is not user-scoped, so there is nothing to limit yet.
