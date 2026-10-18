// `builtin:notify` (notifications.md "Use"): the vetted delivery script every
// vault can run, in the package's own process — so the password is resolved
// here and never passes through an argument, an environment or a model.
//
//   builtin:notify --to <alias> --subject <text> [--body-file <file>] [--key <id>]
//
// The body comes from `--body-file` (relative to where the script runs) or
// standard input. Arguments are read strictly: an unknown or repeated option,
// or a missing one, exits 2 and sends nothing. A refusal (a raw address, an
// unknown alias, a limit) exits 3 — the statuses the CLI uses. Otherwise it prints the outcome and the
// Message-ID and exits 0 — a message kept for retry is not lost.

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { utf8Text } from '../documents/index.ts';
import type { BuiltinScript, ScriptOutput } from '../scripts/index.ts';
import { sendNotification, type NotifyDeps } from './send.ts';

const OPTIONS = ['--to', '--subject', '--body-file', '--key'] as const;
type Option = (typeof OPTIONS)[number];

function readArgs(args: readonly string[]): Map<Option, string> | string {
  const given = new Map<Option, string>();
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i] as Option;
    const value = args[i + 1];
    if (!OPTIONS.includes(option)) return `unknown option ${args[i] ?? ''}`;
    if (given.has(option)) return `${option} given twice`;
    if (value === undefined) return `${option} needs a value`;
    given.set(option, value);
  }
  for (const required of ['--to', '--subject'] as const) if (!given.has(required)) return `${required} is required`;
  return given;
}

const output = (exitCode: number, stdout: string, stderr = ''): ScriptOutput => ({ exitCode, stdout, stderr });

/** The built-in, sending as the run `context.trace`. */
export function notifyBuiltin(deps: NotifyDeps, context: { readonly trace: string }): BuiltinScript {
  return {
    name: 'notify',
    header: {
      summary: 'Send a notification to a configured recipient alias',
      args: '--to <alias> --subject <text> [--body-file <file>] [--key <id>]',
      output: 'lines',
      net: true,
    },
    run: async (args, run) => {
      const given = readArgs(args);
      if (typeof given === 'string') return output(2, '', `usage: ${given}\n`);
      const bodyFile = given.get('--body-file');
      let body: string | undefined;
      try {
        body = utf8Text(bodyFile === undefined ? Buffer.from(run.input ?? '', 'utf8') : readFileSync(isAbsolute(bodyFile) ? bodyFile : resolve(run.cwd, bodyFile)));
      } catch {
        body = undefined;
      }
      if (body === undefined) return output(2, '', 'usage: the body must be readable UTF-8 text\n');
      const key = given.get('--key');
      const sent = await sendNotification(deps, {
        to: given.get('--to') ?? '', subject: given.get('--subject') ?? '', body, trace: context.trace, ...(key === undefined ? {} : { key }),
      });
      if (!sent.ok) return output(3, '', `refused: ${sent.error.reason}\n`);
      return output(0, `${sent.value.outcome} ${sent.value.messageId}\n`);
    },
  };
}
