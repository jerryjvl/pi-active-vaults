// Public surface of the automation module: the daemon's work — which vaults
// it runs and which are paused, Git events from cursors, timers, running
// spawns as headless Pi sessions, the socket protocol — as one object the
// daemon adapter drives.

export { createAutomation, type Automation, type AutomationOptions } from './automation.ts';
export { METHODS, type Notice, type Reply } from './protocol.ts';
export type { PiCommand } from './run.ts';
export { linkDaemon, type DaemonLink } from './link.ts';
