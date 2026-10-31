# mnemosyne

Non-trading governor agent on NEAR: private decisions, on-chain memory
commitments, capability-limited sub-agents, and x402-paid memory queries.

Full build plan: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).
Build progress / what's been done in each step: [`HANDOFF.md`](HANDOFF.md).

## Current status: Phases 1–6 built; 1–5 proven on NEAR testnet (incl. real x402 in wNEAR), Phase 6 private decisions proven live in a NEAR AI Cloud TEE

One cycle runs: read -> decide -> **on-chain memory commit** (mnemosyne-gov.testnet, hash-chained, fail-closed) -> allocate (print-only) -> **sub-agent window**: each sub checks the directive against its own mandate and writes ACT/REFUSE on-chain with its own report-only function-call key. Sub C (defensive, reduce-only) refuses directives above its tighter ceiling.

Proven on testnet 2026-10-30 (see HANDOFF.md): a full cycle committed memory, then sub A and B reported ACT and sub C reported REFUSE on-chain, each signing with its own report-only key. Every sub key passes `npm run sub:check`: it can call `report`, and NEAR itself rejects `commit` and transfers. The sub accounts' FullAccess keys stay in the operator's keychain and are never given to the agent.

**x402 memory API (Phase 5):** other agents pay per query to ask "does this situation match a failure Mnemosyne has already learned from?" -- no signup, no API key. They get back match / citation id / one-line public advice and a receipt; the private detail of each memory never leaves the server. Payments follow x402 v2 (HTTP 402 + `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`). Each payment is an ed25519-signed authorization from the payer's NEAR key, bound to price, recipient, network, endpoint, a time window and a single-use nonce. **Settlement is mocked:** the facilitator performs every check but records the payment in a local ledger instead of moving NEAR (ids start with `mock_`, responses say `mock: true`). Details: [`docs/X402.md`](docs/X402.md).

**Real settlement (testnet, proven):** with `X402_RAIL=near-testnet` the same API takes real wNEAR on NEAR testnet through the official x402 NEAR scheme, e.g. tx [`AAWMt68Q...`](https://testnet.nearblocks.io/txns/AAWMt68QRu8QEqcdeVf1VdeqnQMbyeDfpzMy6jd9tqzJ): an agent paid 0.001 wNEAR to `mnemosyne-gov.testnet` for a memory check; replaying the same payment was refused by NEAR's nonce. See "Two payment rails" in [`docs/X402.md`](docs/X402.md). Mock remains the default.

**Private decisions (Phase 6):** the governor reasons inside a NEAR AI Cloud TEE (Intel TDX + NVIDIA confidential GPU). Before a decision is used, Mnemosyne checks the enclave's signature over the exact request/response bytes, a fresh attestation bound to its own nonce, the Intel TDX quote and NVIDIA's GPU attestation; any failure stops the cycle before the memory commit. A deterministic policy guard clamps whatever the model proposes. The reasoning stays private; the public record carries only the decisions, a salted commitment to the private blob, and the TEE evidence. Without an API key it falls back to a local rule labelled `local-policy`. Details: [`docs/PRIVATE.md`](docs/PRIVATE.md).

Still simulated, and labeled as such: swarm state (`SWARM_SCENARIO`), ALLOCATE (no real transfers), and x402 settlement in the default mock rail.

Sub-agent key setup: [`docs/PHASE3_KEYS.md`](docs/PHASE3_KEYS.md). Copy `.env.example` to `.env`.

## Run it

```
npm install
npm run cycle                 (one governor cycle)
npm run sub:keygen -- A       (new report-only key for a sub)
npm run sub:check -- A        (prove a sub key is scoped: report ok, commit/transfer rejected)
npm run verify:contract       (deployed wasm == local build, read-only)
npm run server                (x402 memory API on http://localhost:8402)
npm run x402:demo             (an external agent pays for a memory check)
npm run tee:check             (one verified private decision in the NEAR AI TEE, nothing on-chain)
npm test                      (x402 + private-decision tests, no network needed)
```

This runs one cycle and prints each step. Run it again and you'll see
`prev_memory_hash` pick up the previous cycle's hash, chaining the log.

## Try the x402 memory API (do X -> see Y)

No NEAR keys needed for these steps. Use Node.js 22+ and two terminals at the repo root.

1. `npm run server` -> listens on `0.0.0.0:8402`, `memory entries: 6`, `facilitator: MOCK`.
2. `curl -i -X POST localhost:8402/memory/check -H "content-type: application/json" -d "{\"query\":\"delete the full access key\"}"` -> `HTTP/1.1 402 Payment Required`, a `PAYMENT-REQUIRED` header, and a JSON body quoting price (`amount` in yoctoNEAR), `payTo: mnemosyne-gov.testnet`, `network: near:testnet`. No answer is included.
3. `npm run x402:demo` -> an external agent (a fresh NEAR implicit account) gets the 402, signs the quoted price, retries, and receives `match: true (citation M-001, key-management)` plus one line of advice and a `receipt: R-...`. It then fetches the receipt and checks both hashes (`answer hash matches ... YES`), replays the same payment and gets `HTTP 402: nonce_already_used`. Last line: `DEMO OK`.
4. `npm run x402:demo -- "planning the team lunch menu"` -> still paid, but `match: false`: unrelated situations don't produce false citations.
5. Open `http://localhost:8402/audit` -> every paid check (receipt id, payer, amount, citation, `mock_` settlement id), and never the query text.
6. `npm test` -> 28 tests: wrong amount, recipient, network, payer key, endpoint, expired or over-long window, tampered signature, replay, 8 concurrent uses of one payment (exactly 1 settles), restart persistence, admin-only routes, and that `private_detail` never appears in any response.

For a remote deployment, set `PUBLIC_URL` to its public HTTPS origin and point
`MNEMOSYNE_URL` at the same origin. Without a pinned URL, the demo also works
through a trusted reverse proxy that preserves Host and sets `X-Forwarded-Proto`.
See [`docs/X402.md`](docs/X402.md) for security limits and facilitator configuration.

Governor side (needs `.env` with testnet keys): `npm run cycle` -> step 3 prints a `MEMORY COMMIT` tx link; step 5 prints `on-chain ACT` for subs A and B and `on-chain REFUSE` for sub C, each with a tx link.
