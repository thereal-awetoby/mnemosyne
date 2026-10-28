# Mnemosyne — NEAR HACKATHON Build Plan

### Private memory governor + agent swarm + x402 payments

**Event:** NEAR HACKATHON — Build Beyond Boundaries  
**Dates:** 1 Nov 2026 00:00 UTC → 14 Nov 2026 23:59 UTC  
**Judging:** 16–18 Nov 2026  
**Prize pool:** $250,000 (Grand $55K · 13× $10K · 13× $3K · 13× $2K)  
**Site:** https://nearhackathon.com/  
**Rules (live):** https://nearhackathon.com/HACKATHON.md  

> The governor never trades.  
> Sub-agents are capability-limited.  
> Memory is the gate.  
> Sensitive decision logic stays private.  
> Other agents can pay to query memory via x402.  
> What leaves private execution is a commitment hash — not the full strategy.

This document is the **single source of truth** for building Mnemosyne on NEAR.  
It is written so someone new to crypto can still follow every step.

---

## 0. Plain English glossary (read this first)

| Term | What it means in normal language |
|------|----------------------------------|
| **NEAR** | A blockchain (like a shared public computer) where accounts, money, and programs live. |
| **Account** | An identity on NEAR that can hold money and own keys. Example: `mnemosyne.near`. |
| **Sub-account** | A child account under a parent. Useful for giving each agent its own limited wallet. |
| **Key** | Digital permission to act for an account. Like a password that can also be restricted. |
| **Function-call key** | A limited key that can only call certain methods and spend up to a set amount. Safer than a full master key. |
| **On-chain** | Recorded permanently on the public blockchain. Anyone can verify it. |
| **Off-chain / private** | Happens on a server or inside a secure environment. Not fully published. |
| **TEE** | Trusted Execution Environment. Hardware that runs code so even the server owner cannot easily read the data inside. |
| **NEAR AI Cloud** | NEAR’s service for running AI models, including private (TEE) paths. |
| **Hash** | A short fingerprint of data (e.g. SHA-256). Same input → same hash. You cannot reconstruct the original from the hash alone. |
| **Commitment** | Publishing a hash now, and optionally revealing the full data later. Proves you fixed a decision without revealing it yet. |
| **x402** | A payment standard that uses HTTP status code **402 Payment Required**. A server says “pay this much”; a client (or agent) pays with crypto and retries; then the server returns the result. No account signup, no API key. |
| **Facilitator** | A helper service that checks the signed payment and settles it on-chain so your server does not have to run a full blockchain node. |
| **Governor** | Mnemosyne itself — the boss agent. It decides and allocates. It does **not** place market trades. |
| **Sub-agent** | A narrow worker agent with limited powers (one style of work only). |
| **Memory** | The record of past decisions and rules. Public part = hash + limits on-chain. Private part = full reasoning. |
| **Fail-closed** | If something critical fails (e.g. memory write), the system stops instead of continuing in a dangerous state. |

---

## 1. One-sentence pitch

Mnemosyne is a non-trading governor agent on NEAR that keeps decision logic private, commits a decision hash on-chain before any capital moves, allocates work to narrow sub-agents under limited keys, and lets other agents **pay per memory query** using the x402 payment protocol.

---

## 2. What problem we solve

Multi-agent systems that move money usually fail in one of two ways:

1. **Too much power** — agents get full keys and can drain funds.  
2. **No memory discipline** — they repeat the same mistakes because nothing forces them to record and respect past failures.

Mnemosyne fixes both:

- **Memory is a hard gate.** No capital or authority move is allowed until an on-chain memory commitment exists for that cycle.  
- **Keys are limited.** Sub-agents only get function-call keys with method and spend limits.  
- **Strategy stays private.** Full reasoning does not need to be public; the chain stores a hash plus enforceable numbers.  
- **Memory can be sold.** Other agents pay via x402 to ask “have we seen this failure pattern before?” without reading the raw private store.

