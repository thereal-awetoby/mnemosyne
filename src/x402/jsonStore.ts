/**
 * Tiny JSON-file persistence with atomic writes (write temp file, rename).
 * Good enough for one server process; not a database.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class JsonStore<T> {
  private value: T;

  constructor(private readonly path: string, initial: () => T) {
    if (existsSync(path)) {
      this.value = JSON.parse(readFileSync(path, "utf8")) as T;
    } else {
      this.value = initial();
    }
  }

  get(): T {
    return this.value;
  }

  /** Mutate, then persist. If the write fails the error propagates, so a
   *  caller never reports success for state that wasn't saved. */
  update(fn: (v: T) => void): void {
    fn(this.value);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    renameSync(tmp, this.path);
  }
}
