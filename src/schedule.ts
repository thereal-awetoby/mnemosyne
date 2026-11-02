/**
 * The automatic cycle runner (next-build handoff, section 3: "operator vs
 * automatic governor"). The governor does not have to wait on a person
 * clicking a button -- an interval, persisted here, says how often it runs
 * itself. Manual runs (POST /cycle/run) and scheduled runs share one clock:
 * either kind of run pushes the next automatic one back a full interval, so
 * clicking "Run cycle" never causes a second run a minute later.
 *
 * State lives in data/runtime/schedule.json (private, gitignored) so a
 * restart remembers it, and GET /schedule can tell anyone watching when the
 * next run is due without the admin token -- only PUT /schedule needs it.
 *
 * Fail-closed applies to automation too: after MAX_FAILURES cycles in a row
 * that did not commit, the schedule turns itself off. An unattended loop
 * that keeps failing quietly is worse than one that stops and waits for the
 * operator to look. This file is lower-stakes than src/limits (getting a
 * timer wrong costs a delayed cycle, not a risk breach), so unlike limits a
 * corrupt or out-of-range field is clamped back to its default on read
 * instead of blocking the server from starting.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ScheduleState {
  enabled: boolean;
  interval_minutes: number;
  last_run_at: string | null;
  last_result: "committed" | "failed" | null;
  last_error: string | null;
  consecutive_failures: number;
  updated_at: string | null;
  updated_by: string | null;
}

export interface ScheduleView extends ScheduleState {
  /** null while off; otherwise an ISO timestamp, even if it is already due */
  next_run_at: string | null;
}

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 1440;
export const MAX_FAILURES = 3;

const DEFAULTS: ScheduleState = {
  enabled: false,
  interval_minutes: 30,
  last_run_at: null,
  last_result: null,
  last_error: null,
  consecutive_failures: 0,
  updated_at: null,
  updated_by: null,
};

const fileOf = (dataDir: string) => join(dataDir, "schedule.json");

function readFile(dataDir: string): ScheduleState {
  const p = fileOf(dataDir);
  if (!existsSync(p)) return { ...DEFAULTS };
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    throw new Error(`schedule file ${p} is unreadable (${(err as Error).message}); fix or delete it`);
  }
  const interval =
    Number.isInteger(raw?.interval_minutes) && raw.interval_minutes >= MIN_INTERVAL_MINUTES && raw.interval_minutes <= MAX_INTERVAL_MINUTES
      ? raw.interval_minutes
      : DEFAULTS.interval_minutes;
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    interval_minutes: interval,
    last_run_at: typeof raw?.last_run_at === "string" ? raw.last_run_at : null,
    last_result: raw?.last_result === "committed" || raw?.last_result === "failed" ? raw.last_result : null,
    last_error: typeof raw?.last_error === "string" ? raw.last_error : null,
    consecutive_failures: Number.isInteger(raw?.consecutive_failures) && raw.consecutive_failures >= 0 ? raw.consecutive_failures : 0,
    updated_at: typeof raw?.updated_at === "string" ? raw.updated_at : null,
    updated_by: typeof raw?.updated_by === "string" ? raw.updated_by : null,
  };
}

function writeFile(dataDir: string, s: ScheduleState): void {
  mkdirSync(dataDir, { recursive: true });
  const p = fileOf(dataDir);
  writeFileSync(p + ".tmp", JSON.stringify(s, null, 2));
  renameSync(p + ".tmp", p); // atomic swap: a tick never reads a half-written file
}

/** For display only (GET /schedule, the dashboard). When it has never run,
 *  "now" is the honest answer -- it is due immediately -- so this is kept
 *  separate from isDue's own clock rather than round-tripped through it. */
function nextRunAt(s: ScheduleState): string | null {
  if (!s.enabled) return null;
  if (!s.last_run_at) return new Date().toISOString();
  return new Date(new Date(s.last_run_at).getTime() + s.interval_minutes * 60_000).toISOString();
}

