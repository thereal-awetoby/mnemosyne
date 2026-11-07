# Cross-chain: two directions, both quote-only today

There are two separate cross-chain paths in this project, and they are easy to
confuse because they use the same pricing provider:

| | Outbound (Phase 7) | Inbound (Multi-chain Phase 1) |
| --- | --- | --- |
| Who moves value | the governor, after a memory commit | a caller paying for a memory check |
| Direction | wNEAR on NEAR -> USDC on Base | USDC on Base -> wNEAR on NEAR |
| Swap type | `EXACT_INPUT` (spend this much) | `EXACT_OUTPUT` (deliver the listed price) |
| Code | `src/allocate/cross_chain.ts` | `src/payments/inbound.ts` |
| Turned on by | `CROSS_CHAIN_ALLOCATE=1` | `CROSS_CHAIN_INBOUND=1` |
| Status | **quote only** | **quote only** |

The rest of this page is the outbound rail. Inbound is at the bottom, under
"[Paying from another chain](#paying-from-another-chain-inbound-phase-1)".

## Cross-chain allocation (Phase 7): quote only

After a cycle's memory commit, ALLOCATE can ask Rhea / NEAR Intents what it would cost to move a small slice of one sub's allocation to another chain. **This build only quotes.**

- A quote is a price, not a fill. Nothing is sent, signed or deposited, and every log line and the dashboard say so.
- Rhea and NEAR Intents run on **mainnet**. This project stays on testnet with tiny amounts, so executing is deliberately not wired (see "Execution" below). A quote costs nothing and moves nothing, which is why it is allowed.
- Off by default. `CROSS_CHAIN_ALLOCATE=1` turns it on. Offline demos and CI never touch the network.

Order stays fixed: READ -> DECIDE (TEE) -> MEMORY COMMIT -> ALLOCATE (same-chain top-ups, then this) -> SUB WINDOW. If the memory commit fails, nothing in ALLOCATE runs.

## What the memory record allows

`src/allocate/cross_chain.ts`. Every rule fails closed.

1. **No allocation without memory.** The same `assertMemoryGate()` as the wNEAR rail: committed, matches its own `decision_hash`, inside its own `max_total_exposure`. Otherwise the provider is never asked.
2. **Only what the record says.** The chosen sub (`CROSS_CHAIN_SUB`, default A) must be `KEEP` or `INCREASE` in the committed record. Never `PAUSE`, never `CUT`, never the reduce-only sub. The amount can never exceed that sub's committed `target_capital`, `CROSS_CHAIN_MAX_UNITS` (default 100), or the hard ceiling in code (1000 units).
3. **Destination allowlist, in code.** One path today: wNEAR on NEAR -> USDC on Base. Anything else is refused.
4. **A provider's answer is checked before it is believed.** A quote for more than was asked, with no minimum output, with a deposit address, or past its expiry is refused.
5. **Every quote is logged with what allowed it:** the decision hash, the memory tx (explorer link), the provider's quote id (Rhea `quote.id`, or 1Click `correlationId`) and a local `quote_ref` that digests the whole answer together with the decision hash. It goes into the cycle's run log (`cross_chain`) and shows in the dashboard's ALLOCATE step.
6. A refusal or a provider outage is logged and the cycle carries on. The sub window still runs. Subs never create intents.

## Providers

| `CROSS_CHAIN_PROVIDER` | what | key |
| --- | --- | --- |
| `rhea` | Rhea's RHEA X Chain SDK, `@rhea-finance/cross-chain-aggregation-dex` (pinned 2.1.9), `SwapClient.quote()`. Rhea chooses among several routers (NEAR Intents is one) and the router that won is recorded. | the SDK lists the key as optional, so `CROSS_CHAIN_PROVIDER=rhea` tries without one. If Rhea answers 401/403 the log says so plainly; then request `RHEA_API_KEY` at <https://boss.rhea.finance> and put it in `.env` |
| `oneclick` | NEAR Intents' 1Click API, `POST /v0/quote` with `dry:true`. A dry quote has no deposit address by design. | none needed. A 1Click JWT (`ONECLICK_JWT`, sent as `Authorization: Bearer`) only removes a small extra fee |

Default: `rhea` if `RHEA_API_KEY` is set, otherwise `oneclick`. To try Rhea without a key, ask for it by name: `set CROSS_CHAIN_PROVIDER=rhea`.

## Configuration (all optional except the recipient)

