// Public surface of the integrity module: the accepted `main` per vault and
// unaccepted-change detection, with the notice every surface shows, and the
// cached reads from the accepted `main`.

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
  acceptedFrontmatter,
  acceptedContracts,
  acceptedDocument,
  acceptedIdentity,
  createAcceptedReads,
  type AcceptedReads,
  type AcceptedReadsOptions,
} from './reads.ts';
export { frontmatterCache, readsSchema, type CommittedFrontmatter, type FrontmatterCache } from './frontmatter.ts';