export function scheduleView(dataDir: string): ScheduleView {
  const s = readFile(dataDir);
  return { ...s, next_run_at: nextRunAt(s) };
}

/** True once a run is due. Also true the instant it is switched on with no
 *  prior run, so turning it on does not silently wait out a full interval
 *  before the first automatic cycle. */
export function isDue(s: ScheduleState, now = Date.now()): boolean {
  if (!s.enabled) return false;
  if (!s.last_run_at) return true;
  const next = new Date(s.last_run_at).getTime() + s.interval_minutes * 60_000;
  return now >= next;
}

export type ScheduleSaveResult = { ok: true; view: ScheduleView } | { ok: false; errors: string[] };

/** Apply a partial change. Nothing is written unless every field is valid. */
export function saveSchedule(dataDir: string, changes: unknown, by: string): ScheduleSaveResult {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return { ok: false, errors: ["send a JSON object"] };
  const src = changes as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(src)) if (!["enabled", "interval_minutes"].includes(k)) errors.push(`unknown field "${k}"`);

  const cur = readFile(dataDir);
  const next: ScheduleState = { ...cur };
  if ("interval_minutes" in src) {
    const n = src.interval_minutes;
    if (typeof n !== "number" || !Number.isInteger(n) || n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) {
      errors.push(`interval_minutes must be a whole number from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}`);
    } else next.interval_minutes = n;
  }
  if ("enabled" in src) {
    if (typeof src.enabled !== "boolean") errors.push("enabled must be true or false");
    else next.enabled = src.enabled;
  }
  if (errors.length) return { ok: false, errors };

  // switching it on gets a fresh failure count: an old streak should not
  // immediately disable a schedule the operator just turned back on
  if (next.enabled && !cur.enabled) next.consecutive_failures = 0;
  next.updated_at = new Date().toISOString();
  next.updated_by = by;
  writeFile(dataDir, next);
  return { ok: true, view: scheduleView(dataDir) };
}

/** Record the outcome of a run, scheduled or manually triggered -- either
 *  way the next automatic run should wait a full interval from here. Turns
 *  the schedule off after MAX_FAILURES in a row (fail-closed automation). */
export function recordRun(dataDir: string, result: { committed: boolean; error?: string | null }): ScheduleView {
  const cur = readFile(dataDir);
  const next: ScheduleState = {
    ...cur,
    last_run_at: new Date().toISOString(),
    last_result: result.committed ? "committed" : "failed",
    last_error: result.committed ? null : (result.error ?? "the cycle did not commit"),
    consecutive_failures: result.committed ? 0 : cur.consecutive_failures + 1,
  };
  if (!result.committed && next.consecutive_failures >= MAX_FAILURES && next.enabled) {
    next.enabled = false;
    next.last_error = `${next.last_error} — stopped itself after ${MAX_FAILURES} failed cycles in a row; fix the cause, then turn it back on`;
  }
  writeFile(dataDir, next);
  return scheduleView(dataDir);
}

export interface TickOptions {
  dataDir: string;
  /** true while a cycle, scheduled or manual, is already running */
  isBusy: () => boolean;
  runCycle: () => Promise<{ committed: boolean; error?: string | null }>;
}

/** Called roughly once a minute by the server. Runs a cycle, and records the
 *  result, only when the schedule is on, due, and nothing else is running.
 *  Never throws: a tick that could not run is simply a tick that did nothing. */
export async function tick(opts: TickOptions): Promise<void> {
  const s = scheduleView(opts.dataDir);
  if (!s.enabled) return;
  if (opts.isBusy()) return; // try again next tick rather than queue or overlap
  if (!isDue(s)) return;
  try {
    const r = await opts.runCycle();
    recordRun(opts.dataDir, r);
  } catch (err) {
    recordRun(opts.dataDir, { committed: false, error: (err as Error).message });
  }
}
