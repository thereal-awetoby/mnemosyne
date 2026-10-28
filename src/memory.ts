/**
 * Memory gate (docs/BUILD_PLAN.md sections 5 & 8).
 *
 * Phase 1 (this file, right now): the "memory commit" is simulated —
 * we hash the decision and append it to a local JSON log
 * (memory-log.json, gitignored) instead of writing to NEAR. The shape
 * of everything (hash-first, fail-closed) is real; only the storage
 * backend is fake.
 *
 * Phase 2 replaces writeMemoryRecord()'s body with a real NEAR testnet
 * transaction and keeps the same function signature, so nothing else
 * in the cycle has to change.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { MemoryRecord } from "./types.js";

const LOG_PATH = new URL("../memory-log.json", import.meta.url);

export function hashDecision(record: Omit<MemoryRecord, "decision_hash">): string {
  const canonical = JSON.stringify(record);
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

async function readLog(): Promise<MemoryRecord[]> {
  if (!existsSync(LOG_PATH)) return [];
  const raw = await readFile(LOG_PATH, "utf-8");
  return raw.trim() ? (JSON.parse(raw) as MemoryRecord[]) : [];
}

export async function getLatestMemoryRecord(): Promise<MemoryRecord | null> {
  const log = await readLog();
  return log.length ? log[log.length - 1] : null;
}

/**
 * Mandatory gate: append-commits a memory record.
 *
 * Returns `{ committed: true }` on success. On any failure, returns
 * `{ committed: false }` and does NOT throw — the caller (cycle.ts) is
 * responsible for treating a failed commit as fail-closed: the cycle
 * must end, and no capital/authority action may follow.
 */
export async function writeMemoryRecord(
  record: MemoryRecord
): Promise<{ committed: boolean; error?: string }> {
  try {
    const log = await readLog();
    log.push(record);
    await writeFile(LOG_PATH, JSON.stringify(log, null, 2), "utf-8");
    return { committed: true };
  } catch (err) {
    return { committed: false, error: (err as Error).message };
  }
}
