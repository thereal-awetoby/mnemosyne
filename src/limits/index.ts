/**
 * The owner's risk limits (the "rails").
 *
 * What a person may change here is the envelope the governor works inside:
 * total exposure, the per-sub ceiling, growth per cycle, the loss that pauses
 * a sub, and the derived max-position / max-loss shares. What they may NOT
 * change by hand is the per-cycle numbers (each sub's target, max position,
 * max loss). Those are the governor's decision for that cycle, and their hash
 * is committed on-chain. Editing one by hand would break the audit trail.
 *
 * Every cycle reads the current limits, uses them to guard the decision, and
 * writes them into the public memory record (swarm_risk), so the limits that
 * applied to any cycle are on-chain with it.
 *
 * Hard bounds live in code (LIMIT_SPECS). The UI and the API cannot go outside
 * them, whoever is asking. The file on disk is re-checked on every read, and a
 * corrupt or out-of-bounds file stops the cycle instead of silently falling
 * back to defaults (fail-closed).
 *
 * Today the owner proves who they are with ADMIN_TOKEN. The shape (updated_by,
 * history) is ready for a per-account NEAR sign-in later.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ENVELOPE, type RiskEnvelope } from "../private/decide.js";

export type LimitKey = keyof RiskEnvelope;

export interface LimitSpec {
  key: LimitKey;
  label: string;
  help: string;
  kind: "int" | "ratio";
  min: number;
  max: number;
  /** how the UI shows it: "units", "x" (a multiplier) or "%" (stored as a fraction) */
  unit: "units" | "x" | "%";
}

export const LIMIT_SPECS: LimitSpec[] = [
  { key: "max_total_exposure", label: "Total exposure", help: "The most capital the whole swarm may hold.", kind: "int", min: 100, max: 5000, unit: "units" },
  { key: "per_sub_max_capital", label: "Per-sub ceiling", help: "The most capital any one sub-agent may hold.", kind: "int", min: 100, max: 3000, unit: "units" },
  { key: "max_daily_loss", label: "Daily loss", help: "The most the swarm may lose in a day.", kind: "int", min: 10, max: 500, unit: "units" },
  { key: "pause_loss_threshold", label: "Pause at loss", help: "A sub that lost more than this last cycle is paused.", kind: "int", min: 10, max: 300, unit: "units" },
  { key: "max_growth", label: "Growth per cycle", help: "How much a sub's capital may grow in one cycle (1.25 means +25%).", kind: "ratio", min: 1, max: 2, unit: "x" },
  { key: "max_position_pct", label: "Max position", help: "Share of a sub's target it may put into one position.", kind: "ratio", min: 0.05, max: 0.3, unit: "%" },
  { key: "max_loss_pct", label: "Max loss per cycle", help: "Share of a sub's target it may lose in one cycle.", kind: "ratio", min: 0.01, max: 0.1, unit: "%" },
];

const KEYS = LIMIT_SPECS.map((s) => s.key);

export type ValidationResult = { ok: true; limits: RiskEnvelope } | { ok: false; errors: string[] };

const shown = (s: LimitSpec, v: number) => (s.unit === "%" ? `${+(v * 100).toFixed(2)}%` : s.unit === "x" ? `${v}x` : String(v));

/**
 * Check a (possibly partial) set of limits on top of `base`. Strict: unknown
 * keys, non-numbers, out-of-bounds values and contradictions are all errors.
 */
export function validateLimits(input: unknown, base: RiskEnvelope = DEFAULT_ENVELOPE): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["send a JSON object of limits"] };
  const src = input as Record<string, unknown>;
  for (const k of Object.keys(src)) if (!(KEYS as string[]).includes(k)) errors.push(`unknown limit "${k}"`);

  const next: RiskEnvelope = { ...base };
  for (const s of LIMIT_SPECS) {
    if (!(s.key in src)) continue;
    const v = src[s.key];
    if (typeof v !== "number" || !Number.isFinite(v)) { errors.push(`${s.label}: must be a number`); continue; }
    if (s.kind === "int" && !Number.isInteger(v)) { errors.push(`${s.label}: must be a whole number`); continue; }
    if (v < s.min || v > s.max) { errors.push(`${s.label}: must be between ${shown(s, s.min)} and ${shown(s, s.max)}`); continue; }
    next[s.key] = s.kind === "ratio" ? Math.round(v * 10000) / 10000 : v;
  }
  if (errors.length) return { ok: false, errors };

  if (next.per_sub_max_capital > next.max_total_exposure) errors.push("Per-sub ceiling cannot be more than total exposure");
  if (next.max_daily_loss > next.max_total_exposure) errors.push("Daily loss cannot be more than total exposure");
  return errors.length ? { ok: false, errors } : { ok: true, limits: next };
}