| variable | default | meaning |
| --- | --- | --- |
| `CROSS_CHAIN_ALLOCATE` | off | `1` to run this step in a cycle. Any other value except `0` is an error, never a guess. |
| `CROSS_CHAIN_RECIPIENT` | none | an address **you own** on Base: `0x` followed by 40 hex characters (0-9, a-f), for example `0x1234567890abcdef1234567890abcdef12345678`. Required. Nothing is sent to it. Typing a word instead of an address is refused. |
| `CROSS_CHAIN_SUB` | `A` | which sub's allocation this is for |
| `CROSS_CHAIN_UNITS` | `100` | capital units to quote (1 to 1000). At the default unit, 100 units = 0.001 wNEAR |
| `CROSS_CHAIN_MAX_UNITS` | `100` | cap on the above (the code ceiling is 1000 whatever this says) |
| `CROSS_CHAIN_SLIPPAGE_BPS` | `50` | slippage tolerance, 1 to 300 |
| `CROSS_CHAIN_SENDER` | the governor key's own account (64 hex characters, worked out from `GOVERNOR_PRIVATE_KEY`; falls back to `GOVERNOR_ACCOUNT_ID` if there is no usable key) | origin-side account named on the quote as the refund address. **1Click refuses a `.testnet` name** (it answers `400: Internal server error`), which is why the default is a mainnet-style account. It is only a label while nothing executes. |
| `RHEA_API_URL` / `ONECLICK_URL` | the official hosts | only for testing against a stub |

## Run it (Windows cmd)

Quote for the newest committed record, without a whole cycle (no private key needed):

```
npm install
set CROSS_CHAIN_RECIPIENT=0x1234567890abcdef1234567890abcdef12345678
npm run crosschain:check
```

(That example address is only the right shape. Put an address you own, `0x` and 40 hex characters. Use no quotes and no space before or after the `=`.)

Or as part of a real cycle:

```
set CROSS_CHAIN_RECIPIENT=0x1234567890abcdef1234567890abcdef12345678
set CROSS_CHAIN_ALLOCATE=1
npm run cycle
```

For Rhea: `set CROSS_CHAIN_PROVIDER=rhea` first (in that same window; `set` only lasts for the window you type it in). If Rhea asks for a key, put `RHEA_API_KEY=<the key from boss.rhea.finance>` in `.env`.

You should see one line like `CROSS-CHAIN QUOTE via near-intents: 0.00100 wNEAR -> about 0.001989 USDC on Base (at least 0.001979), quote <id>; quote only, nothing was sent`, followed by the memory commit that allowed it.

At fractions of a cent the rate is poor (0.001 wNEAR priced at about 2 USDC per NEAR, against about 4.4 for 0.1 wNEAR on the same day), because fixed costs weigh more on a tiny amount. It is still a real, valid price; it only means a tiny quote is a bad guide to the rate a larger one would get.

### If 1Click answers 400 (for example "Internal server error")

1Click was reached but refused the request, and its message does not say why. (This is what a `.testnet` refund account used to cause, found with the probe below and now avoided by default. If you set `CROSS_CHAIN_SENDER` to a testnet name yourself, expect it again.) Run the probe:

```
npm run crosschain:probe
```

