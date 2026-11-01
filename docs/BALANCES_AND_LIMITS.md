# Real balances, real top-ups, and the owner's limits

Three things that used to be simulated or fixed in code. All testnet only, all tiny, all off by default so offline demos and CI stay simple.

## 1. Real balances (`SWARM_STATE=onchain`)

READ takes each sub's **real wNEAR balance** from NEAR testnet (`ft_balance_of` on `wrap.testnet`) as its capital. Capital is counted in *units*: one unit is `CAPITAL_UNIT_YOCTO` yocto of wNEAR (default `1e19` = 0.00001 wNEAR), so the usual 1000-unit allocation is **0.01 wNEAR**.

- If a balance can't be read, the cycle stops before deciding or committing. It never quietly falls back to simulated numbers.
- Mnemosyne doesn't trade, so there is no profit and loss to read from a chain. **Losses stay simulated** (`SWARM_SCENARIO`) and the dashboard says so: `REAL BALANCES · SIMULATED LOSSES`.

## 2. Real top-ups (`ALLOCATE_MODE=wnear`)

ALLOCATE (`src/allocate/index.ts`) runs only after the memory commit. In `wnear` mode the governor tops up a sub that was told to `INCREASE` with a real `ft_transfer`, by exactly the gap between its balance and the committed `target_capital`.

Rules that hold for every allocation rail:

1. **No allocation without memory.** `assertMemoryGate()` needs a committed record that matches its own `decision_hash` and stays inside its own `max_total_exposure`. Otherwise nothing moves.
2. **Never more than the committed record allows**: a sub's `target_capital`, and the per-cycle cap `ALLOCATE_MAX_UNITS` (default 1000 units = 0.01 wNEAR).
3. **Money only moves one way.** The sub keys are report-only on purpose, so a sub can't send funds back. `CUT` lowers the sub's ceiling and the extra stays in the sub account; the log says exactly how much. Pulling it back needs the sub's cold full-access key and is deliberately not automated.
4. The reduce-only sub (C) is never topped up.
5. Every transfer carries `mnemosyne <first 12 hex of decision_hash>` as its memo, so the transfer on NEAR can be matched to the memory commit that allowed it.
6. An allocation problem (governor short of wNEAR, sub not registered, RPC error) is logged per sub and never crashes the cycle. The sub window still runs.

`ALLOCATE_MODE=wnear` without `SWARM_STATE=onchain` moves nothing and says why: it won't top up toward a simulated number.

### Run it (Windows cmd)

```
npm run swarm:setup -- --seed 800
set SWARM_STATE=onchain
set ALLOCATE_MODE=wnear
set SWARM_SCENARIO=recovery
npm run cycle
```

`swarm:setup` is idempotent: it registers the governor and the three sub accounts with `wrap.testnet`, wraps NEAR into wNEAR for the governor if it is short, and funds each sub up to the seed (default 1000 units). It signs with the governor key only; the sub keys are never used for it. Seeding below 1000 leaves room to grow, but the governor is told that protecting capital beats growth and usually KEEPs or CUTs, so a cycle will often move nothing. That is correct behaviour. To prove the transfer itself, use the rail check below.

### Prove the top-up (`npm run rail:check`)

```
npm run rail:check                         1 unit (0.00001 wNEAR) to sub A
npm run rail:check -- --sub B --units 5    up to 100 units, sub A or B
```

Sends a tiny real `ft_transfer` from the governor with the same code and memo format as a cycle. It is a check, not a governor decision, and a cycle never calls it. The rule stays: **no memory, no money.** It refuses unless the newest memory commit on-chain matches a record on this machine that still recomputes to its own `decision_hash` and sits inside its own limits. The memo is that hash's first 12 characters, so the transfer can be matched to the commit that allowed it. It then prints the transaction, whether the token echoed the memo in its own transfer log, and the sub's balance before and after.

## 3. Your limits (`PUT /limits`, the dashboard's "Your Limits" panel)

The owner controls the *rails* the governor works inside: total exposure, per-sub ceiling, daily loss, the loss that pauses a sub, growth per cycle, and the max-position / max-loss shares. They are stored in `data/runtime/limits.json`, read by every cycle, used by the policy guard, and **written into the public memory record** (`swarm_risk`), so the limits that applied to a decision are on-chain with it.

What is deliberately *not* editable by hand: each sub's per-cycle target, max position and max loss. Those are the governor's decision, and their hash is committed on-chain; hand-editing one would break the audit trail. Sub-agents also keep their own hard mandate ceilings, so a limit that pushes a directive past a sub's ceiling makes that sub REFUSE on-chain.

- Hard bounds are in code (`LIMIT_SPECS` in `src/limits/index.ts`). The page and the API cannot go outside them. Contradictions (per-sub ceiling above total exposure) are rejected.
- Reading is public (`GET /limits`, and inside `/dashboard.json`). Changing needs `ADMIN_TOKEN` (`PUT /limits`, `POST /limits/reset`). With no `ADMIN_TOKEN` the server answers 503 and nothing can be changed. Ten wrong tokens in a minute get a 429.
- The token is typed into the page, sent as a Bearer header, and kept only in that tab's memory. It is never put in browser storage.
- Fail-closed: a corrupt or out-of-bounds `limits.json` stops the cycle instead of silently using defaults.
- The last 20 changes are kept (who, when, from, to).

Today the owner proves who they are with the admin token. The file already records `updated_by`, ready for a per-account NEAR sign-in later.

## Honest limits

- Balances are real; losses are not. There is no trading.
- Top-ups are one-way (see rule 3).
- A single owner, one governor. No per-user accounts yet.
- Real balances, the stepped ALLOCATE log, the on-chain REFUSE, the limits panel and the `ft_transfer` top-up (via `npm run rail:check`) have all run live on testnet: see HANDOFF.md for the transactions. The governor choosing INCREASE inside a live cycle is covered by offline tests only, because it is told to be conservative and rarely does.
