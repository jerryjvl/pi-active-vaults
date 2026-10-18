// The Pi tools generated from the catalogue (api.md "Tools"): one
// `vault_<operation>` per operation the catalogue offers as a tool, with its
// exposure, its parameters as TypeBox schemas, and its result as text for the
// model and structured content for programs.
//
// Declarations hold no runtime values (pi-conventions.md "Prompt-cache
// stability"): the schemas, descriptions and guidelines are the same in every
// session. A tool's vault is chosen by the core (`callRequest`): its vault
// paths (`<vault-id>:<path>`), `vaults` for an operation over many, the vault
// the session's directory is in, or else the session's own.

import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';
import {
  CATALOGUE, callRequest, describeCommandLineError, modelResult, paramsOn, type Operation, type ParamSpec,
} from '../core/operations/index.ts';
import { liveOr, type Holder } from './live.ts';
import { operate, whereOf } from './operate.ts';

/** What the system prompt says about each tool; each line names its tool, since Pi lists guidelines flat. */
const GUIDANCE: Readonly<Record<string, readonly string[]>> = {
  search: ['Use vault_search to find what the knowledge vaults say before answering from memory; each hit says whether it is still current.'],
  read: ['Use vault_read to read a vault document as accepted, by <vault-id>:<path>; it says when main has changed it since.'],
  contract: ['Use vault_contract to see the effective contract — the rules — that govern a vault path before changing it.'],
  jobs: ['Use vault_jobs to list the vaults\' jobs, their conditions, last runs and pending runs.'],
  commit: ['Use vault_commit to commit your work in your worktree: it runs the vault\'s checks and adds the trailers. Never run git commit or git push in a vault yourself.'],
  script: ['Use vault_script for exact, repeatable work — dates, naming, search, delivery — through the vault\'s approved scripts and the builtin: ones.'],
};

const OUTPUT = Type.Object({
  status: Type.String({ description: 'ok, failed, invalid or refused' }),
  data: Type.Unknown({ description: 'The operation\'s result as data' }),
  text: Type.String({ description: 'The result as text' }),
  notices: Type.Array(Type.String(), { description: 'Unaccepted changes to the vaults it acted on' }),
});

function schemaOf(spec: ParamSpec): TSchema {
  const options = { description: spec.description };
  switch (spec.kind) {
    case 'string':
      return spec.choices === undefined ? Type.String(options) : Type.Union(spec.choices.map((c) => Type.Literal(c)), options);
    case 'strings':
      return Type.Array(Type.String(), options);
    case 'integer':
      return Type.Integer(options);
    case 'boolean':
      return Type.Boolean(options);
  }
}

/** The tool's parameters: the operation's, on the tool surface, and `vaults` for one over many. */
export function parametersOf(operation: Operation): TSchema {
  const properties: Record<string, TSchema> = {};
  for (const spec of paramsOn(operation, 'tool')) properties[spec.name] = spec.required === true ? schemaOf(spec) : Type.Optional(schemaOf(spec));
  if (operation.vault === 'many') properties['vaults'] = Type.Optional(Type.Array(Type.String(), { description: 'The vault IDs to use (default: every vault)' }));
  return Type.Object(properties);
}

function toolFor(pi: ExtensionAPI, holder: Holder, operation: Operation, exposure: 'direct' | 'codemode'): ToolDefinition {
  const name = `vault_${operation.name}`;
  return {
    name,
    label: `vault ${operation.name}`,
    description: operation.summary,
    promptSnippet: operation.summary,
    promptGuidelines: [...(GUIDANCE[operation.name] ?? [`Use ${name} to ${operation.summary.charAt(0).toLowerCase()}${operation.summary.slice(1)}.`])],
    parameters: parametersOf(operation),
    outputSchema: OUTPUT,
    exposure,
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const found = liveOr(holder);
      if ('problem' in found) return { content: [{ type: 'text', text: found.problem }], details: undefined, isError: true };
      const { live } = found;
      const request = callRequest(live.context.installation, operation, 'tool', input as Record<string, unknown>, whereOf(live, ctx.cwd));
      if (!request.ok) return { content: [{ type: 'text', text: describeCommandLineError(request.error, operation, 'tool') }], details: undefined, isError: true };
      const { outcome, notices } = await operate(pi, live, operation, 'tool', { ...request.value, cwd: ctx.cwd });
      const result = modelResult(outcome, notices);
      return { content: [{ type: 'text', text: result.text }], details: undefined, structuredContent: result.structured as never, isError: result.isError };
    },
  };
}

/** Registers every tool the catalogue offers in Pi. */
export function registerTools(pi: ExtensionAPI, holder: Holder): void {
  for (const operation of CATALOGUE) {
    const exposure = operation.surfaces.tool;
    if (exposure !== undefined) pi.registerTool(toolFor(pi, holder, operation, exposure));
  }
}