It sends six price-only requests that each change one thing from the one before (your exact config; a mainnet-style refund account instead of the `.testnet` name; a 0.1 wNEAR amount instead of 0.001; both; a different recipient; and a control using the 1Click docs' own wNEAR to ARB example), and it checks 1Click's token list for our two asset ids. It then says in plain words which change made the difference and which `set` lines to use. It is a diagnostic: it does not read a memory record, the cycle never calls it, and it sends, signs and deposits nothing.

### If the quote says "amount too low"

0.001 wNEAR is a fraction of a cent, below what solvers will price. The log then says `quote unavailable: ... (nothing was sent)`, and that is the honest result. To see a realistic price, scale the unit **only in the window where you run `crosschain:check`**, for example `set CAPITAL_UNIT_YOCTO=1000000000000000000000` (then 100 units = 0.1 wNEAR). A quote moves nothing, so this is safe. Do not set it in a window where `ALLOCATE_MODE=wnear`, because the same unit scales the real top-ups.

## Execution: deliberately not wired

`executeAllocation()` exists and its checks are tested: the memory gate again, the plan still matching the record, the quote belonging to this record, still inside the envelope and not expired, and an executor being present. **No executor is wired and the cycle never calls it**, so the default is a refusal: "execution is not wired in this build". Turning it on would move real mainnet funds, which is a separate decision. If it is ever wired, it needs its own absolute cap in token amount (the unit-based caps here scale with `CAPITAL_UNIT_YOCTO`), a mainnet key held apart from the testnet governor key, and a "completed" status that comes only from the executor, never assumed.

## Honest limits

- Quote, never fill. No intent is created and no swap happens.
- Mainnet prices, testnet project: the quote is real market data about assets the project does not hold.
- The `oneclick` provider is proven live (a price only, 2026-11-01; see HANDOFF.md). The `rhea` provider was written against the SDK's published type definitions and is tested offline against fakes. **Run live without a key on 2026-11-01, Rhea refused it** ("Rhea wants an API key and none is set"; nothing was sent), so it needs a `RHEA_API_KEY` from boss.rhea.finance, which could not be obtained (the portal rejected the emailed verification code). Until a key is set, use `CROSS_CHAIN_PROVIDER=oneclick`, which needs none.
- Operator-side only. A future per-user layer ([`MULTIUSER_PLAN.md`](MULTIUSER_PLAN.md)) must never be able to reach this rail.

---

## Paying from another chain (inbound, Phase 1)

`src/payments/inbound.ts`, `POST /memory/quote`. Off by default;
`CROSS_CHAIN_INBOUND=1` turns it on.

A memory check costs 0.001 wNEAR on NEAR. This answers the other question a
caller might have: *"I hold USDC on Base — what would that cost me?"*

**Phase 1 stops at the price, and that is a boundary, not a default.** Nothing
here settles, verifies a settlement, or releases an answer. `/memory/check` is
untouched by this file and does not accept a quote id; presenting one still
gets a 402, and a test proves it. Verifying an actual inbound settlement is
Phase 2.

### Why it cannot be real yet

1Click prices **mainnet** assets (Base USDC, `wrap.near`). This server settles
on NEAR **testnet**, to `mnemosyne-gov.testnet`. So an inbound quote is a real
market price for a route that cannot currently deliver to this governor. The
quote says so in its own `note` field, and the desk repeats it. Closing that
gap means either a testnet route or tiny mainnet amounts — Phase 3's problem,
and a decision about real money rather than a coding task.

### What it asks, and what it refuses

The request is `EXACT_OUTPUT`: what is fixed is the price that must *arrive*
on NEAR; what varies is how much USDC the payer sends. (The outbound rail asks
the opposite question, which is why it does not share the request builder.)
`dry: true`, as outbound, so no deposit address can come back.

A provider's answer is checked before it is shown:

- a **deposit address** on a dry quote → refused (something other than a price
  came back);
- a quote that would deliver **less than the listed price** → refused (it is
  not a quote for this check);
- **no usable amount** → refused, rather than displayed as zero;
- the provider **unreachable or erroring** → 503 whose message also says that
  paying in wNEAR on NEAR still works. A dead side rail must not read as a
  dead server.

### What is written down

Each quote is stored in `data/runtime/quotes.json`, bound to the question by
`sha256` (never the text itself), against the memory chain head it was priced
at, with an expiry and a `used_at: null` so Phase 2 can redeem it exactly
once. Nothing redeems one today.

```
POST /memory/quote   {"query": "...", "chain": "base:USDC"}

{ "quote_id": "Q-...", "decision_hash": "sha256:...",
  "source_chain": "base", "source_asset": "USDC",
  "source_amount": "1050000", "source_amount_display": "1.05",
  "amount": "1000000000000000000000", "asset": "wNEAR",
  "pay_to": "mnemosyne-gov.testnet", "expires_at": "...",
  "provider": "1click", "quote_only": true, "note": "..." }
```

`{"chain": "near"}` (or no chain at all) answers from the rail's own terms
instead, so one endpoint covers every chain and the NEAR price is unchanged by
any of this.

### On the desk

Paid checks grows a *Pay from* selector, shown only when the server actually
knows of more than one chain. Every non-NEAR option is labelled "— price only"
in the option text itself, so the picker cannot imply a rail that is not
built. Choosing one and pressing the button shows "Quote ready — pay on Base"
with what you would send, what would arrive, who priced it, and one line
saying it buys nothing yet.

### Not built (Phases 2–4)

- **Phase 2:** watching NEAR for the incoming settlement and redeeming a quote
  against it, then issuing a receipt carrying both the source proof and the
  NEAR tx.
- **Phase 3:** one real rail end to end, with the mainnet/testnet decision
  above actually made.
- **Phase 4:** Solana, if a clean route exists.

Receipts are unchanged: they carry no `source_chain` or `source_tx` field yet,
because nothing can populate them honestly.
