// Documented behaviour: the package ships compiled output, declares Pi's
// packages as peers (never bundled), has no install-time lifecycle scripts and
// builds before packing (architecture.md "Technology", pi-conventions.md
// "Packaging", AGENTS.md §6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('bin and the Pi manifest point at compiled output, which is shipped', () => {
  const entries: string[] = [...Object.values<string>(pkg.bin), ...pkg.pi.extensions];
  for (const entry of entries) assert.match(entry, /^\.\/dist\/.+\.js$/, entry);
  assert.ok(pkg.files.includes('dist'));
});

test('Pi packages are "*" peers, never dependencies, and pinned for development', () => {
  const peers = Object.entries<string>(pkg.peerDependencies);
  assert.ok(peers.length > 0);
  for (const [name, range] of peers) {
    assert.equal(range, '*', `${name} peer range`);
    assert.ok(pkg.devDependencies[name], `${name} has a pinned dev dependency`);
    assert.equal(pkg.dependencies?.[name], undefined, `${name} is not a dependency`);
  }
  for (const [name, range] of Object.entries<string>(pkg.devDependencies)) {
    if (name.startsWith('@earendil-works/')) assert.equal(range, '^1.3.0', name);
  }
});

test('no lifecycle script runs where the package is installed; prepack is the only one', () => {
  // `prepublish` is listed because older npm runs it on a local install too.
  const lifecycle = [
    'preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare',
    'postprepare', 'postpack', 'prepublishOnly', 'publish', 'postpublish',
  ];
  for (const name of lifecycle) assert.equal(pkg.scripts[name], undefined, name);
});

test('packing builds first, so a packed package always contains current compiled output', () => {
  assert.equal(pkg.scripts.prepack, 'npm run build');
});

test('the build rewrites .ts import extensions so compiled output runs under plain Node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pav-build-'));
  try {
    mkdirSync(join(dir, 'src'));
    // ESM package scope, as in the real package; nodenext needs it to treat .ts as ESM.
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'src', 'main.ts'), "#!/usr/bin/env node\nimport { x } from './dep.ts';\nconsole.log(x);\n");
    writeFileSync(join(dir, 'src', 'dep.ts'), 'export const x: number = 42;\n');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: join(root, 'tsconfig.build.json'),
        compilerOptions: { rootDir: 'src', outDir: 'dist', typeRoots: [join(root, 'node_modules', '@types')] },
        include: ['src'],
      }),
    );
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', dir], { stdio: 'pipe' });
    const main = readFileSync(join(dir, 'dist', 'main.js'), 'utf8');
    assert.match(main, /from '\.\/dep\.js'/);
    assert.ok(main.startsWith('#!/usr/bin/env node'), 'shebang kept for the bin');
    assert.equal(execFileSync(process.execPath, [join(dir, 'dist', 'main.js')], { encoding: 'utf8' }).trim(), '42');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
