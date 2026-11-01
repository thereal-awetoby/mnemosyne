/**
 * Read-only data for the dashboard (GET /dashboard.json). Nothing here can
 * sign, move funds or run a cycle. Sources:
 *
 *   chain     get_latest on the governor contract (NEAR RPC view call)
 *   cycles    data/runtime/public/<cycle>.json      public MemoryRecord
 *             data/runtime/public/<cycle>.run.json  commit + report tx hashes
 *   keys      view_access_key_list on each sub account (NEAR RPC); the agent's
 *             own key is identified from SUB_<X>_PRIVATE_KEY's public half
 *
 * Private blobs (data/runtime/private/) are never read.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { SUB_AGENTS, subAccountId, subPrivateKey } from "../subAgents.js";
import { capitalUnitYocto, fmtWnear, ftBalance, swarmAsset, swarmSource, yoctoToUnits } from "../swarmState.js";

const RPC_URL = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
const MAX_CYCLES = 30;

export interface SubKeyInfo {
  account: string;
  /** the key this agent signs with, as NEAR reports it */
  agent_key: { public_key: string; kind: "function_call" | "full_access" | "missing" | "unknown"; receiver?: string; methods?: string[]; allowance?: string | null } | null;
  full_access_keys: number;
  function_call_keys: number;
  error?: string;
}

async function rpc(params: unknown): Promise<any> {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "dash", method: "query", params }),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error).slice(0, 200));
  return j.result;
}

function agentPublicKey(sub: string): string | null {
  const sk = subPrivateKey(sub as any);
  if (!sk) return null;
  try { return KeyPair.fromString(sk as any).getPublicKey().toString(); } catch { return null; }
}

export async function readSubKeys(): Promise<Record<string, SubKeyInfo>> {
  const out: Record<string, SubKeyInfo> = {};
  await Promise.all(SUB_AGENTS.map(async (s) => {
    const account = subAccountId(s.id);
    const info: SubKeyInfo = { account, agent_key: null, full_access_keys: 0, function_call_keys: 0 };
    try {
      const res = await rpc({ request_type: "view_access_key_list", finality: "final", account_id: account });
      const keys: any[] = res.keys ?? [];
      for (const k of keys) {
        if (k.access_key?.permission === "FullAccess") info.full_access_keys++;
        else info.function_call_keys++;
      }
      const pk = agentPublicKey(s.id);
      if (pk) {
        const k = keys.find((x) => x.public_key === pk);
        const perm = k?.access_key?.permission;
        info.agent_key = !k
          ? { public_key: pk, kind: "missing" }
          : perm === "FullAccess"
            ? { public_key: pk, kind: "full_access" }
            : perm?.FunctionCall
              ? { public_key: pk, kind: "function_call", receiver: perm.FunctionCall.receiver_id, methods: perm.FunctionCall.method_names ?? [], allowance: perm.FunctionCall.allowance ?? null }
              : { public_key: pk, kind: "unknown" };
      }
    } catch (err) {
      info.error = (err as Error).message;
    }
    out[s.id] = info;
  }));
  return out;
}

export function readCycles(dataDir: string): Array<{ record: any; run: any | null }> {
  const dir = join(dataDir, "public");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".run.json")).sort().reverse().slice(0, MAX_CYCLES);
  const out: Array<{ record: any; run: any | null }> = [];
  for (const f of files) {
    try {
      const record = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const runPath = join(dir, f.replace(/\.json$/, ".run.json"));
      const run = existsSync(runPath) ? JSON.parse(readFileSync(runPath, "utf8")) : null;
      out.push({ record, run });
    } catch { /* skip unreadable files */ }
  }
  return out;
}

export interface DashboardDeps {
  dataDir: string;
  contract: string;
  readHead: () => Promise<{ latest_hash: string | null; prev_hash: string | null; commit_count: number }>;
}

let keyCache: { at: number; value: Record<string, SubKeyInfo> } | null = null;

export interface SwarmInfo {
  /** "onchain": balances below are real wNEAR; "simulated": the swarm is a fixed scenario */
  source: "simulated" | "onchain";
  asset: string;
  unit_yocto: string;
  balances: Record<string, { account: string; yocto: string; units: number; wnear: string }> | null;
  error?: string;
}

let balanceCache: { at: number; value: SwarmInfo } | null = null;

/** Live wNEAR balance of each sub (only in on-chain mode). Cached for 15 s. */
export async function readSwarmInfo(): Promise<SwarmInfo> {
  const source = swarmSource();
  const unit = capitalUnitYocto();
  const base = { source, asset: swarmAsset(), unit_yocto: unit.toString() };
  if (source === "simulated") return { ...base, balances: null };
  if (balanceCache && Date.now() - balanceCache.at < 15_000) return balanceCache.value;
  const balances: NonNullable<SwarmInfo["balances"]> = {};
  let value: SwarmInfo;
  try {
    for (const s of SUB_AGENTS) {
      const account = subAccountId(s.id);
      const y = await ftBalance(account);
      balances[s.id] = { account, yocto: y.toString(), units: yoctoToUnits(y, unit), wnear: fmtWnear(y) };
    }
    value = { ...base, balances };
  } catch (err) {
    value = { ...base, balances: null, error: (err as Error).message };
  }
  balanceCache = { at: Date.now(), value };
  return value;
}

export async function buildDashboard(d: DashboardDeps) {
  const [head, keys, swarm] = await Promise.all([
    d.readHead().then((h) => ({ ok: true as const, ...h })).catch((err) => ({ ok: false as const, error: (err as Error).message })),
    keyCache && Date.now() - keyCache.at < 60_000
      ? Promise.resolve(keyCache.value)
      : readSubKeys().then((v) => { keyCache = { at: Date.now(), value: v }; return v; }),
    readSwarmInfo(),
  ]);
  return {
    generated_at: new Date().toISOString(),
    network: "testnet",
    contract: d.contract,
    chain: head,
    swarm,
    cycles: readCycles(d.dataDir),
    subs: SUB_AGENTS.map((s) => ({ id: s.id, mandate: s.mandate, description: s.description, keys: keys[s.id] })),
  };
}
