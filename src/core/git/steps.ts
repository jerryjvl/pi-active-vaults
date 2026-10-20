// Git commands shown to a person, never run: the steps a notice or an error
// gives for resolving something by hand. A vault's clone and its actors'
// worktrees are separate directories, so every set of steps starts by naming
// the directory it is for, as a `cd` the person can paste; a path that the
// shell would split or expand is quoted (double quotes where it has a
// backslash, as on Windows, else single quotes).

const PLAIN = /^[\w@%+=:,./\\-]+$/;

/** `value` as one shell word: as it is when nothing in it is special, else quoted. */
export function shellWord(value: string): string {
  if (PLAIN.test(value)) return value;
  return value.includes('\\') ? `"${value.replaceAll('"', '\\"')}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Commands to run in `directory`, one per line and indented, starting with the `cd` there. */
export function stepsIn(directory: string, commands: readonly string[]): string {
  return [`cd ${shellWord(directory)}`, ...commands].map((command) => `  ${command}`).join('\n');
}

/**
 * `text` for a client on another machine, which has no use for this one's
 * paths: each block of steps (as `stepsIn` makes them, at any indent) becomes
 * one line saying they are for the vault's own machine.
 */
export function withoutSteps(text: string): string {
  const out: string[] = [];
  let indent: string | undefined;
  for (const line of text.split('\n')) {
    const start = /^(\s+)cd \S/.exec(line);
    if (start?.[1] !== undefined) {
      indent = start[1];
      out.push(`${indent}(commands to run on the vault's own machine, where they name its directories)`);
    } else if (indent !== undefined && line.startsWith(indent) && !/^\s/.test(line.slice(indent.length))) {
      continue; // the rest of the block
    } else {
      indent = undefined;
      out.push(line);
    }
  }
  return out.join('\n');
}
