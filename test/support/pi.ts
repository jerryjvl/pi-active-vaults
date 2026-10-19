// Pi sessions for extension tests, through Pi's own SDK from the dev
// dependency (Pi 1.3.0) — never a global Pi: an in-memory session with the
// extension loaded as an inline factory, a faux model that answers with what
// the test scripts, and the test installation's host and services. Nothing
// reaches the network or the developer's Pi configuration.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt,
  type AssistantMessage, type FauxProviderHandle, type FauxResponseStep, type JsonObject, type Message,
} from '@earendil-works/pi-ai';
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
  type AgentSessionRuntime, type ExtensionAPI, type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { createIdSource } from '../../src/core/ids/index.ts';
import { createGit } from '../../src/core/git/index.ts';
import { createExtension } from '../../src/extension/index.ts';
import type { TestInstallation } from './installation.ts';
import { ME } from './session.ts';

export interface PiRequest {
  readonly system: string;
  readonly messages: readonly Message[];
}

export interface PiSession {
  readonly runtime: AgentSessionRuntime;
  readonly faux: FauxProviderHandle;
  /** Every request the model received, in order. */
  readonly requests: PiRequest[];
  /** Everything published on Pi's event bus under the package's channels. */
  readonly events: { readonly channel: string; readonly data: unknown }[];
  /** Every tool result as handlers left it: what programs and the model get. */
  readonly results: { readonly tool: string; readonly isError: boolean; readonly text: string; readonly structured: unknown }[];
  /** What the extension told the person, and errors it reported. */
  readonly notices: { readonly text: string; readonly level: string }[];
  readonly errors: string[];
  /** How many times the extension asked Pi to shut down. */
  readonly shutdowns: number;
  /** The model's next answers. */
  respond(...steps: FauxResponseStep[]): void;
  prompt(text: string): Promise<void>;
  /** The text of the custom messages the extension sent, of one type. */
  customMessages(customType: string): string[];
  shutdown(): Promise<void>;
}

export interface PiOptions {
  readonly cwd?: string;
  readonly flags?: Readonly<Record<string, string>>;
  /** What the person answers to a confirmation; without it there is no one to ask. */
  readonly confirm?: boolean;
  /** Another extension loaded beside it, as another package would be. */
  readonly extra?: (pi: ExtensionAPI) => void;
  /** MCP servers in Pi's user-level `mcp.json`, as `mcpServers` holds them. */
  readonly mcpServers?: Readonly<Record<string, unknown>>;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? c.text ?? '' : '')).join('') : '';
}

/**
 * A UI that records what it is told and answers confirmations as the test
 * says; everything else does nothing. A plain object, since Pi copies the UI
 * with a spread.
 */
function recordingUi(notices: PiSession['notices'], confirm: boolean | undefined): ExtensionUIContext {
  const nothing = (): undefined => undefined;
  const methods = [
    'select', 'input', 'onTerminalInput', 'setStatus', 'setWorkingMessage', 'setWorkingVisible', 'setWorkingIndicator',
    'setHiddenThinkingLabel', 'setWidget', 'setFooter', 'setHeader', 'setTitle', 'custom', 'pasteToEditor', 'setEditorText',
    'getEditorText', 'editor', 'addAutocompleteProvider', 'setEditorComponent', 'getEditorComponent', 'getAllThemes', 'getTheme',
    'setTheme', 'getToolsExpanded', 'setToolsExpanded',
  ];
  return {
    ...Object.fromEntries(methods.map((m) => [m, nothing])),
    notify: (text: string, level = 'info') => { notices.push({ text, level }); },
    confirm: async () => confirm ?? false,
  } as unknown as ExtensionUIContext;
}

export async function openPi(t: TestInstallation, options: PiOptions = {}): Promise<PiSession> {
  const agentDir = mkdtempSync(join(tmpdir(), 'pav-pi-'));
  if (options.mcpServers !== undefined) writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: options.mcpServers }));
  const faux = fauxProvider();
  const requests: PiRequest[] = [];
  const events: PiSession['events'] = [];
  const results: PiSession['results'] = [];
  const notices: PiSession['notices'] = [];
  const errors: string[] = [];
  let shutdowns = 0;

  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.provider.id, 'test');
  const settings = { compaction: { enabled: false }, retry: { enabled: false } };
  const settingsManager = SettingsManager.inMemory(settings);
  const extension = createExtension({
    host: t.host,
    items: { modelRuntime, agentDir, settings },
    pid: ME,
    context: { git: createGit({ env: t.repo.env }), clock: t.clock, ids: createIdSource({ clock: t.clock, randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)) }), alive: t.context.alive, sandbox: 'none' },
  });
  const cwd = options.cwd ?? t.repo.path;
  const runtime = await createAgentSessionRuntime(async ({ cwd: at, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd: at, agentDir, settingsManager, modelRuntime,
      extensionFlagValues: new Map(Object.entries(options.flags ?? {})),
      resourceLoaderOptions: {
        extensionFactories: [{ name: 'pi-active-vaults', factory: extension }, ...(options.extra === undefined ? [] : [options.extra]), (pi) => {
          for (const channel of ['pav:v1:ready', 'pav:v1:event', 'pav:v1:spawn']) pi.events.on(channel, (data) => events.push({ channel, data }));
          pi.on('tool_result', (event) => {
            results.push({ tool: event.toolName, isError: event.isError, text: textOf(event.content), structured: event.structuredContent });
          });
        }],
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      },
    });
    const created = await createAgentSessionFromServices({ services, sessionManager, model: faux.getModel(), ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }) });
    return { ...created, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  await runtime.session.bindExtensions({
    uiContext: recordingUi(notices, options.confirm),
    mode: 'rpc',
    shutdownHandler: () => { shutdowns += 1; },
    onError: (error) => errors.push(`${error.event}: ${error.error}`),
  });

  const record = (steps: FauxResponseStep[]): FauxResponseStep[] => steps.map((step) => async (context, streamOptions, state, model) => {
    requests.push({ system: getCurrentSystemPrompt(context.messages), messages: context.messages.filter((m) => m.role !== 'system') as Message[] });
    return typeof step === 'function' ? step(context, streamOptions, state, model) : step;
  });

  let closed = false;
  return {
    runtime, faux, requests, events, results, notices, errors,
    get shutdowns() { return shutdowns; },
    respond: (...steps) => faux.appendResponses(record(steps)),
    prompt: (text) => runtime.session.prompt(text),
    customMessages: (customType) => runtime.session.messages
      .filter((m) => (m as { role: string; customType?: string }).role === 'custom' && (m as { customType?: string }).customType === customType)
      .map((m) => textOf((m as { content: unknown }).content)),
    shutdown: async () => {
      if (closed) return;
      closed = true;
      await runtime.dispose();
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

/** Runs `run` with a Pi session open, and shuts it down whatever happens. */
export async function withPi(t: TestInstallation, options: PiOptions, run: (pi: PiSession) => Promise<void>): Promise<void> {
  const pi = await openPi(t, options);
  try {
    await run(pi);
  } finally {
    await pi.shutdown();
  }
}

/** The text of a tool result message in a request, by tool name, last first. */
export function toolResults(request: PiRequest | undefined, toolName: string): string[] {
  return (request?.messages ?? [])
    .filter((m) => m.role === 'toolResult' && m.toolName === toolName)
    .map((m) => textOf((m as { content: unknown }).content));
}

export { textOf };

/** The model's final answer. */
export const DONE = fauxAssistantMessage('Done.');

/** The model calls a tool. */
export function toolCall(name: string, args: JsonObject): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
}
