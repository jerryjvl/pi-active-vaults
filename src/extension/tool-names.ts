// Tool calls a model wrote under a prefix — `tools.vault_script` for
// `vault_script` (core sessions/toolnames.ts) — are renamed to the tool they
// mean as each assistant message ends, before Pi runs them: Pi runs a message's
// tool calls from the message as `message_end` handlers left it. Registered in
// vault sessions and in every fan-out item's session, which loads no other
// extension. What a renamed call may do is still decided by the tool_call guards.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { withIntendedToolNames } from '../core/sessions/index.ts';

export type Renamed = readonly { readonly from: string; readonly to: string }[];

export function renameIntendedToolCalls(pi: ExtensionAPI, onRenamed?: (renamed: Renamed) => void): void {
  pi.on('message_end', async (event) => {
    const tools = new Set(pi.getAllTools().map((tool) => tool.name));
    const corrected = withIntendedToolNames(event.message, (name) => tools.has(name));
    if (corrected === undefined) return undefined;
    onRenamed?.(corrected.renamed);
    return { message: corrected.message };
  });
}
