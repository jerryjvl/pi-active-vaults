// The catalogue of operations (principle 17, core.md `operations`): every
// operation once, in the order surfaces list them. Pi tools, Pi commands, CLI
// commands and MCP tools are generated from it, so they behave identically.
//
// Invariants:
//  - an operation offered over MCP is named by a permission, and every
//    permission names one (checked by the tests);
//  - parameters are checked against their specs before an operation runs:
//    an unknown one, a wrong kind, a missing required one or a value outside
//    its choices is refused with every problem, never coerced;
//  - which vaults an operation acts on is decided here, the same for every
//    surface: the ones named, else the one the caller is in, else — for an
//    operation over many — every registered vault.

import type { Installation } from './installation.ts';
import { acceptOperation, commitOperation, proposeOperation, reviewOperation, statusOperation, syncOperation, writeOperation } from './ops/proposals.ts';
import { contractOperation, readOperation, reindexOperation, searchOperation } from './ops/knowledge.ts';
import { doctorOperation } from './ops/doctor.ts';
import { addOperation, initOperation, listOperation, templateShowOperation, whoamiOperation } from './ops/installation.ts';
import { jobsOperation, notifyOperation, runOperation as runJobOperation, scriptOperation, traceOperation, triggerOperation } from './ops/work.ts';
import { DataReader, err, ok, type Issue, type Result } from '../result/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import type { OperationContext } from './context.ts';
import type { Operation, OperationOutcome, OperationRequest, ParamSpec, ParamSurface } from './types.ts';

export const CATALOGUE: readonly Operation[] = [
  searchOperation, readOperation, contractOperation, jobsOperation, statusOperation, traceOperation,
  writeOperation, commitOperation, proposeOperation,
  runJobOperation, triggerOperation, scriptOperation, notifyOperation,
  reviewOperation, acceptOperation, reindexOperation,
  syncOperation,
  listOperation, addOperation, initOperation, whoamiOperation, templateShowOperation, doctorOperation,
];

export function operationNamed(name: string): Operation | undefined {
  return CATALOGUE.find((operation) => operation.name === name);
}

/** The parameters `surface` offers for the operation. */
export function paramsOn(operation: Operation, surface: ParamSurface): ParamSpec[] {
  return operation.params.filter((p) => p.surfaces === undefined || p.surfaces.includes(surface));
}

function kindOk(spec: ParamSpec, value: unknown): boolean {
  switch (spec.kind) {
    case 'string':
      return typeof value === 'string';
    case 'strings':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
  }
}

/** The parameters as given, if they fit the operation's specs on `surface`; otherwise every problem. */
export function checkParams(operation: Operation, surface: ParamSurface, params: Readonly<Record<string, unknown>>): Result<Record<string, unknown>, Issue[]> {
  const r = new DataReader();
  const offered = paramsOn(operation, surface);
  for (const name of Object.keys(params)) {
    if (!offered.some((p) => p.name === name)) r.add(name, 'is not a parameter of this operation');
  }
  for (const spec of offered) {
    const value = params[spec.name];
    if (value === undefined) {
      if (spec.required === true) r.add(spec.name, 'is required');
    } else if (!kindOk(spec, value)) {
      r.add(spec.name, `must be ${spec.kind === 'strings' ? 'a list of strings' : `a${spec.kind === 'integer' ? 'n' : ''} ${spec.kind}`}`);
    } else if (spec.choices !== undefined && !spec.choices.includes(value as string)) {
      r.add(spec.name, `must be one of: ${spec.choices.join(', ')}`);
    }
  }
  return r.result({ ...params });
}

export type VaultChoiceError =
  | { readonly reason: 'unknown-vault'; readonly vault: string }
  | { readonly reason: 'which-vault'; readonly operation: string };

/**
 * The vaults an operation acts on: those `named`; else, for one on a single
 * vault, the one the caller is in (`here`); for one over many, every
 * registered vault.
 */
export function chooseVaults(
  installation: Pick<Installation, 'vaults'>, operation: Operation, named: readonly string[], here?: RegisteredVault,
): Result<RegisteredVault[], VaultChoiceError> {
  const chosen: RegisteredVault[] = [];
  for (const id of named) {
    const vault = installation.vaults.find((v) => v.id === id);
    if (vault === undefined) return err({ reason: 'unknown-vault', vault: id });
    if (!chosen.includes(vault)) chosen.push(vault);
  }
  switch (operation.vault) {
    case 'none':
      return ok([]);
    case 'many':
      return ok(chosen.length > 0 ? chosen : [...installation.vaults]);
    case 'optional':
    case 'one': {
      const vaults = chosen.length > 0 ? chosen : here === undefined ? [] : [here];
      if (vaults.length > 1 || (vaults.length === 0 && operation.vault === 'one')) return err({ reason: 'which-vault', operation: operation.name });
      return ok(vaults);
    }
  }
}

/** Runs the operation with checked parameters. */
export async function runOperation(context: OperationContext, operation: Operation, surface: ParamSurface, request: OperationRequest): Promise<OperationOutcome> {
  const params = checkParams(operation, surface, request.params);
  if (!params.ok) {
    return { status: 'refused', text: `Invalid parameters:${params.error.map((i) => `\n  ${i.path}: ${i.message}`).join('')}`, data: { issues: params.error } };
  }
  return operation.run(context, { ...request, params: params.value });
}
