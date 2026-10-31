// Tool names as a model writes them (components/extension.md "Tool names"): some models
// call a tool by the name code mode's declarations show it under —
// `tools.vault_script`, from `await tools.<name>(…)` — or by the
// `functions.<name>` form their training used, rather than by the tool's own
// name. Pi then answers "not found", and a run that treats a failed step as a
// reason to stop stops (2026-10-31: both digest runs began this way).
//
// Invariants: a call is renamed only when its name is no tool's and what is
// left after the prefix is one, so a tool whose name really has a prefix is
// never shadowed and nothing that was not asked for is called. Arguments,
// call IDs and everything else in the message are kept as they are; what the
// renamed call may do is decided afterwards by the usual tool_call guards.

/** The prefixes models put before a tool's name: code mode's namespace, and the function-calling one. */
const PREFIXES = ['tools.', 'functions.'] as const;

/** The tool `name` means, when it is no tool's own name but a known one behind a prefix; undefined otherwise. */
export function intendedToolName(name: string, isTool: (name: string) => boolean): string | undefined {
  if (isTool(name)) return undefined;
  for (const prefix of PREFIXES) {
    const bare = name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
    if (bare !== undefined && bare !== '' && isTool(bare)) return bare;
  }
  return undefined;
}

interface ToolCallPart { readonly type: 'toolCall'; readonly name: string }

const isToolCall = (part: unknown): part is ToolCallPart =>
  typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'toolCall' && typeof (part as { name?: unknown }).name === 'string';

/**
 * An assistant message with each prefixed tool call renamed to the tool it
 * means, and the renamings made; undefined when there is nothing to rename.
 */
export function withIntendedToolNames<M extends { readonly role: string; readonly content?: unknown }>(
  message: M, isTool: (name: string) => boolean,
): { readonly message: M; readonly renamed: readonly { readonly from: string; readonly to: string }[] } | undefined {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return undefined;
  const renamed: { from: string; to: string }[] = [];
  const content = (message.content as unknown[]).map((part) => {
    if (!isToolCall(part)) return part;
    const to = intendedToolName(part.name, isTool);
    if (to === undefined) return part;
    renamed.push({ from: part.name, to });
    return { ...part, name: to };
  });
  return renamed.length === 0 ? undefined : { message: { ...message, content }, renamed };
}
