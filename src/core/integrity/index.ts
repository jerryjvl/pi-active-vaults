// Public surface of the integrity module: the accepted `main` per vault,
// unaccepted-change detection, the notice every surface shows, and adopt.

export {
  ACCEPTED_HOW,
  acceptedMain,
  integritySchema,
  recordAccepted,
  type AcceptedHow,
  type AcceptedMain,
} from './accepted.ts';
export {
  MAIN_BRANCH,
  MAIN_REF,
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
