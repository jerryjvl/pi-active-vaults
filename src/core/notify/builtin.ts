// `builtin:notify` (notifications.md "Use"): the vetted delivery script every
// vault can run, in the package's own process — so the password is resolved
// here and never passes through an argument, an environment or a model.
//
//   builtin:notify --to <alias> --subject <text> [--body-file <file>] [--key <id>] [--markdown | --plain]
//
// The body comes from `--body-file` (relative to where the script runs) or
// standard input. A Markdown body is sent readable: its front matter dropped,
// as text with an HTML alternative (markdown.ts). A `.md` or `.markdown` body
// file is Markdown unless `--plain` says otherwise; `--markdown` says so for
// any other body. Arguments are read strictly: an unknown or repeated option,
// or a missing one, exits 2 and sends nothing. A refusal (a raw address, an
// unknown alias, a limit) exits 3 — the statuses the CLI uses. Otherwise it prints the outcome and the
// Message-ID and exits 0 — a message kept for retry is not lost.

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { utf8Text } from '../documents/index.ts';
import type { BuiltinScript, ScriptOutput } from '../scripts/index.ts';
import { markdownEmail } from './markdown.ts';
import { sendNotification, type NotifyDeps } from './send.ts';

const OPTIONS = ['--to', '--subject', '--body-file', '--key'] as const;
const FLAGS = ['--markdown', '--plain'] as const;
type Option = (typeof OPTIONS)[number] | (typeof FLAGS)[number];

function readArgs(args: readonly string[]): Map<Option, string> | string {
  const given = new Map<Option, string>();
  for (let i = 0; i < args.length; i += 1) {
    const option = args[i] as Option;
    if (given.has(option)) return `${option} given twice`;
    if ((FLAGS as readonly string[]).includes(option)) {
      given.set(option, '');
      continue;
    }
    if (!(OPTIONS as readonly string[]).includes(option)) return `unknown option ${args[i] ?? ''}`;
    const value = args[i + 1];
    if (value === undefined) return `${option} needs a value`;
    given.set(option, value);
    i += 1;
  }
  for (const required of ['--to', '--subject'] as const) if (!given.has(required)) return `${required} is required`;
  if (given.has('--markdown') && given.has('--plain')) return '--markdown and --plain cannot both be given';
  return given;
}

/** Whether the body is Markdown: said so, or a Markdown file not said to be plain. */
function isMarkdown(given: Map<Option, string>): boolean {
  if (given.has('--markdown')) return true;
  return !given.has('--plain') && /\.(md|markdown)$/i.test(given.get('--body-file') ?? '');
}

const output = (exitCode: number, stdout: string, stderr = ''): ScriptOutput => ({ exitCode, stdout, stderr });

/** The built-in, sending as the run `context.trace`. */
export function notifyBuiltin(deps: NotifyDeps, context: { readonly trace: string }): BuiltinScript {
  return {
    name: 'notify',
    header: {
      summary: 'Send a notification to a configured recipient alias',
      args: '--to <alias> --subject <text> [--body-file <file>] [--key <id>] [--markdown | --plain] (a .md body file is Markdown by default)',
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
      const email = isMarkdown(given) ? markdownEmail(body) : { text: body };
      const sent = await sendNotification(deps, {
        to: given.get('--to') ?? '', subject: given.get('--subject') ?? '', body: email.text, trace: context.trace,
        ...('html' in email ? { html: email.html } : {}), ...(key === undefined ? {} : { key }),
      });
      if (!sent.ok) return output(3, '', `refused: ${sent.error.reason}\n`);
      return output(0, `${sent.value.outcome} ${sent.value.messageId}\n`);
    },
  };
}
