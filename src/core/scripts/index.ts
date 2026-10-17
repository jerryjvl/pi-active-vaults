// Public surface of the scripts module: script headers, built-ins, resolution
// of scripts and checks from the accepted `main`, running them, and recording
// checks' verdicts.

export { parseScriptHeader, type ScriptHeader } from './header.ts';
export {
  interpreterCommand,
  restrictNetwork,
  windowsShellCandidates,
  type Command,
  type NetworkSandbox,
} from './command.ts';
export {
  BUILTIN_PREFIX,
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
export { recordCheckResults, runChecks, type CheckResult, type CheckRun, type CheckRunOptions } from './checks.ts';
