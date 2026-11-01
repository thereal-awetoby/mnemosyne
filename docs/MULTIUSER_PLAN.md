# Per-user layer: NEAR login and personal guardrails (planned, not built)

Captured from `Mnemosyne_MultiUser_NEAR_Login_Guardrails.pdf`. Optional product layer on top of Phases 1 to 7. This file is the plan so it is not lost; nothing here exists in the code yet.

## The rule

**Login is identity plus personal policy. It is never root.** A user connects a NEAR wallet (Meteor plus one browser wallet), proves ownership by signing a challenge, and gets a session. They then set their own guardrails and use their own x402 allowance. They never hold governor keys, never call `commit` on `mnemosyne-gov.testnet`, never move swarm capital, and never rewrite the global mandates.

| a user can | a user cannot |
| --- | --- |
| connect a NEAR wallet | hold governor FullAccess keys |
| set personal max loss / exposure / pause | bypass the on-chain memory gate |
| pay x402 for memory checks from their own account | rewrite global swarm mandates for everyone |
| see their own receipts, settings and audit slice | call `commit` as the protocol owner |

## Build order (from the PDF)

- **A. Auth only.** Wallet connect button, server nonce challenge, signature verify for the account id, session cookie or bearer token, `/me` returns the account id.
- **B. Guardrails CRUD.** A profile store keyed by account id (a signed local JSON store is enough for the hackathon). `GET/PUT /me/guardrails`. Defaults come from the protocol. Updates that try to raise a limit above the protocol's are rejected. Start small: a pause toggle, a max x402 spend per day, a max number of queries per day.
- **C. Wire to x402.** The logged-in user pays `/memory/check` from their wallet. `/me/receipts` is filtered by payer. If `pause_all` is true, the API answers 403 before it answers 402.
- **D. Not yet:** a governor contract per user, users moving swarm capital or calling `commit`, seed phrases or FullAccess keys in the app.

Effective limits are `min(protocol limits, user guardrails)`, but only where a user-scoped action exists. Allocation is not user-scoped today, so no trading-style per-user controls until it is.

## Security checklist (from the PDF)

Verify the signature against the exact challenge string and its expiry. Bind the session to the account id and never trust a client-supplied one. Rate-limit checks and guardrail updates. Keep the operator `.env` keys out of the browser bundle. Public audit endpoints must not leak other users' queries (the x402 audit already redacts them).

## What already exists to build on

- `src/limits/index.ts`: owner-level limits with hard bounds, atomic file store, history that already records `updated_by`. Per-user guardrails should be a separate store keyed by account id, not an extension of the owner's file.
- x402 receipts and audit in `src/x402/`, with payer recorded per receipt.
- `ADMIN_TOKEN` stays the operator's door. It must not become a user's.

## How Phase 7 stays out of its way

Cross-chain allocation (`docs/CROSS_CHAIN.md`) is operator-side and reads only the committed memory record and the operator's environment. It takes no user input, and no per-user route should ever be able to call `runCrossChainAllocate` or the wNEAR rail.

## Open choices (decide when it is built)

Wallet library (near-api-js wallet selector, or `@hot-labs/near-connect`); which second wallet besides Meteor; session as a signed cookie or a bearer token; whether the x402 payer is the user's own wallet or a prepaid allowance.
