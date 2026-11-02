/**
 * PROOFS.md, written from the records themselves.
 *
 * The file is generated so it cannot drift from the truth: every link and
 * every verdict in it comes from a recorded cycle and the checks in pack.ts.
 * If a claim stops holding, the generated file says so.
 */

import type { ProofPack } from "./pack.js";
import { tally } from "./pack.js";

const mark = (ok: boolean | null) => (ok === true ? "**yes**" : ok === false ? "**NO**" : "not here");
const bare = (h: string | null | undefined) => String(h ?? "").replace(/^sha256:/, "");
const short = (h: string | null | undefined, n = 16) => (bare(h) ? bare(h).slice(0, n) + "…" : "—");
const link = (text: string, url: string | null) => (url ? `[${text}](${url})` : text);

export interface RenderOptions {
  /** true when the NEAR checks were run as well as the offline ones */
  live: boolean;
  command: string;
}

export function renderProofs(packs: ProofPack[], opts: RenderOptions): string {
  const newest = packs[0];
  if (!newest) return "# Mnemosyne — proofs\n\nNo cycles have been recorded yet. Run `npm run cycle`, then `npm run prove -- --write`.\n";

  const all = packs.flatMap((p) => p.checks);
  const t = tally(all);
  const L: string[] = [];

  L.push("# Mnemosyne — proofs");
  L.push("");
  L.push("Every claim this project makes, and where to check it. **This file is generated** by");
  L.push(`\`${opts.command}\` from the cycle records in \`data/runtime/public/\`, so it cannot say`);
  L.push("something the records do not. Re-run it and it will tell you if a claim stopped holding.");
  L.push("");
  L.push(`Built ${newest.built_at} · ${packs.length} recorded cycle${packs.length === 1 ? "" : "s"} · ${t.pass} checks pass, ${t.fail} fail, ${t.skip} not applicable here · NEAR checks ${opts.live ? "**included**" : "not run (pass `--live`)"}`);
  L.push("");
  L.push("## The sentence the proofs have to carry");
  L.push("");
  L.push("> No capital path without an on-chain memory commit. Strategy stays private.");
  L.push("> Subs only report under limited keys. Other agents pay to read the memory.");
  L.push("");

  // ---- the claim table, newest cycle ----
  L.push(`## Newest cycle: \`${newest.cycle_id}\``);
  L.push("");
  L.push("| Claim | Holds | What settles it |");
  L.push("|-------|-------|-----------------|");
  for (const c of newest.checks) L.push(`| ${c.claim} | ${mark(c.ok)} | ${c.detail.replace(/\|/g, "\\|")} |`);
  L.push("");

  // ---- the links ----
  L.push("### The transactions");
  L.push("");
  L.push("| Step | On NEAR | Proves |");
  L.push("|------|---------|--------|");
  L.push(`| Memory commit | ${link(newest.memory_commit.tx ? newest.memory_commit.tx.slice(0, 10) + "…" : "—", newest.memory_commit.url)} | the decision was written before anything else ran |`);
  for (const s of newest.subs) {
    if (!s.tx) continue;
    L.push(`| Sub ${s.sub} · ${s.action} | ${link(s.tx.slice(0, 10) + "…", s.url)} | ${s.action === "REFUSE" ? "a sub refusing a directive past its own ceiling, on-chain" : "a sub reporting under a key that cannot spend"} |`);
  }
  if (newest.cross_chain?.memory_tx) {
    L.push(`| Cross-chain quote | ${link(newest.cross_chain.memory_tx.slice(0, 10) + "…", newest.cross_chain.url)} | the quote was unlocked by that commit, and is a price only |`);
  }
  L.push("");

  // ---- the recipe ----
  L.push("## Check the main claim yourself, in 30 seconds");
  L.push("");
  L.push("The published record is the thing that was committed. Take the newest file in");
  L.push("`data/runtime/public/`, drop its `decision_hash`, hash the rest, and you get the hash NEAR holds:");
  L.push("");
  const file = `./data/runtime/public/${newest.cycle_id.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
  L.push("```bash");
  // one line on purpose: it has to survive a copy and paste into any shell
  L.push(`node -e "const r=require('${file}'); const h=r.decision_hash; delete r.decision_hash; console.log(h === 'sha256:'+require('crypto').createHash('sha256').update(JSON.stringify(r)).digest('hex'))"`);
  L.push("```");
  L.push("");
  L.push("It prints `true`. Change one byte of that file and it prints `false`.");
  L.push("");
  L.push("Then ask the contract what it is holding. No key, no account, nothing signed:");
  L.push("");
  L.push("```bash");
  L.push(`near view ${newest.governor} get_latest '{}' --networkId testnet`);
  L.push("```");
  L.push("");
  L.push(`It returns \`["${newest.decision.decision_hash}", "${newest.decision.prev_memory_hash ?? ""}", <count>]\`.`);
  L.push("Change one byte of the record and the first value stops matching.");
  L.push("");

  // ---- history ----
  if (packs.length > 1) {
    L.push("## Every recorded cycle");
    L.push("");
    L.push("| Cycle | Decided | Record | Follows | Commit | Checks |");
    L.push("|-------|---------|--------|---------|--------|--------|");
    for (const p of packs) {
      const pt = tally(p.checks);
      const decided = p.decision.path === "near-ai-tee" ? "sealed in a TEE" : p.decision.path === "local-policy" ? "built-in rule" : "older record";
      L.push(`| \`${p.cycle_id}\` | ${decided} | \`${short(p.decision.decision_hash)}\` | \`${short(p.decision.prev_memory_hash)}\` | ${link(p.memory_commit.tx ? "tx" : "—", p.memory_commit.url)} | ${pt.pass} pass${pt.fail ? `, **${pt.fail} fail**` : ""} |`);
    }
    L.push("");
  }

  // ---- the negative suite ----
  L.push("## What must not be possible");
  L.push("");
  L.push("These are enforced in code and covered by the automated suite (`npm test`):");
  L.push("");
  L.push("| It must not be possible to | Where it is refused |");
  L.push("|----------------------------|---------------------|");
  L.push("| Allocate or quote before the memory commit lands | `src/cycle.ts` fails closed; `src/allocate/cross_chain.ts` refuses a quote with no commit |");
  L.push("| Write global memory with a sub-agent key | the contract panics: only the governor account may commit |");
  L.push("| Give a sub a directive above its own ceiling | the sub answers `REFUSE` on-chain (`src/refuse.ts`) |");
  L.push("| Reuse a settled x402 payment | the nonce is spent and the retry is refused (`src/x402/`) |");
  L.push("| Get the private detail out of a paid answer | the answer carries a citation and one line only |");
  L.push("| Reach an operator route with a wallet session | admin routes answer 401 to a session cookie (`src/auth/`) |");
  L.push("| Run a cycle from the browser without the admin token | the desk hides the control and the route needs a bearer token |");
  L.push("");

  // ---- honesty ----
  L.push("## What is deliberately not claimed");
  L.push("");
  L.push("- **Quotes are not fills.** The cross-chain step prices a route after the commit and sends nothing. A quote with a deposit address is refused.");
  L.push("- **Sealed means sealed.** A cycle is only called a TEE decision when the enclave evidence checks out; otherwise the record says the built-in rule decided, and says so on-chain too.");
  L.push("- **Testnet.** Every transaction linked here is NEAR testnet. No mainnet funds are involved.");
  L.push("- **Mnemosyne does not trade.** Balances can be real; the losses in the swarm scenario are a labelled simulation.");
  L.push("- **Users are buyers, not governors.** A wallet login sets that person's own spending limits. It never reaches a governor key, and it cannot write memory.");
  L.push("");

  if (t.fail > 0) {
    L.push("## Failing checks");
    L.push("");
    for (const p of packs) {
      for (const c of p.checks.filter((x) => x.ok === false)) L.push(`- \`${p.cycle_id}\` — **${c.claim}**: ${c.detail}`);
    }
    L.push("");
  }

  return L.join("\n");
}
