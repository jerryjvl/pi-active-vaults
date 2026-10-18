// Merging a chain of contracts, root first, into an effective contract.
//
// Each key merges by its strategy (concepts.md "Contracts"); any key the design
// does not name is the vault's own and merges `nearest`. Contracts check only
// the shape a strategy needs (a list, a mapping); the meaning of each value is
// checked by the module that owns it — merge rules by `policy`, conditions by
// `conditions`, the vault identity by `registry` — so each concept is
// validated in one place. An invalid contract yields every issue and no
// effective contract: a gate must never act on part of a policy.

import { isDeepStrictEqual } from 'node:util';
import { DataReader, err, ok, type Issue, type Result } from '../result/index.ts';

export type Strategy = 'nearest' | 'merge' | 'list-ops' | 'tighten-only' | 'locked';

/** A `_contract.md` as read: its path in the vault, its frontmatter and its prose. */
export interface ContractFile {
  readonly path: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
}

export interface EffectiveContract {
  /** Each key's merged value. */
  readonly values: Readonly<Record<string, unknown>>;
  /** The contracts that contributed each key's value, root first. */
  readonly origins: Readonly<Record<string, readonly string[]>>;
  /** Prose to inject, root first; contracts without prose are left out. */
  readonly prose: readonly { readonly path: string; readonly body: string }[];
  /** Every governing contract, root first. */
  readonly contracts: readonly string[];
}

export const ROOT_CONTRACT = '_contract.md';

type Shape = (r: DataReader, value: unknown, where: string) => boolean;

const isList: Shape = (r, value, where) => {
  r.list(value, where);
  return Array.isArray(value);
};
const isMapping: Shape = (r, value, where) => {
  const before = r.issues.length;
  r.record(value, where);
  return r.issues.length === before;
};
const isString: Shape = (r, value, where) => r.string(value, where) !== '';
const isMappingOfMappings: Shape = (r, value, where) => {
  const ok = typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry));
  if (!ok) r.add(where, 'must be a mapping of names to mappings');
  return ok;
};
const isIndexMode: Shape = (r, value, where) => r.oneOf(value, where, ['default', 'opt-in', 'none']) !== undefined;

const KEYS: Readonly<Record<string, { readonly strategy: Strategy; readonly shape: Shape }>> = {
  vault: { strategy: 'locked', shape: isMapping },
  template: { strategy: 'locked', shape: isMapping },
  merge: { strategy: 'tighten-only', shape: isList },
  index: { strategy: 'nearest', shape: isIndexMode },
  naming: { strategy: 'nearest', shape: isString },
  axes: { strategy: 'merge', shape: isMappingOfMappings },
  'applies-when': { strategy: 'list-ops', shape: isList },
};

function strategyOf(key: string): Strategy {
  return KEYS[key]?.strategy ?? 'nearest';
}

type ListOp = { readonly op: '+' | '-'; readonly value: unknown };

/** `+x`/`-x` for names; `+: {…}`/`-: {…}` for mappings; anything else is a plain item. */
function asListOp(item: unknown): ListOp | 'invalid' | undefined {
  if (typeof item === 'string' && (item.startsWith('+') || item.startsWith('-'))) {
    return item.length > 1 ? { op: item[0] as '+' | '-', value: item.slice(1) } : 'invalid';
  }
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    const keys = Object.keys(item);
    if (keys.length === 1 && (keys[0] === '+' || keys[0] === '-')) return { op: keys[0], value: (item as Record<string, unknown>)[keys[0]] };
  }
  return undefined;
}

function editList(inherited: readonly unknown[], edit: unknown): Result<{ list: unknown[]; replaced: boolean }, string> {
  if (!Array.isArray(edit)) return err('must be a list');
  const ops = edit.map(asListOp);
  if (ops.includes('invalid')) return err('a + or - item must name what it adds or removes');
  if (ops.every((op) => op === undefined)) return ok({ list: [...edit], replaced: true });
  if (ops.some((op) => op === undefined)) return err('cannot mix + and - edits with plain items');
  let list = [...inherited];
  for (const op of ops as ListOp[]) {
    if (op.op === '-') list = list.filter((item) => !isDeepStrictEqual(item, op.value));
    else if (!list.some((item) => isDeepStrictEqual(item, op.value))) list.push(op.value);
  }
  return ok({ list, replaced: false });
}

/**
 * The contract list syntax (also used by MCP permissions): a plain list
 * replaces `inherited`; `+x` adds and `-x` removes equal items, in order.
 */
export function applyListOps(inherited: readonly unknown[], edit: unknown): Result<unknown[], string> {
  const edited = editList(inherited, edit);
  return edited.ok ? ok(edited.value.list) : edited;
}

/** Merges `chain` (governing contracts, root first) into one effective contract. */
export function mergeContracts(chain: readonly ContractFile[]): Result<EffectiveContract, Issue[]> {
  const r = new DataReader();
  const values: Record<string, unknown> = {};
  const origins: Record<string, string[]> = {};
  const contribute = (key: string, path: string, value: unknown, replace: boolean): void => {
    values[key] = value;
    origins[key] = replace ? [path] : [...(origins[key] ?? []), path];
  };

  for (const file of chain) {
    for (const [key, value] of Object.entries(file.frontmatter)) {
      const where = `${file.path}:${key}`;
      const known = KEYS[key];
      if (known !== undefined && !known.shape(r, value, where)) continue;
      switch (strategyOf(key)) {
        case 'locked':
          if (file.path === ROOT_CONTRACT) contribute(key, file.path, value, true);
          else r.add(where, 'may be set only in the root contract');
          break;
        case 'nearest':
          contribute(key, file.path, value, true);
          break;
        case 'merge':
          if (Object.keys(value as object).length > 0) contribute(key, file.path, { ...(values[key] as object | undefined), ...(value as object) }, false);
          break;
        case 'tighten-only':
          // Rules only accumulate: a deeper contract has no way to remove one.
          if ((value as unknown[]).length > 0) contribute(key, file.path, [...((values[key] as unknown[] | undefined) ?? []), ...(value as unknown[])], false);
          break;
        case 'list-ops': {
          const edited = editList((values[key] as unknown[] | undefined) ?? [], value);
          if (edited.ok) contribute(key, file.path, edited.value.list, edited.value.replaced);
          else r.add(where, edited.error);
          break;
        }
      }
    }
  }

  return r.result({
    values,
    origins,
    prose: chain.filter((file) => file.body.trim() !== '').map(({ path, body }) => ({ path, body })),
    contracts: chain.map((file) => file.path),
  });
}
