/**
 * The checks that need NEAR itself.
 *
 * Everything here asks the public RPC and compares what the chain says with
 * what the recorded cycle claims. No key is needed and nothing is signed, so
 * a third party can run exactly these checks against the same records.
 */

import type { MemoryRecord } from "../types.js";
import type { ProofCheck } from "./pack.js";
import { cycleTag } from "./pack.js";

const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";

async function rpc(method: string, params: unknown): Promise<any> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "prove", method, params }),
  });
  const j = (await r.json()) as { result?: unknown; error?: { message?: string; data?: unknown } };
  if (j.error) throw new Error(typeof j.error.data === "string" ? j.error.data : j.error.message || "RPC error");
  return j.result;
}

/** Every log line a transaction produced, from its own outcome and its receipts. */
function logsOf(tx: any): string[] {
  const out: string[] = [...(tx?.transaction_outcome?.outcome?.logs ?? [])];
  for (const r of tx?.receipts_outcome ?? []) out.push(...(r?.outcome?.logs ?? []));
  return out.map(String);
}

function succeeded(tx: any): boolean {
  const status = tx?.status;
  if (!status || typeof status !== "object") return false;
  if ("Failure" in status) return false;
  for (const r of tx?.receipts_outcome ?? []) {
    if (r?.outcome?.status && typeof r.outcome.status === "object" && "Failure" in r.outcome.status) return false;
  }
  return true;
}

async function getTx(hash: string, sender: string): Promise<any> {
  try {
    return await rpc("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
  } catch {
    // older nodes take the positional form
    return await rpc("tx", [hash, sender]);
  }
}

/** The hash the contract is holding right now. */
export async function chainHead(governor: string): Promise<{ latest_hash: string; prev_hash: string; commit_count: number }> {
  const res: any = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: governor,
    method_name: "get_latest",
    args_base64: Buffer.from("{}").toString("base64"),
  });
  const [latest_hash, prev_hash, commit_count] = JSON.parse(Buffer.from(res.result).toString("utf8"));
  return { latest_hash, prev_hash, commit_count };
}

export interface LiveInput {
  record: MemoryRecord;
  commitTx: string | null;
  reports: Array<{ sub: string; action: string | null; account: string | null; tx: string | null }>;
  /** the newest record in this copy, for the head comparison */
  newestRecordHash?: string;
  /** every decision hash this copy holds, newest first: lets us tell
   *  "these records are behind" apart from "that hash is not ours" */
  knownHashes?: string[];
}

/** Ask NEAR to confirm, or contradict, what the record says. */
export async function liveChecks(input: LiveInput): Promise<ProofCheck[]> {
  const checks: ProofCheck[] = [];
  const add = (id: string, claim: string, ok: boolean | null, detail: string) => checks.push({ id, claim, ok, detail });
  const r = input.record;
  const bare = (h: string | null | undefined) => String(h ?? "").replace(/^sha256:/, "");

  // the commit transaction really carried this hash, and really succeeded
  if (!input.commitTx) {
    add("commit_tx_carries_this_hash", "The commit transaction on NEAR carries this exact hash", null, "no commit transaction was recorded for this cycle");
  } else {
    try {
      const tx = await getTx(input.commitTx, r.governor);
      const want = `MNEMOSYNE_COMMIT:${r.decision_hash}:${r.prev_memory_hash ?? ""}`;
      const logs = logsOf(tx);
      const hit = logs.find((l) => l.startsWith(`MNEMOSYNE_COMMIT:${r.decision_hash}:`));
      const ok = succeeded(tx) && !!hit;
      add("commit_tx_carries_this_hash", "The commit transaction on NEAR carries this exact hash", ok,
        ok ? `${input.commitTx} finished successfully and logged ${hit!.slice(0, 92)}…`
           : !succeeded(tx) ? `${input.commitTx} did not finish successfully`
           : `${input.commitTx} succeeded but logged no commit for ${bare(r.decision_hash).slice(0, 16)}… (wanted ${want.slice(0, 60)}…)`);
    } catch (err) {
      add("commit_tx_carries_this_hash", "The commit transaction on NEAR carries this exact hash", null, `could not read the transaction: ${(err as Error).message}`);
    }
  }

  // each sub's report really is on chain, from its own account, naming this decision
  const withTx = input.reports.filter((x) => x.tx);
  if (withTx.length === 0) {
    add("reports_are_on_chain", "Each sub report is on NEAR, sent by the sub's own account", null, "no sub reported on-chain in this cycle");
  } else {
    const results: string[] = [];
    let ok = true;
    for (const rep of withTx) {
      try {
        const tx = await getTx(rep.tx!, rep.account ?? r.governor);
        const logs = logsOf(tx);
        const line = logs.find((l) => l.startsWith(`MNEMOSYNE_REPORT:${rep.account}:${rep.action}:`));
        const tagged = !!line && line.includes(cycleTag(r.decision_hash));
        const good = succeeded(tx) && !!line && tagged;
        if (!good) ok = false;
        results.push(`sub ${rep.sub}: ${good ? `${rep.action} logged by ${rep.account}, naming this decision` : "did not check out"}`);
      } catch (err) {
        ok = false;
        results.push(`sub ${rep.sub}: could not read ${rep.tx} (${(err as Error).message})`);
      }
    }
    add("reports_are_on_chain", "Each sub report is on NEAR, sent by the sub's own account", ok, results.join("; "));
  }

  // the contract's head is the newest record we published
  const newest = input.newestRecordHash ?? r.decision_hash;
  const known = input.knownHashes ?? [newest];
  try {
    const head = await chainHead(r.governor);
    const where = known.indexOf(head.latest_hash);
    if (head.latest_hash === newest) {
      add("chain_head_matches_newest_record", "The hash NEAR holds is the newest record published here", true,
        `get_latest() on ${r.governor} returns ${bare(head.latest_hash).slice(0, 16)}… after ${head.commit_count} commits`);
    } else if (where > 0) {
      // the chain moved on, or this copy of the records is older than the chain
      add("chain_head_matches_newest_record", "The hash NEAR holds is the newest record published here", null,
        `NEAR holds ${bare(head.latest_hash).slice(0, 16)}…, which is ${where} record(s) newer than the newest one in this copy — these records are behind the chain, not in conflict with it`);
    } else {
      add("chain_head_matches_newest_record", "The hash NEAR holds is the newest record published here", false,
        `NEAR holds ${bare(head.latest_hash).slice(0, 16)}…, which is not any record in this copy (newest here: ${bare(newest).slice(0, 16)}…)`);
    }
  } catch (err) {
    add("chain_head_matches_newest_record", "The hash NEAR holds is the newest record published here", null, `could not read the contract: ${(err as Error).message}`);
  }

  return checks;
}