export interface LimitChange { at: string; by: string; changes: Record<string, { from: number; to: number }> }

export interface LimitsFile {
  limits: RiskEnvelope;
  updated_at: string | null;
  updated_by: string | null;
  history: LimitChange[];
}

export interface LimitsView extends LimitsFile {
  source: "default" | "owner";
  defaults: RiskEnvelope;
  specs: LimitSpec[];
}

const MAX_HISTORY = 20;
const fileOf = (dataDir: string) => join(dataDir, "limits.json");

function readFile(dataDir: string): LimitsFile | null {
  const p = fileOf(dataDir);
  if (!existsSync(p)) return null;
  let raw: any;
  try { raw = JSON.parse(readFileSync(p, "utf8")); } catch (err) { throw new Error(`limits file ${p} is unreadable (${(err as Error).message}); fix or delete it`); }
  // re-check bounds on every read, from scratch: a hand-edited file must not slip past
  const full = validateLimits(raw?.limits ?? {}, DEFAULT_ENVELOPE);
  const missing = KEYS.filter((k) => typeof raw?.limits?.[k] !== "number");
  if (!full.ok || missing.length) throw new Error(`limits file ${p} is not valid (${full.ok ? "missing " + missing.join(", ") : full.errors.join("; ")}); fix or delete it`);
  return { limits: full.limits, updated_at: raw.updated_at ?? null, updated_by: raw.updated_by ?? null, history: Array.isArray(raw.history) ? raw.history.slice(-MAX_HISTORY) : [] };
}

function writeFile(dataDir: string, f: LimitsFile): void {
  mkdirSync(dataDir, { recursive: true });
  const p = fileOf(dataDir);
  writeFileSync(p + ".tmp", JSON.stringify(f, null, 2));
  renameSync(p + ".tmp", p); // atomic swap: a cycle never reads a half-written file
}

/** "owner" only while the limits really differ from the built-in defaults. */
const sourceOf = (l: RiskEnvelope): "default" | "owner" => (KEYS.some((k) => l[k] !== DEFAULT_ENVELOPE[k]) ? "owner" : "default");

/** The envelope the next cycle will use. Throws if the stored file is bad. */
export function loadLimits(dataDir: string): { limits: RiskEnvelope; source: "default" | "owner" } {
  const f = readFile(dataDir);
  return f ? { limits: f.limits, source: sourceOf(f.limits) } : { limits: { ...DEFAULT_ENVELOPE }, source: "default" };
}

export function limitsView(dataDir: string): LimitsView {
  const f = readFile(dataDir);
  return {
    limits: f ? f.limits : { ...DEFAULT_ENVELOPE },
    updated_at: f?.updated_at ?? null,
    updated_by: f?.updated_by ?? null,
    history: f?.history ?? [],
    source: f ? sourceOf(f.limits) : "default",
    defaults: { ...DEFAULT_ENVELOPE },
    specs: LIMIT_SPECS,
  };
}

function diff(from: RiskEnvelope, to: RiskEnvelope): LimitChange["changes"] {
  const out: LimitChange["changes"] = {};
  for (const k of KEYS) if (from[k] !== to[k]) out[k] = { from: from[k], to: to[k] };
  return out;
}

export type SaveResult = { ok: true; view: LimitsView } | { ok: false; errors: string[] };

/** Apply a partial change. Nothing is written unless every value is valid. */
export function saveLimits(dataDir: string, changes: unknown, by: string): SaveResult {
  const cur = readFile(dataDir);
  const base = cur?.limits ?? DEFAULT_ENVELOPE;
  const v = validateLimits(changes, base);
  if (!v.ok) return v;
  const delta = diff(base, v.limits);
  if (!Object.keys(delta).length) return { ok: true, view: limitsView(dataDir) };
  const at = new Date().toISOString();
  writeFile(dataDir, { limits: v.limits, updated_at: at, updated_by: by, history: [...(cur?.history ?? []), { at, by, changes: delta }].slice(-MAX_HISTORY) });
  return { ok: true, view: limitsView(dataDir) };
}

/** Back to the built-in defaults (recorded in the history). */
export function resetLimits(dataDir: string, by: string): SaveResult {
  return saveLimits(dataDir, { ...DEFAULT_ENVELOPE }, by);
}

/** The public, on-chain face of the limits: written into every memory record. */
export function envelopeToSwarmRisk(e: RiskEnvelope) {
  return {
    max_total_exposure: String(e.max_total_exposure),
    max_daily_loss: String(e.max_daily_loss),
    per_sub_max_capital: String(e.per_sub_max_capital),
    pause_loss_threshold: String(e.pause_loss_threshold),
    max_growth: String(e.max_growth),
    max_position_pct: String(e.max_position_pct),
    max_loss_pct: String(e.max_loss_pct),
  };
}
