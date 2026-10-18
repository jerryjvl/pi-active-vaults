// Public surface of the queue module: the jobs a vault declares, matching an
// event to the spawns it requests, the spawn queue and its claims, job
// cursors, scheduling, the daemon's record and its runs' processes, and
// start-up recovery, on top of `store`.

export {
  commitSpawn,
  enqueueSpawn,
  expireQueued,
  listSpawns,
  markAwaited,
  nextSpawns,
  noChangeSpawn,
  queueSchema,
  recordSpawn,
  spawnEventKey,
  startSpawn,
  stopSpawn,
  type QueueContext,
  type QueueError,
  type SpawnEntry,
  type SpawnEvent,
  type SpawnRequest,
  type SpawnState,
  type StopReason,
} from './spawns.ts';
export { vaultJobs, type Job } from './jobs.ts';
export { advanceCursor, gitStream, readCursor, timerStream, type CursorError, type CursorKey } from './cursors.ts';
export { matchSpawns, reachedVaults, submitSpawns, type MatchedSpawns, type SpawnMatching, type SpawnSender } from './request.ts';
export {
  daemonRecord, forgetRunProcess, recordRunProcess, releaseDaemonRecord, runProcesses, takeDaemonRecord,
  type DaemonRecordError, type RunningProcess,
} from './runs.ts';
export { schedulable } from './schedule.ts';
export { recoverRuns, type RecoveryDeps, type RecoveryReport } from './recovery.ts';
