#!/usr/bin/env node
// The `vault` executable: the process's arguments, streams, terminal and
// machine handed to the CLI runner, and its exit status returned.

import { createInterface } from 'node:readline/promises';
import { currentHost } from '../core/config/index.ts';
import { runCli, type CliIo } from './run.ts';

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;

const io: CliIo = {
  write: (stream, text) => (stream === 'stdout' ? process.stdout : process.stderr).write(text),
  readStdin: async () => (process.stdin.isTTY === true ? undefined : readAll(process.stdin)),
  ...(interactive
    ? {
        confirm: async (question: string) => {
          const prompt = createInterface({ input: process.stdin, output: process.stderr });
          try {
            return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
          } finally {
            prompt.close();
          }
        },
      }
    : {}),
  cwd: process.cwd(),
  host: currentHost(),
};

process.exitCode = await runCli(process.argv.slice(2), io);
