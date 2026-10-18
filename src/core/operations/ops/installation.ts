// Installation operations: the vaults on this machine and its name — list,
// add, init, whoami, template show. They change the installation config only
// by registering a vault (`registerVault`); a vault registered with `add` is
// not accepted by that, so it shows an unaccepted change until an owner
// adopts its `main`.

import { isAbsolute, basename, resolve } from 'node:path';
import { registerVault } from '../../config/index.ts';
import { readVaultIdentity } from '../../registry/index.ts';
import { createEmptyVault, createFromTemplate, inspectTemplate, resolveTemplateSpec } from '../../templates/index.ts';
import { packageIdentity, type OperationContext } from '../context.ts';
import { fromError, succeeded } from '../messages.ts';
import type { Caller, Operation } from '../types.ts';
import { identityOf, personOf, readingFrom, text } from './common.ts';

const CLI_ONLY = { cli: true, command: false, mcp: false } as const;

/** A path given on the command line, made absolute from where the caller is. */
function absolute(path: string, caller: Caller): string {
  return isAbsolute(path) ? path : resolve(caller.cwd ?? process.cwd(), path);
}

export const listOperation: Operation = {
  name: 'list',
  summary: 'The registered vaults and their catalog entries',
  vault: 'none',
  surfaces: CLI_ONLY,
  params: [],
  async run(context) {
    const listed = [];
    const lines: string[] = [];
    for (const vault of context.installation.vaults) {
      const accepted = readingFrom(context, vault);
      const identity = await identityOf(context, vault);
      const entry = identity.ok ? { summary: identity.value.purpose.summary, audience: identity.value.audience, review: identity.value.review, owners: identity.value.owners } : undefined;
      listed.push({ id: vault.id, path: vault.path, worktrees: vault.worktrees, host: vault.host, accepted: accepted.ok ? accepted.value.sha : null, ...entry });
      lines.push(`${vault.id}  ${vault.path}${entry === undefined ? '  (its root contract cannot be read)' : `\n  ${entry.summary} — for ${entry.audience}; ${entry.review} review; owners ${entry.owners.join(', ')}`}`);
    }
    return succeeded(lines.join('\n') || 'No vaults are registered. Create one with "vault init <path>" or register one with "vault add <path>".', { vaults: listed });
  },
};

export const addOperation: Operation = {
  name: 'add',
  summary: 'Register an existing vault in the installation',
  vault: 'none',
  surfaces: CLI_ONLY,
  params: [{ name: 'path', kind: 'string', required: true, positional: true, description: 'The vault repository' }],
  async run(context, request) {
    const path = absolute(text(request.params, 'path') ?? '', request.caller);
    const identity = await readVaultIdentity(context.git, path, 'refs/heads/main');
    if (!identity.ok) return fromError(identity.error);
    const registered = registerVault(context.installation.paths.configFile, context.installation.host, { id: identity.value.id, path });
    if (!registered.ok) return fromError(registered.error);
    return succeeded(`Registered vault "${identity.value.id}" at ${path}. Nothing in it is accepted on this machine yet: an owner can look at main and adopt it with "vault accept ${identity.value.id} --adopt <sha>".`, { id: identity.value.id, path });
  },
};

/** Fails when the id or path is already registered, before anything is created. */
function alreadyRegistered(context: OperationContext, id: string, path: string) {
  const byId = context.installation.vaults.find((v) => v.id === id);
  if (byId !== undefined) return { reason: 'already-registered', id } as const;
  const byPath = context.installation.vaults.find((v) => v.path === path);
  return byPath === undefined ? undefined : ({ reason: 'path-registered', id: byPath.id } as const);
}

export const initOperation: Operation = {
  name: 'init',
  summary: 'Create a vault — empty, or from a template with fresh history — and register it',
  vault: 'none',
  surfaces: CLI_ONLY,
  params: [
    { name: 'path', kind: 'string', required: true, positional: true, description: 'Where to create it: a new or empty directory' },
    { name: 'template', kind: 'string', description: 'A template URL or short name, optionally @ref' },
    { name: 'id', kind: 'string', description: 'The vault\'s id (default: the directory\'s name)' },
  ],
  async run(context, request) {
    const person = personOf(request.caller);
    if (!person.ok) return fromError(person.error);
    const path = absolute(text(request.params, 'path') ?? '', request.caller);
    const id = text(request.params, 'id') ?? basename(path);
    const registered = alreadyRegistered(context, id, path);
    if (registered !== undefined) return fromError(registered);
    const deps = { git: context.git, store: context.state, clock: context.clock, attribution: { identity: packageIdentity(context.installation, person.value) } };
    const spec = text(request.params, 'template');
    let made;
    if (spec === undefined) {
      made = await createEmptyVault(deps, { path, id, by: person.value });
    } else {
      const source = resolveTemplateSpec(spec, context.installation.config.templates);
      if (!source.ok) return fromError(source.error);
      made = await createFromTemplate(deps, { source: source.value, path, id, by: person.value });
    }
    if (!made.ok) return fromError(made.error);
    const added = registerVault(context.installation.paths.configFile, context.installation.host, { id, path });
    if (!added.ok) return fromError(added.error, { created: made.value });
    return succeeded(`Created vault "${id}" at ${path}, accepted at ${made.value.accepted.sha}, and registered it.`, made.value);
  },
};

export const whoamiOperation: Operation = {
  name: 'whoami',
  summary: 'This installation\'s name, for a vault\'s executor',
  vault: 'none',
  surfaces: CLI_ONLY,
  params: [],
  async run(context) {
    const { name, person } = context.installation.config;
    return succeeded(name, { name, ...(person === undefined ? {} : { person }) });
  },
};

export const templateShowOperation: Operation = {
  name: 'template-show',
  command: 'template show',
  summary: 'Check that a repository is a compatible template and summarise it',
  vault: 'none',
  surfaces: CLI_ONLY,
  params: [{ name: 'template', kind: 'string', required: true, positional: true, description: 'A template URL or short name, optionally @ref' }],
  async run(context, request) {
    const source = resolveTemplateSpec(text(request.params, 'template') ?? '', context.installation.config.templates);
    if (!source.ok) return fromError(source.error);
    const summary = await inspectTemplate(context.git, source.value);
    if (!summary.ok) return fromError(summary.error);
    const { template, vault, commit, files } = summary.value;
    return succeeded([
      `${template.name} version ${template.version}: ${template.summary}`,
      `  at ${commit}; ${files} files`,
      `  purpose: ${vault.purpose}`,
      `  owners: ${vault.owners.join(', ')}; actors: ${vault.actors.join(', ') || 'none'}`,
    ].join('\n'), summary.value);
  },
};
