// What an operation is (core.md `operations`): a name — also its permission
// on MCP — its parameters, which vaults it acts on, which surfaces expose it,
// and its implementation. Every surface is generated from these: the CLI's
// commands and flags, Pi's tools and commands, MCP's tools. An operation's
// outcome is data plus a text rendering, and a status every surface maps the
// same way (the CLI's exit status: 0, 1, 2, 3).

import type { Holder } from '../actors/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import type { RunRecord } from '../traces/index.ts';
import type { OperationContext } from './context.ts';

export type ParamKind = 'string' | 'strings' | 'integer' | 'boolean';
export type ParamSurface = 'cli' | 'tool' | 'command' | 'mcp';

export interface ParamSpec {
  /** camelCase; the CLI flag is its kebab-case form. */
  readonly name: string;
  readonly kind: ParamKind;
  readonly description: string;
  /** Required everywhere, or only on these surfaces (an MCP write names its actor; elsewhere it has one). */
  readonly required?: boolean | readonly ParamSurface[];
  /** CLI: taken from the positional arguments, in order (a `strings` one takes the rest). */
  readonly positional?: boolean;
  /** The only values it takes. */
  readonly choices?: readonly string[];
  /** A vault path — or, for a list, each of them — which may be written `<vault-id>:<path>` to name its vault. */
  readonly vaultPath?: boolean;
  /** CLI: a one-letter flag. */
  readonly short?: string;
  /** CLI: read from standard input when not given. */
  readonly stdin?: boolean;
  /** CLI: a file whose content is the value. */
  readonly file?: boolean;
  /** CLI: a positional list that takes everything after it as given, options included (a script's arguments). */
  readonly passthrough?: boolean;
  /** The surfaces that offer it; all of the operation's when absent. */
  readonly surfaces?: readonly ParamSurface[];
}

/**
 * Which vaults an operation acts on: exactly one; one, or none when the
 * caller gives none (`optional`); any number, every permitted one when none is
 * given (`many`); or the installation itself (`none`).
 */
export type VaultScope = 'one' | 'optional' | 'many' | 'none';

export interface Surfaces {
  readonly cli: boolean;
  /** A Pi tool, and how it is exposed. */
  readonly tool?: 'direct' | 'codemode';
  /** A `/vault` command in Pi. */
  readonly command: boolean;
  readonly mcp: boolean;
}

/** Who is asking, as the surface established it; operations never take these from parameters a model fills. */
export interface Caller {
  readonly surface: 'cli' | 'pi' | 'mcp';
  /** The person whose owner acts these are: the installation's person, or an MCP profile's owner. */
  readonly person?: string;
  /** The actor writes are made as. */
  readonly actor?: string;
  /** The Pi session (or headless run) calling, and its hold on the actor. */
  readonly session?: string;
  /** That session's trace: its commits carry it, and what they spawn joins its session tree. */
  readonly trace?: string;
  readonly holder?: Holder;
  readonly tainted?: boolean;
  /** A session's compact record for a vault as it stands, which its commits carry (concepts.md "Trace"). */
  readonly traceOf?: (vault: string) => RunRecord;
  /** The MCP profile the call came through. */
  readonly via?: string;
  /** A headless run's script grant, for the scripts it runs in its own vault (concepts.md "Web grants"). */
  readonly webGrant?: { readonly vault: string; readonly token: string };
  /** Where the caller is (the CLI's current directory), for paths and scripts. */
  readonly cwd?: string;
}

export interface OperationRequest {
  /** The vaults to act on, already resolved and permitted by the surface. */
  readonly vaults: readonly RegisteredVault[];
  readonly params: Readonly<Record<string, unknown>>;
  readonly caller: Caller;
}

/**
 * `invalid`: the request does not fit the operation (a usage error, the CLI's
 * exit status 2); `refused`: a policy or a guard said no (3); `failed`:
 * anything else that went wrong (1).
 */
export type OperationStatus = 'ok' | 'failed' | 'invalid' | 'refused';

export interface OperationOutcome {
  readonly status: OperationStatus;
  /** For people and models. */
  readonly text: string;
  /** For programs (`--json`, structured tool results). */
  readonly data?: unknown;
  /**
   * The operation waits for the person to confirm what it showed (adopting
   * `main`): a surface with someone to ask shows `shown`, asks `question`,
   * and on a yes runs it again with `params` added. Never offered to a model.
   */
  readonly confirm?: { readonly shown: string; readonly question: string; readonly params: Readonly<Record<string, unknown>> };
}

export interface Operation {
  readonly name: string;
  /** One line, naming what it does. */
  readonly summary: string;
  /** The CLI command, when it is not the name (`template show`). */
  readonly command?: string;
  readonly params: readonly ParamSpec[];
  readonly vault: VaultScope;
  readonly surfaces: Surfaces;
  run(context: OperationContext, request: OperationRequest): Promise<OperationOutcome>;
}
