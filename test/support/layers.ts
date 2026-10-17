// The layer rules from docs/agents/implementation-plan.md, as data and a checker.
// A core module may import only from its own layer or a lower one; the core
// (L0–L3) never imports an adapter or Pi. A module missing from LAYERS is a
// violation, so adding a module forces a decision about where it belongs.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const LAYERS: Readonly<Record<string, number>> = {
  // L0 Foundations
  result: 0, clock: 0, ids: 0, process: 0, http: 0, config: 0, store: 0, git: 0, documents: 0,
  // L1 Vault model
  registry: 1, contracts: 1, conditions: 1, events: 1, attestations: 1,
  policy: 1, integrity: 1, actors: 1, scripts: 1,
  // L2 Work machinery
  traces: 2, budgets: 2, queue: 2, models: 2, search: 2, judgements: 2,
  notify: 2, templates: 2, forge: 2,
  // L3 Operations
  operations: 3,
};

export const ADAPTERS = ['cli', 'extension', 'daemon', 'mcp'] as const;

/** Packages the core must never import (it knows nothing of its caller). */
const FORBIDDEN_PACKAGE_PREFIXES = ['@earendil-works/'];

export interface Violation {
  file: string;
  message: string;
}

const IMPORT_PATTERN =
  /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

export function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_PATTERN)].map((m) => (m[1] ?? m[2] ?? m[3]) as string);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Top-level directory under `<srcRoot>/<area>` that a path belongs to, or undefined if outside it. */
function moduleOf(srcRoot: string, area: string, path: string): string | undefined {
  const parts = relative(join(srcRoot, area), path).split(sep);
  return parts[0] === '..' || parts.length === 0 ? undefined : parts[0]?.replace(/\.(ts|js|mjs)$/, '');
}

export function checkLayers(srcRoot: string): Violation[] {
  const violations: Violation[] = [];
  const coreRoot = join(srcRoot, 'core');
  let files: string[];
  try {
    files = sourceFiles(coreRoot);
  } catch {
    return violations; // no core yet
  }

  for (const file of files) {
    const owner = moduleOf(srcRoot, 'core', file);
    const where = relative(srcRoot, file);
    const ownLayer = owner === undefined ? undefined : LAYERS[owner];
    if (owner === undefined || ownLayer === undefined) {
      violations.push({ file: where, message: `module "${owner}" is not assigned to a layer` });
      continue;
    }
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (FORBIDDEN_PACKAGE_PREFIXES.some((p) => spec.startsWith(p))) {
        violations.push({ file: where, message: `core imports "${spec}"` });
        continue;
      }
      if (!spec.startsWith('.')) continue;
      const target = resolve(dirname(file), spec);
      const targetRel = relative(srcRoot, target).split(sep);
      if (targetRel[0] === '..') {
        violations.push({ file: where, message: `imports "${spec}" from outside src/` });
      } else if ((ADAPTERS as readonly string[]).includes(targetRel[0] ?? '')) {
        violations.push({ file: where, message: `core imports adapter "${targetRel[0]}"` });
      } else if (targetRel[0] === 'core') {
        const targetModule = targetRel[1]?.replace(/\.(ts|js|mjs)$/, '');
        const targetLayer = targetModule === undefined ? undefined : LAYERS[targetModule];
        if (targetLayer === undefined) {
          violations.push({ file: where, message: `imports unassigned module "${targetModule}"` });
        } else if (targetLayer > ownLayer) {
          violations.push({
            file: where,
            message: `${owner} (L${ownLayer}) imports ${targetModule} (L${targetLayer})`,
          });
        }
      }
    }
  }
  return violations;
}

/** The core modules each core module imports (other than itself). */
function moduleGraph(srcRoot: string): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const coreRoot = join(srcRoot, 'core');
  let files: string[];
  try {
    files = sourceFiles(coreRoot);
  } catch {
    return graph; // no core yet
  }
  for (const file of files) {
    const owner = moduleOf(srcRoot, 'core', file);
    if (owner === undefined) continue;
    const edges = graph.get(owner) ?? new Set<string>();
    graph.set(owner, edges);
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const target = relative(srcRoot, resolve(dirname(file), spec)).split(sep);
      const targetModule = target[0] === 'core' ? target[1]?.replace(/\.(ts|js|mjs)$/, '') : undefined;
      if (targetModule !== undefined && targetModule !== owner) edges.add(targetModule);
    }
  }
  return graph;
}

/** Import cycles between core modules: modules of one layer may import each other, but never in a circle. */
export function checkCycles(srcRoot: string): Violation[] {
  const graph = moduleGraph(srcRoot);
  const violations: Violation[] = [];
  const done = new Set<string>();
  const visit = (module: string, path: string[]): void => {
    const at = path.indexOf(module);
    if (at !== -1) {
      violations.push({ file: `core/${module}`, message: `import cycle: ${[...path.slice(at), module].join(' -> ')}` });
      return;
    }
    if (done.has(module)) return;
    for (const next of [...(graph.get(module) ?? [])].sort()) visit(next, [...path, module]);
    done.add(module);
  };
  for (const module of [...graph.keys()].sort()) visit(module, []);
  return violations;
}
