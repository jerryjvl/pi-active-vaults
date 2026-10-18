// Public surface of the contracts module: the `_contract.md` files that govern
// a path, merged into an effective contract with the origin of each key.

export {
  ROOT_CONTRACT,
  applyListOps,
  mergeContracts,
  strategyOf,
  type ContractFile,
  type EffectiveContract,
  type Strategy,
} from './merge.ts';
export { contractReader, effectiveContract, effectiveContractWith, type ContractError, type ContractReader } from './read.ts';
