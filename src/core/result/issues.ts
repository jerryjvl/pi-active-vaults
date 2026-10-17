// Problems found while validating plain data — the installation config,
// frontmatter, script headers. An issue names where the problem is and what is
// wrong, and never repeats the value: a rejected value may be a secret pasted
// by mistake, or a URL with credentials in it.

import { err, ok, type Result } from './result.ts';

export interface Issue {
  /** Where, as a dotted path with list indexes: `vaults[0].path`. */
  readonly path: string;
  readonly message: string;
}

/** `parent.key`, or just `key` at the top. */
export function issuePath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}

type PlainObject = Record<string, unknown>;

/**
 * Reads untyped data and collects issues. Every read returns a usable value
 * even after a problem, so one pass reports every problem, and `result`
 * turns the outcome into a value — never a partly valid one.
 */
export class DataReader {
  readonly issues: Issue[] = [];

  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  /** The value when nothing was wrong, otherwise every issue found. */
  result<T>(value: T): Result<T, Issue[]> {
    return this.issues.length > 0 ? err(this.issues) : ok(value);
  }

  /** A mapping; when `allowed` is given, any other key is an issue (a typo must not pass silently). */
  record(value: unknown, path: string, allowed?: readonly string[]): PlainObject {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.add(path, 'must be a mapping');
      return {};
    }
    for (const key of Object.keys(value)) {
      if (allowed !== undefined && !allowed.includes(key)) this.add(issuePath(path, key), 'unknown key');
    }
    return value as PlainObject;
  }

  list(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) {
      this.add(path, 'must be a list');
      return [];
    }
    return value;
  }

  string(value: unknown, path: string, pattern?: RegExp): string {
    if (typeof value !== 'string' || value === '' || (pattern !== undefined && !pattern.test(value))) {
      this.add(path, pattern === undefined ? 'must be a non-empty string' : 'is not in the expected form');
      return '';
    }
    return value;
  }

  optionalString(record: PlainObject, key: string, path: string, pattern?: RegExp): string | undefined {
    return record[key] === undefined ? undefined : this.string(record[key], issuePath(path, key), pattern);
  }

  boolean(record: PlainObject, key: string, path: string, fallback: boolean): boolean {
    const value = record[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      this.add(issuePath(path, key), 'must be true or false');
      return fallback;
    }
    return value;
  }

  integer(record: PlainObject, key: string, path: string, fallback: number): number;
  integer(record: PlainObject, key: string, path: string, fallback?: undefined): number | undefined;
  integer(record: PlainObject, key: string, path: string, fallback?: number): number | undefined {
    const value = record[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      this.add(issuePath(path, key), 'must be a positive whole number');
      return fallback;
    }
    return value;
  }

  stringList(value: unknown, path: string): string[] {
    return this.list(value, path).map((item, i) => this.string(item, `${path}[${i}]`));
  }

  /** One of `options`; anything else is an issue and reads as undefined. */
  oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T | undefined {
    const found = options.find((option) => option === value);
    if (found === undefined) this.add(path, `must be one of ${options.join(', ')}`);
    return found;
  }
}
