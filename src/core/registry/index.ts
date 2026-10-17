// Public surface of the registry module: the vaults on this machine, their
// identities from their root contracts, and their catalog entries.

export {
  isActor,
  isOwner,
  parseVaultIdentity,
  readVaultIdentity,
  writersOf,
  type IdentityError,
  type ReviewMode,
  type VaultIdentity,
} from './identity.ts';
export {
  catalog,
  checkRegisteredIdentity,
  hosting,
  registeredVaults,
  type CatalogEntry,
  type RegisteredVault,
} from './vaults.ts';
