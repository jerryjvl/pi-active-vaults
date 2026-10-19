// Context injection (extension.md "Context injection", concepts.md
// "Contracts" and "applies-when"): when a session first touches a path, the
// prose of the contracts governing it; and for each session event, the
// documents whose `inject` conditions it matches.
//
// Invariants:
//  - everything injected comes from the vault's accepted `main` — contracts
//    and documents are instructions, and only the accepted `main` instructs
//    (security.md) — read from the recorded accepted `main` even while `main`
//    has an unaccepted change, as reading is;
//  - each contract or document is injected at most once per session, and
//    injection only appends: nothing earlier is rewritten (principle 16);
//  - the order is stable: contracts root first, then documents by vault,
//    path and condition;
//  - a document or contract that cannot be read is left out — injecting less
//    never makes a session do more.

import { documentConditions, matchConditions, matchContextOf, type Candidate, type DocumentConditions, type VaultEvent } from '../conditions/index.ts';
import { acceptedContract, acceptedDocument, acceptedMain, type AcceptedMain } from '../integrity/index.ts';
import type { OperationContext } from '../operations/index.ts';
import { reachedVaults } from '../queue/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import type { VaultSession } from './session.ts';

export type SessionEvent = Extract<VaultEvent, { readonly kind: 'session.start' | 'session.tool' | 'session.path' }>;

export interface Injection {
  readonly vault: string;
  /** The contract or document injected. */
  readonly path: string;
  readonly text: string;
}

/** The documents with conditions on a vault's accepted main; one that cannot be read offers none. */
async function documentsOf(context: OperationContext, vault: RegisteredVault, accepted: AcceptedMain): Promise<readonly DocumentConditions[]> {
  const read = await documentConditions(context.git, vault.path, accepted, context.reads);
  return read.ok ? read.value : [];
}

async function contractProse(context: OperationContext, vault: RegisteredVault, accepted: AcceptedMain, path: string): Promise<Injection[]> {
  const contract = await acceptedContract(context.reads, context.git, vault.path, accepted, path);
  return contract.ok ? contract.value.prose.map((p) => ({ vault: vault.id, path: p.path, text: p.body })) : [];
}

async function injectDocuments(context: OperationContext, event: SessionEvent): Promise<Injection[]> {
  const { vaults, config } = context.installation;
  const targets = reachedVaults(vaults, config.subscriptions, event.kind === 'session.path' ? event.vault : undefined);
  const candidates: Candidate[] = [];
  const readFrom = new Map<string, { vault: RegisteredVault; accepted: AcceptedMain }>();
  for (const vault of targets) {
    const accepted = acceptedMain(context.state, vault.id);
    if (accepted === undefined) continue;
    readFrom.set(vault.id, { vault, accepted });
    for (const document of await documentsOf(context, vault, accepted)) {
      if (document.conditions.some((c) => c.effect === 'inject')) candidates.push({ vault: vault.id, document: document.path, conditions: document.conditions });
    }
  }
  const matched = matchConditions(event, candidates, matchContextOf(config))
    .filter((m) => m.condition.effect === 'inject');
  const injections: Injection[] = [];
  for (const match of matched) {
    const source = readFrom.get(match.vault);
    if (source === undefined || injections.some((i) => i.vault === match.vault && i.path === match.document)) continue;
    const read = await acceptedDocument(context.reads, context.git, source.vault.path, source.accepted, match.document);
    if (read.ok && read.value.state === 'read') injections.push({ vault: match.vault, path: match.document, text: read.value.document.body });
  }
  return injections;
}

/** What the event adds to the session's context that it has not had yet, in order; recorded as injected. */
export async function injectionsFor(context: OperationContext, session: VaultSession, event: SessionEvent): Promise<Injection[]> {
  const found: Injection[] = [];
  if (event.kind === 'session.path') {
    const vault = context.installation.vaults.find((v) => v.id === event.vault);
    const accepted = vault === undefined ? undefined : acceptedMain(context.state, vault.id);
    if (vault !== undefined && accepted !== undefined) found.push(...(await contractProse(context, vault, accepted, event.path)));
  }
  found.push(...(await injectDocuments(context, event)));
  const fresh = found.filter((i) => !session.injected.has(`${i.vault}:${i.path}`));
  for (const i of fresh) session.injected.add(`${i.vault}:${i.path}`);
  return fresh;
}

/** Injections as text for the model: each marked with where it comes from. */
export function renderInjections(injections: readonly Injection[]): string {
  return injections.map((i) => `<vault-context source="${i.vault}:${i.path}">\n${i.text.trim()}\n</vault-context>`).join('\n\n');
}
