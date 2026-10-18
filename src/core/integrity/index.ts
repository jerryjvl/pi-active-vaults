// Public surface of the integrity module: the accepted `main` per vault and
// unaccepted-change detection, with the notice every surface shows.

export {
  acceptedMain,
  integritySchema,
  recordAccepted,
  type AcceptedHow,
  type AcceptedMain,
} from './accepted.ts';
export {
  MAIN_BRANCH,
  integrityStatus,
  mainTip,
  requireNoUnacceptedChange,
  unacceptedNotice,
  type IntegrityStatus,
  type UnacceptedChange,
  type UnacceptedChangeError,
  type UnacceptedKind,
  type VaultLocation,
} from './status.ts';
export {
  UNCACHED_READS,
  acceptedContract,
  acceptedContracts,
  acceptedDocument,
  acceptedIdentity,
  createAcceptedReads,
  type AcceptedReads,
} from './reads.ts';
