// Secret references and their resolution.
//
// A secret is never written literally in the config: it is `${ENV}` or
// `!command` (a keyring lookup on each platform). The config holds only the
// reference; the value is fetched by whoever is about to use it, so it does not
// sit in memory, logs, traces or prompts any longer than that use.
//
// Invariants: every failure resolves to an error value that names the config
// field and a reason — never the command's output, never its text, never the
// variable's value — and an empty secret is a failure, not a pass.

import { spawn } from 'node:child_process';
import { err, ok, type Result } from '../result/index.ts';
import type { ConfigIssue } from './issue.ts';

export type SecretRef =
  | { readonly kind: 'env'; readonly name: string; readonly where: string }
  | { readonly kind: 'command'; readonly command: string; readonly where: string };

export type SecretError = {
  readonly reason: 'env-unset' | 'command-failed' | 'empty';
  /** The config field the secret belongs to, for the message shown to the user. */
  readonly where: string;
};

export interface CommandOutcome {
  /** null when the command was killed (timeout) rather than exiting. */
  readonly exitCode: number | null;
  readonly stdout: string;
}

export type CommandRunner = (command: string, options: { timeoutMs: number }) => Promise<CommandOutcome>;

export interface SecretDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runCommand: CommandRunner;
}

const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const MAX_COMMAND_OUTPUT_CHARS = 64 * 1024;

export function parseSecretRef(value: unknown, where: string): Result<SecretRef, ConfigIssue> {
  if (typeof value === 'string') {
    const env = ENV_REFERENCE.exec(value);
    if (env?.[1] !== undefined) return ok({ kind: 'env', name: env[1], where });
    if (value.startsWith('!') && value.slice(1).trim() !== '') {
      return ok({ kind: 'command', command: value.slice(1).trim(), where });
    }
  }
  return err({
    path: where,
    message: 'must be a ${ENV} reference or a quoted "!command", never the secret itself',
  });
}

export async function resolveSecret(
  ref: SecretRef,
  deps: SecretDeps,
  options: { timeoutMs?: number } = {},
): Promise<Result<string, SecretError>> {
  let raw: string | undefined;
  if (ref.kind === 'env') {
    raw = deps.env[ref.name];
    if (raw === undefined || raw === '') return err({ reason: 'env-unset', where: ref.where });
  } else {
    try {
      const outcome = await deps.runCommand(ref.command, { timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS });
      if (outcome.exitCode !== 0) return err({ reason: 'command-failed', where: ref.where });
      raw = outcome.stdout;
    } catch {
      // The thrown error may quote the command line; report only that it failed.
      return err({ reason: 'command-failed', where: ref.where });
    }
  }
  const value = raw.replace(/\r?\n$/, '');
  return value === '' ? err({ reason: 'empty', where: ref.where }) : ok(value);
}

/**
 * Runs a command through the platform's shell (sh, or cmd.exe on Windows) with
 * no standard input, so it can never wait on a prompt. The one place that
 * decides how secret commands are executed.
 */
export const shellCommandRunner: CommandRunner = (command, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      // Do not wait for 'close': a surviving grandchild would hold the pipe open.
      settle(() => {
        child.kill();
        child.stdout.destroy();
        resolve({ exitCode: null, stdout: '' });
      });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_COMMAND_OUTPUT_CHARS) stdout += chunk;
    });
    child.on('error', (error) => settle(() => reject(error)));
    child.on('close', (code) => settle(() => resolve({ exitCode: code, stdout })));
  });

export function systemSecretDeps(env: SecretDeps['env']): SecretDeps {
  return { env, runCommand: shellCommandRunner };
}