---

## 3. Track mapping (submit multiple — one form)

| Track ID | Track name | Fit | Priority |
|----------|------------|-----|----------|
| `swarms` | AI Swarms | Multi-agent coordination, sub-accounts, capital allocation | **Primary** |
| `privacy` | Privacy & Private AI | Private decision path (TEE / NEAR AI Cloud) | **Primary** |
| `security` | AI Security & Defense | Function-call keys, spend limits, fail-closed | **Primary** |
| `agents` | Agent Economy | x402: agents pay for memory checks / work | **Primary if x402 ships** |
| `business` | Autonomous Business | Humans set constraints; AI runs under them | Secondary |

**Recommended tracks array for submission:**

```json
["swarms", "privacy", "security", "agents"]
```

Use `"agents"` only if the x402 payment path is actually working in the demo.  
Add `"business"` if you stress human-set risk limits in the README and UI.

---

## 4. How x402 works (newbie-friendly)

### The problem x402 solves

Normal APIs expect:

- Create an account  
- Get an API key  
- Store a card or prepaid balance  

That is awkward for **software agents**. An agent should be able to pay for one request the same way a browser loads a page.

### The x402 flow

1. **Client** (human app or another agent) requests a resource:  
   `POST /memory/check`
2. **Server** answers **HTTP 402 Payment Required** and includes payment details in a header:  
   - how much  
   - which token (often USDC or a test token)  
   - which network  
   - who gets paid (your merchant address)
3. **Client** signs a payment from its wallet and **retries** the same request with a payment signature header.
4. **Server** (or a **facilitator**) verifies the payment and settles it.
5. **Server** returns the real result (e.g. memory match + citation).

No signup. No long-lived API key. Pay per call.

### How Mnemosyne uses x402

| Endpoint | Free or paid | Purpose |
|----------|--------------|---------|
| `GET /health` | Free | Liveness |
| `POST /memory/check` | **x402 paid** | “Does this pattern match a known failure?” |
| `POST /memory/confess` | Paid or session-gated | Write a new rule / confession |
| `GET /memory/receipt/:id` | Free or cheap | Proof that a check was paid and answered (no raw secrets) |

**Mode A (required):** Memory gate for the governor’s own cycles (commit on NEAR before allocate).  
**Mode B (x402):** External agents pay Mnemosyne for memory checks. This is the Agent Economy story.

### Demo path with almost no money

- Use a **mock facilitator** or **testnet** so judges can see 402 → pay → answer without spending real cash.  
- Document clearly: “Demo uses testnet / mock settle; production would use mainnet USDC + real facilitator.”  
- Keep amounts tiny if you ever touch real networks.

---

## 5. Core architecture

```
┌──────────────────────────────────────────────────┐
│              GOVERNOR (Mnemosyne)                │
│  - Reads swarm state                             │
│  - Reasons in private path (TEE / private AI)    │
│  - Emits decision + commitment hash              │
│  - Writes memory on-chain (hash + public limits) │
│  - Only then allocates via limited keys          │
│  - NEVER places market orders itself             │
│  - Serves paid memory checks via x402            │
└───────────────────────┬──────────────────────────┘
                        │
          1. Private decide
          2. On-chain memory commit
          3. Capital / authority move
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   ┌─────────┐    ┌─────────┐    ┌─────────┐
   │  Sub-A  │    │  Sub-B  │    │  Sub-C  │
   │ narrow  │    │ narrow  │    │ narrow  │
   │ FC key  │    │ FC key  │    │ FC key  │
   └─────────┘    └─────────┘    └─────────┘

External agent ──x402──► POST /memory/check ──► match + citation only
```

### Accounts (NEAR model)

