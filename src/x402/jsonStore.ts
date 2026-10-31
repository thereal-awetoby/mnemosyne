/**
 * Tiny JSON-file persistence with atomic writes (write temp file, rename).
 * Good enough for one server process; not a database or a multi-process lock.
 * A failed mutation or write leaves the last successfully saved value intact.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class JsonStore<T> {
  private value: T;

  constructor(private readonly path: string, initial: () => T) {
    if (existsSync(path)) {
      // Corrupt state must fail startup, never silently reset a spent ledger.
      this.value = JSON.parse(readFileSync(path, "utf8")) as T;
    } else {
      this.value = initial();
    }
  }

  get(): T {
    return this.value;
  }

  /** Mutate a copy, persist it, then publish it in memory. In particular, a
   *  failed ledger write must not burn a nonce that was never saved. */
  update(fn: (v: T) => void): void {
    const next = structuredClone(this.value);
    fn(next);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(next, null, 2), "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.path);
    } catch (err) {
      try { rmSync(tmp, { force: true }); } catch { /* preserve the original write error */ }
      throw err;
    }
    this.value = next;
  }
}
