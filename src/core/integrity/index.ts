// Public surface of the integrity module: the accepted `main` per vault,
// unaccepted-change detection, the notice every surface shows, and adopt.

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
export { adopt, adoptionDelta, type AdoptError, type AdoptionDelta } from './adopt.ts';