| Role | Account idea | Powers |
|------|--------------|--------|
| Governor | `mnemosyne.<team>.near` or team root | Write memory, allocate, pause; **no** broad market trading |
| Sub-A / B / C | Sub-accounts or named accounts | **Function-call keys only** — limited methods, limited allowance |
| Memory | Simple contract or structured events | Stores commitment hash + public risk envelope |

### Hard rules (do not break these)

1. Governor does not hold unrestricted trading keys.  
2. Sub-agents only act under the latest on-chain memory mandate.  
3. If memory commit fails → cycle ends (**fail-closed**).  
4. Full strategy text stays private; chain sees hash + numeric limits.  
5. External callers who did not pay do not get memory answers.

---

## 6. Confidential execution (privacy)

**Goal:** Intelligence without exposing the full strategy.

| Layer | What happens | Tech |
|-------|----------------|------|
| Private | Model/worker reads state, reasons, produces decision JSON | NEAR AI Cloud private path and/or isolated worker |
| Public | Hash of decision + risk limits + allocation targets | On-chain memory |
| Paid query | External agent pays via x402; receives match + citation only | API + x402 |

**Minimum viable privacy for the hackathon**

- Decision produced in a controlled environment (NEAR AI Cloud if available; else private worker that never logs full strategy publicly).  
- Only `sha256(decision_json)` + public fields go on-chain.  
- README must say honestly what you shipped (do not claim full production TEE if you only have a private worker + hash).

---

## 7. One autonomous cycle (unit of work)

Every N minutes (e.g. 5–15):

```
1. READ
   - Balances / state of governor + subs
   - Last N memory records on NEAR
   - Simple inputs the governor is allowed to see

2. DECIDE (private)
   - Inside private path
   - Output: KEEP | INCREASE | CUT | PAUSE per sub
   - Risk envelope for the swarm
   - Reason summary (stays private or heavily redacted)

3. MEMORY COMMIT (mandatory gate)
   - On-chain: cycle_id, prev_hash, decision_hash, public limits, targets
   - Wait for confirmation
   - If fail → END CYCLE (fail-closed)

4. CAPITAL / AUTHORITY ACTION
   - Only after memory confirmed
   - Move tokens or update function-call allowances per memory
   - Optional: pay a sub-agent a small fee for verified work (Mode B internal)

5. SUB-AGENT WINDOW
   - Subs may act only inside mandate + limits from latest memory
   - Local REFUSE if limits would break

6. PUBLIC LOG
   - Memory tx link
   - Allocation txs
   - Sub actions and refusals
```

**Separate path — paid external query**

```
External agent → POST /memory/check
  → 402 + price
  → pay + retry
  → match / no-match + citation id
  → (never full private memory dump)
```

---

## 8. Memory schema (public on-chain part)

```json
{
  "cycle_id": "2026-11-05T12:00:00Z-017",
  "governor": "mnemosyne.near",
  "decision_hash": "sha256:...",
  "prev_memory_hash": "sha256:...",
  "decisions": [
    {
      "sub": "A",
      "action": "INCREASE",
      "target_capital": "...",
      "max_position": "...",
      "max_loss_cycle": "...",
      "mandate": "mean_reversion_only"
    },
    {
      "sub": "B",
      "action": "PAUSE",
      "reason_code": "local_loss_limit"
    }
  ],
  "swarm_risk": {
    "max_total_exposure": "...",
    "max_daily_loss": "..."
  },
  "schema_version": 1
}
```

The full private decision blob is **not** required on-chain — only the hash and the numbers that can be enforced.

---

## 9. Sub-agents (keep them narrow)

| Sub | Mandate | Enforcement |
|-----|---------|-------------|
| A | One style only (e.g. mean-reversion style logic) | Function-call key + numeric limits in memory |
| B | Inventory / liquidity style only | Function-call key + inventory bounds |
| C | Defensive / reduce-risk only | Function-call key + may only shrink risk |

- Subs never update global memory.  
- Subs never allocate capital to each other.  
- Subs may **REFUSE**. Refusals must be visible in the audit log.

