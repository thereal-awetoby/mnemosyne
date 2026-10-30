/**
 * Mnemosyne's private memory: past failures and the rules learned from them.
 *
 * Public vs private, enforced here by construction:
 *   leaves the server : id (citation), category, public_summary, score
 *   never leaves      : keywords, private_detail, the rest of the store
 *
 * Matching is deliberately simple and explainable: the share of an entry's
 * keywords that appear in the query. Deterministic, no model call.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonStore } from "./jsonStore.js";

export interface MemoryEntry {
  id: string;
  category: string;
  keywords: string[];
  public_summary: string;
  private_detail: string;
  created_at?: string;
}

export interface CheckResult {
  match: boolean;
  citation_id: string | null;
  category: string | null;
  advice: string | null;
  score: number;
}

const STOPWORDS = new Set(
  "a an the and or but if then of to in on for with by from at as is are was were be been it its this that these those we our i you my your can cannot not no do does did have has had will would should could into out over under than so".split(" ")
);

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.add(raw);
    // crude plural/verb stemming so "keys"/"deleted" hit "key"/"delete"
    if (raw.length > 4 && raw.endsWith("ing")) out.add(raw.slice(0, -3));
    if (raw.length > 3 && raw.endsWith("ed")) { out.add(raw.slice(0, -2)); out.add(raw.slice(0, -1)); }
    if (raw.length > 3 && raw.endsWith("es")) out.add(raw.slice(0, -2));
    if (raw.length > 2 && raw.endsWith("s")) out.add(raw.slice(0, -1));
  }
  return out;
}

export const MATCH_THRESHOLD = 0.4;
export const MIN_KEYWORD_HITS = 3;
export const MAX_QUERY_CHARS = 2000;

export class MemoryStore {
  private store: JsonStore<{ entries: MemoryEntry[] }>;

  constructor(dataDir: string, seedPath: string) {
    this.store = new JsonStore(join(dataDir, "memory.json"), () => {
      const seed = JSON.parse(readFileSync(seedPath, "utf8")) as { entries: MemoryEntry[] };
      return { entries: seed.entries };
    });
  }

  get size(): number {
    return this.store.get().entries.length;
  }

  check(query: string): CheckResult {
    const q = tokenize(query.slice(0, MAX_QUERY_CHARS));
    let best: { e: MemoryEntry; score: number; hits: number } | null = null;
    for (const e of this.store.get().entries) {
      const kws = [...new Set(e.keywords.map((k) => k.toLowerCase()))];
      if (kws.length === 0) continue;
      const hits = kws.filter((k) => q.has(k)).length;
      const score = hits / kws.length;
      if (!best || score > best.score || (score === best.score && hits > best.hits)) best = { e, score, hits };
    }
    const score = best ? Math.round(best.score * 1000) / 1000 : 0;
    if (!best || best.score < MATCH_THRESHOLD || best.hits < MIN_KEYWORD_HITS) {
      return { match: false, citation_id: null, category: null, advice: null, score };
    }
    return { match: true, citation_id: best.e.id, category: best.e.category, advice: best.e.public_summary, score };
  }

  /** Governor-only: append a rule learned from a real failure. */
  confess(input: { category: string; keywords: string[]; public_summary: string; private_detail: string }): string {
    const entries = this.store.get().entries;
    const next = entries.reduce((m, e) => Math.max(m, Number(e.id.replace(/^M-/, "")) || 0), 0) + 1;
    const id = `M-${String(next).padStart(3, "0")}`;
    this.store.update((s) => {
      s.entries.push({ id, ...input, created_at: new Date().toISOString() });
    });
    return id;
  }
}
