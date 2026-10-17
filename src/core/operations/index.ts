// Public surface of the operations layer: what every surface is generated
// from — the catalogue of operations, permission sets, and the assembly of
// the local stores from each module's schema.

export { INDEX_MODULES, STATE_MODULES, openIndexStore, openStateStore } from './stores.ts';
export {
  PERMISSIONS,
  PERMISSION_GROUPS,
  effectivePermissions,
  mayCall,
  parseMcpConfig,
  permittedOperations,
  type Endpoint,
  type McpConfig,
  type McpProfile,
  type Permission,
} from './permissions.ts';