---

## 10. NEAR primitives to name in the README

| Primitive | Use in Mnemosyne |
|-----------|------------------|
| Named accounts / sub-accounts | Governor + each sub-agent |
| Function-call keys | Cap what each sub can call and spend |
| NEAR AI Cloud / private AI | Confidential decision path |
| On-chain events or simple contract | Memory commitments |
| x402 | Paid memory checks (Agent Economy) |
| NEAR Intents (optional stretch) | Cross-chain settlement later |

Always re-check live docs before coding:

- https://docs.near.org/  
- https://docs.near.ai/ · https://near.ai/  
- https://docs.near-intents.org/  
- x402 overview: https://x402.org/ and Cloudflare/agent docs for HTTP 402 payments  

---

## 11. API surface (what you actually ship)

| Route | Auth / pay | Behavior |
|-------|------------|----------|
| `GET /health` | Free | Status |
| `POST /cycle/run` | Internal / admin | Run one governor cycle (demo button OK) |
| `GET /memory/latest` | Free or light | Public latest commitment summary |
| `POST /memory/check` | **x402** | Pattern in → match + citation |
| `POST /memory/confess` | Paid or gated | Append a rule after a real failure |
| `GET /memory/receipt/:id` | Free | Payment + answer proof without secrets |
| `GET /audit` | Free | Human-readable log links |

---

## 12. Build phases

### Pre-hack (now → 31 Oct)

- [ ] Create NEAR **testnet** accounts (governor + 3 subs)  
- [ ] Read NEAR AI / private AI docs; pick honest MVP privacy path  
- [ ] Skim x402 flow; plan mock facilitator for demo  
- [ ] Open public repo structure; put this plan in as README draft  
- [ ] Join Discord: https://discord.gg/nearprotocol  

### Phase 0 — Spec lock (1 Nov day 1)

- [ ] Tracks: `swarms`, `privacy`, `security`, and `agents` if x402 is in scope  
- [ ] Lock 3 sub mandates  
- [ ] Lock memory schema  
- [ ] Mode A (memory gate) first; Mode B (x402) in parallel or right after  

### Phase 1 — Skeleton

- [ ] Cycle runner (local worker is fine)  
- [ ] Dummy memory write to logs  
- [ ] No real fund movement yet  

### Phase 2 — Memory gate on NEAR

- [ ] Real on-chain commit (testnet)  
- [ ] Cycle aborts if commit fails  
- [ ] Explorer links in logs  

### Phase 3 — Function-call keys + allocation

- [ ] Subs restricted by FC keys  
- [ ] Capital or allowance moves **only after** memory  

### Phase 4 — Narrow sub behavior

- [ ] Mandate checks + local REFUSE  
- [ ] Simple demo behavior (simulation is OK if labeled honestly)  

### Phase 5 — x402 memory API

- [ ] `/memory/check` returns 402 without payment  
- [ ] Mock or testnet pay path  
- [ ] Receipt id stored and queryable  
- [ ] Never return full private memory  

### Phase 6 — Confidential path

- [ ] Decision produced privately  
- [ ] Only hash + limits on-chain  
- [ ] README states exactly what is private vs public  

### Phase 7 — Demo + submit

- [ ] Video: decide → memory tx → allocate → sub refuse → external x402 check  
- [ ] `/audit` folder or page  
- [ ] README: at least 5 “do X → see Y” steps  
- [ ] Repo public · X post · form once  

---

## 13. Demo script (about 2–3 minutes)

1. Architecture: governor vs subs vs external payer.  
2. Show last memory record (explorer or UI).  
3. Run a cycle: private decide → memory tx → allocation.  
4. Show a sub **refuse** under limit.  
5. External agent calls `/memory/check` → **402** → pay → match/citation.  
6. Kill / pause path.  
7. Closing line:  
   **“Governor never trades. Memory is the gate. Strategy stays private. Agents pay to query.”**

