// Public surface of the scripts module: script headers, built-ins, resolution
// of scripts and checks from the accepted `main`, and running them.

export { parseScriptHeader, scriptNameOf, type ScriptHeader } from './header.ts';
export {
  interpreterCommand,
  restrictNetwork,
  windowsShellCandidates,
  type Command,
  type NetworkSandbox,
} from './command.ts';
export {
  BUILTIN_PREFIX,
  SCRIPT_DIRECTORIES,
  listScripts,
  resolveScript,
  type BuiltinScript,
  type InvalidScript,
  type ResolveOptions,
  type ResolvedScript,
  type ScriptError,
  type ScriptKind,
  type ScriptOutput,
  type VaultScript,
} from './resolve.ts';
export {
  findWindowsShell,
  probeNetworkSandbox,
  runScript,
  type ScriptOutcome,
  type ScriptRunError,
  type ScriptRunOptions,
} from './run.ts';