---

## 14. Idea text (draft for submission form — edit before send)

```
Problem: Multi-agent systems that move money either give agents too many keys
or hide process so nobody can verify constraints. Agents also cannot easily
pay each other for useful memory without accounts and API keys.

Product: Mnemosyne is a non-trading governor on NEAR. It allocates capital to
narrow sub-agents only after an on-chain memory commitment exists. Decision
logic stays private; the chain stores a hash plus enforceable limits.
Sub-agents use function-call keys only. External agents can pay per memory
query using the x402 (HTTP 402) payment standard.

How NEAR fits: named accounts and sub-accounts for roles; function-call keys
for capability limits; private AI path for confidential decisions; on-chain
memory for public commitments; agent-to-agent payments via x402 for the
Agent Economy track.
```

---

## 15. Success definition

A successful Mnemosyne submission means:

1. Demonstrated autonomous (or clearly triggered) cycles.  
2. Memory gates every capital/authority action.  
3. Governor never places unrestricted market trades.  
4. Subs stay inside mandates; refusals are visible.  
5. Privacy claim matches what was actually built.  
6. At least one **x402 paid memory check** works end-to-end in the demo (mock settle OK if labeled).  
7. Judge can follow README: do X → see Y.  
8. Public repo + X demo before the deadline.

**PnL is optional. Integrity of memory + keys + payments is the product.**

---

## 16. What this is not

- A directional trading bot chasing maximum profit  
- A claim of production TEE if only a private worker + hash is used  
- Unlimited agent wallets  
- Keys or secrets in the git repository  
- A requirement that every visitor must hold Zetaris or other unrelated APIs  

---

## 17. Submission checklist (from HACKATHON.md)

**No pre-registration.** One submission per team. **Cannot edit after send.**

1. Build in the window **1–14 Nov 2026**.  
2. Repository **public** by 14 Nov 23:59 UTC.  
3. Human posts demo on X: says built at NEAR HACKATHON + video/screenshots.  
4. Submit once at https://nearhackathon.com/#apply with:

| Field | Notes |
|-------|--------|
| projectName | 2–80 chars, unique |
| leadName | 2–80 chars |
| email | unique |
| size | team size format they require |
| tracks | e.g. `["swarms","privacy","security","agents"]` |
| nearAddress | team prize wallet you control |
| projectUrl | public GitHub URL |
| demoUrl | public X post URL |
| idea | 20–2000 chars (use section 14 as base) |
| consent | true after human agrees |

Never commit secrets. Re-read https://nearhackathon.com/HACKATHON.md before submit.

---

## 18. Immediate next actions (this week)

1. Bookmark and re-read https://nearhackathon.com/HACKATHON.md.  
2. Create NEAR **testnet** accounts for governor + three subs.  
3. Decide privacy MVP: NEAR AI Cloud private path **or** honest private worker + hash.  
4. Decide x402 MVP: mock facilitator first, real testnet settle second.  
5. Open the GitHub repo; paste this file as `README.md` (or `docs/BUILD_PLAN.md`).  
6. Join https://discord.gg/nearprotocol.  
7. Lock tracks: **swarms, privacy, security, agents**.  

---

## 19. Links

| Resource | URL |
|----------|-----|
| Hackathon home | https://nearhackathon.com/ |
| HACKATHON.md | https://nearhackathon.com/HACKATHON.md |
| Submit | https://nearhackathon.com/#apply |
| NEAR docs | https://docs.near.org/ |
| NEAR Intents | https://docs.near-intents.org/ |
| NEAR AI | https://near.ai/ · https://docs.near.ai/ |
| x402 | https://x402.org/ |
| Discord | https://discord.gg/nearprotocol |
| X | https://x.com/NEARProtocol |

---

## License

Hackathon submission for NEAR HACKATHON 2026.  
Ask before reusing the name or architecture commercially.
