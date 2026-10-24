import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveNativeEngineLayout } from '../lib/aibox-engine-adapter.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-tools-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'project/third_party/aibox-engine');
  fs.mkdirSync(path.join(engine, 'libs'), { recursive: true });
  fs.writeFileSync(path.join(engine, 'libs/drpyS.js'), 'export const runtime = true;');
  fs.writeFileSync(path.join(engine, 'package.json'), JSON.stringify({ name: 'aibox-engine', version: '1.0.0', type: 'module' }));
  return { root, engine };
}

test('installed skill discovers the actual cwd ancestor engine, never .codex/third_party', t => {
  const { root, engine } = fixture(t);
  const cwd = path.join(root, 'project/work/deep');
  fs.mkdirSync(cwd, { recursive: true });
  const installed = path.join(root, '.codex/skills/aibox-drpy-source');
  assert.equal(resolveNativeEngineLayout(installed, { cwd }).engineRoot, engine);
});

test('explicit engine root wins even over a valid cwd engine; invalid explicit root does not fallback', t => {
  const { root, engine } = fixture(t);
  const explicit = path.join(root, 'explicit-engine');
  fs.cpSync(engine, explicit, { recursive: true });
  assert.equal(resolveNativeEngineLayout('/installed/skill', { cwd: path.dirname(engine), engineRoot: explicit }).engineRoot, explicit);
  assert.equal(resolveNativeEngineLayout('/installed/skill', { cwd: path.dirname(engine), engineRoot: `${explicit}-missing` }).engineRoot, `${explicit}-missing`);
});

async function toolkit() {
  const url = new URL('../lib/engine-toolkit.mjs', import.meta.url);
  assert.ok(fs.existsSync(url), 'dependency preparation / backup / clean sync tooling is missing');
  return import(url);
}

test('AST scanner distinguishes comments, literals, computed imports, npm/helper/WASM/coreJS', async t => {
  const { engine } = fixture(t);
  const { inspectDependencies } = await toolkit();
  const code = `// require('fake')\nconst text = "require('also-fake')";
    const a = require('webp-wasm'); $.require('_lib.decode.js');
    import('jpeg-js'); import(name); const u = new URL('./decode.wasm', import.meta.url); coreJS.SHA256('x');`;
  const result = inspectDependencies(code, { engineRoot: engine });
  assert.deepEqual(result.npm.map(x => x.name).sort(), ['jpeg-js', 'webp-wasm']);
  assert.equal(result.helpers[0].specifier, '_lib.decode.js');
  assert.equal(result.wasm[0].specifier, './decode.wasm');
  assert.equal(result.coreJS, true);
  assert.equal(result.unresolved.length, 1);
});

test('prepare copies recursive locked dependency closure and pinned helper/WASM without touching engine', async t => {
  const { root, engine } = fixture(t);
  const { prepareBundle, sha256 } = await toolkit();
  for (const [name, pkg] of Object.entries({ decode: { version: '1.2.3', dependencies: { leaf: '^2.0.0' } }, leaf: { version: '2.1.0' } })) {
    fs.mkdirSync(path.join(engine, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(engine, 'node_modules', name, 'package.json'), JSON.stringify({ name, ...pkg }));
    fs.writeFileSync(path.join(engine, 'node_modules', name, 'index.js'), 'module.exports = 1;');
  }
  fs.writeFileSync(path.join(engine, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    '': {}, 'node_modules/decode': { version: '1.2.3', dependencies: { leaf: '^2.0.0' } }, 'node_modules/leaf': { version: '2.1.0' }
  } }));
  const wasm = Buffer.from('0061736d01000000', 'hex');
  const wasmFile = path.join(root, 'decode.wasm'); fs.writeFileSync(wasmFile, wasm);
  const helper = Buffer.from("module.exports = require('decode');");
  const helperFile = path.join(root, 'helper.js'); fs.writeFileSync(helperFile, helper);
  const result = await prepareBundle({ engineRoot: engine, out: path.join(root, 'out'), source: "$.require('_lib.helper.js');", assets: [
    { file: helperFile, path: 'spider/js/_lib.helper.js', sha256: sha256(helper) },
    { file: wasmFile, path: 'libs/decode.wasm', sha256: sha256(wasm) }
  ] });
  assert.equal(result.success, true);
  assert.ok(fs.existsSync(path.join(result.directory, 'node_modules/leaf/index.js')));
  assert.deepEqual(result.manifest.packages.map(x => x.version).sort(), ['1.2.3', '2.1.0']);
  assert.equal(fs.existsSync(path.join(engine, 'spider/js/_lib.helper.js')), false);
  await assert.rejects(prepareBundle({ engineRoot: engine, out: path.join(root, 'unknown'), source: "require('unknown-library');" }), /PIN_REQUIRED/);
});

test('native addons return platform requirements instead of claiming portable success', async t => {
  const { root, engine } = fixture(t);
  const { prepareBundle, applyBundle } = await toolkit();
  fs.mkdirSync(path.join(engine, 'node_modules/addon'), { recursive: true });
  fs.writeFileSync(path.join(engine, 'node_modules/addon/package.json'), '{"name":"addon","version":"1.0.0","gypfile":true}');
  fs.writeFileSync(path.join(engine, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/addon":{"version":"1.0.0"}}}');
  const result = await prepareBundle({ engineRoot: engine, out: path.join(root, 'native'), source: "require('addon');" });
  assert.equal(result.success, false);
  assert.equal(result.platformRequirements[0].package, 'addon');
  await assert.rejects(applyBundle({ engineRoot: engine, archive: fs.readFileSync(result.archivePath), sha256: result.sha256, manifest: result.manifest, backupDir: path.join(root, 'backup') }), /PLATFORM_REQUIREMENT/);
});

test('sync requires verified bytes, full baseline backup and clean policy; conflicts leave unique candidates', async t => {
  const { root, engine } = fixture(t);
  const { syncCandidate, backupBaseline, sha256, createZip } = await toolkit();
  fs.mkdirSync(path.join(engine, 'spider/js'), { recursive: true });
  fs.writeFileSync(path.join(engine, 'spider/js/private.js'), 'secret-source');
  fs.writeFileSync(path.join(engine, '.env'), 'TOKEN=private');
  const original = path.join(root, 'original.zip'); fs.writeFileSync(original, 'original-zip-baseline');
  const backup = await backupBaseline({ engineRoot: engine, originalZip: original, backupDir: path.join(root, 'backups') });
  assert.equal(fs.readFileSync(path.join(backup.directory, 'engine/spider/js/private.js'), 'utf8'), 'secret-source');
  assert.equal(fs.readFileSync(path.join(backup.directory, 'original.zip'), 'utf8'), 'original-zip-baseline');
  const bytes = createZip([{ name: 'libs/new.js', content: Buffer.from('export const x = 1;') }]);
  const manifest = { files: [{ path: 'libs/new.js', sha256: sha256(Buffer.from('export const x = 1;')), baseSha256: null }] };
  const options = { engineRoot: engine, originalZip: original, backupDir: path.join(root, 'backups'), out: path.join(root, 'candidates'), archive: bytes, sha256: sha256(bytes), manifest };
  const a = await syncCandidate(options); const b = await syncCandidate(options);
  assert.notEqual(a.candidateVersion, b.candidateVersion);
  assert.equal(fs.existsSync(path.join(a.directory, '.env')), false);
  assert.equal(fs.existsSync(path.join(a.directory, 'spider/js/private.js')), false);
  assert.equal(fs.existsSync(path.join(a.directory, 'libs/new.js')), true);
  await assert.rejects(syncCandidate({ ...options, sha256: '0'.repeat(64) }), /SHA/);
  const conflict = await syncCandidate({ ...options, manifest: { files: [{ ...manifest.files[0], baseSha256: 'f'.repeat(64) }] } });
  assert.equal(conflict.success, false);
  assert.equal(conflict.conflicts[0].path, 'libs/new.js');
});

test('ZIP reader rejects traversal, duplicate case, symlink and tampering before extraction', async () => {
  const { readZip, createZip } = await toolkit();
  assert.throws(() => createZip([{ name: '../escape', content: Buffer.from('bad') }]), /path/i);
  assert.throws(() => createZip([{ name: 'libs/a', content: Buffer.alloc(0) }, { name: 'libs/A', content: Buffer.alloc(0) }]), /duplicate/i);
  const bytes = createZip([{ name: 'libs/a', content: Buffer.from('safe') }]);
  const bad = Buffer.from(bytes); bad[36] ^= 1;
  assert.throws(() => readZip(bad), /CRC|size|header/);
  const link = Buffer.from(bytes); const central = link.indexOf(Buffer.from('504b0102', 'hex'));
  link.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
  assert.throws(() => readZip(link), /symlink/);
});

test('prepare uses locked missing packages via isolated npm ci and always disables scripts', async t => {
  const { root, engine } = fixture(t);
  const { prepareBundle } = await toolkit();
  const lock = { lockfileVersion: 3, packages: { '': { dependencies: { pkg: '1.2.3' } }, 'node_modules/pkg': { version: '1.2.3' } } };
  fs.writeFileSync(path.join(engine, 'package-lock.json'), JSON.stringify(lock));
  const calls = [];
  const runNpm = async (args, cwd) => {
    calls.push({ args, cwd });
    assert.ok(!cwd.startsWith(engine)); assert.ok(args.includes('--ignore-scripts'));
    if (args[0] === 'install') throw new Error('Existing lock must be used, not resolved again');
    assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8')).packages['node_modules/pkg'].version, '1.2.3');
    fs.mkdirSync(path.join(cwd, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'node_modules/pkg/package.json'), '{"name":"pkg","version":"1.2.3"}');
  };
  const result = await prepareBundle({ engineRoot: engine, source: "require('pkg');", out: path.join(root, 'npm-prep'), install: true, runNpm });
  assert.equal(result.success, true);
  assert.deepEqual(calls.map(c => c.args[0]), ['ci']);
  assert.equal(fs.existsSync(path.join(engine, 'node_modules')), false);
});

test('bundle receipts include base hashes for safe application, backup is verified before overwriting', async t => {
  const { root, engine } = fixture(t);
  const { prepareBundle, applyBundle, sha256 } = await toolkit();
  const file = path.join(root, 'helper.js'); fs.writeFileSync(file, 'export const value = 1;');
  const prep = await prepareBundle({ engineRoot: engine, source: "$.require('_lib.new.js');", out: path.join(root, 'prep'), assets: [
    { file, path: 'spider/js/_lib.new.js', sha256: sha256(fs.readFileSync(file)) }
  ] });
  assert.equal(prep.manifest.files[0].baseSha256, null);
  const applied = await applyBundle({ engineRoot: engine, archive: fs.readFileSync(prep.archivePath), sha256: prep.sha256, manifest: prep.manifest, backupDir: path.join(root, 'backup') });
  assert.equal(applied.success, true);
  assert.equal(fs.readFileSync(path.join(engine, 'spider/js/_lib.new.js'), 'utf8'), 'export const value = 1;');
  assert.ok(fs.existsSync(path.join(applied.backup, 'backup.json')));
});

test('actual App export metadata syncs only tracked patches, retains unrelated local changes and removes private catalogs', async t => {
  const { root, engine } = fixture(t);
  const { syncCandidate, createZip, sha256 } = await toolkit();
  fs.writeFileSync(path.join(engine, 'libs/local.js'), 'local-only');
  const bytes = Buffer.from('export const patched = true;');
  const metadata = { schemaVersion: 1, entries: [{ relativePath: 'libs/new.js', baseSha256: null, newSha256: sha256(bytes), storedArtifact: 'libs/new.js' }] };
  const archive = createZip([
    { name: 'libs/new.js', content: bytes }, { name: 'libs/local.js', content: Buffer.from('device-unrelated-version') },
    { name: 'aibox.json', content: Buffer.from('{"sites":[],"parses":[],"lives":[]}') },
    { name: 'index.json', content: Buffer.from('{"sites":[],"parses":[]}') },
    { name: 'engine-maintenance-patches.json', content: Buffer.from(JSON.stringify(metadata)) }
  ]);
  const result = await syncCandidate({ engineRoot: engine, archive, sha256: sha256(archive), manifest: { clean: true, syncPatchMetadata: metadata }, backupDir: path.join(root, 'backup'), out: path.join(root, 'releases') });
  assert.equal(result.success, true);
  assert.equal(fs.readFileSync(path.join(result.directory, 'libs/local.js'), 'utf8'), 'local-only');
  assert.equal(fs.readFileSync(path.join(result.directory, 'libs/new.js'), 'utf8'), bytes.toString());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.directory, 'aibox.json'), 'utf8')).sites, []);
});

test('App full export converts to a verified patch-only ZIP, excludes catalogs and preserves deletions', async () => {
  const tools = await toolkit();
  assert.equal(typeof tools.exportToPatch, 'function', 'export-to-patch conversion is missing');
  const content = Buffer.from('helper'), empty = Buffer.from('{"sites":[]}');
  const metadata = { schemaVersion: 1, entries: [
    { relativePath: 'libs/helper.js', baseSha256: null, newSha256: tools.sha256(content), storedArtifact: 'libs/helper.js' },
    { relativePath: 'libs/old.js', baseSha256: '1'.repeat(64), newSha256: null, storedArtifact: null },
    { relativePath: 'index.json', baseSha256: null, newSha256: tools.sha256(empty), storedArtifact: 'index.json' }
  ] };
  const archive = tools.createZip([{ name: 'libs/helper.js', content }, { name: 'index.json', content: empty },
    { name: 'engine-maintenance-patches.json', content: Buffer.from(JSON.stringify(metadata)) }]);
  const patch = tools.exportToPatch(archive, { sha256: tools.sha256(archive), syncPatchMetadata: metadata });
  assert.deepEqual(tools.readZip(patch.archive).map(e => e.name), ['libs/helper.js']);
  assert.deepEqual(patch.manifest.files.map(e => e.path), ['libs/helper.js', 'libs/old.js']);
  assert.equal(patch.manifest.files[1].delete, true);
  assert.equal(patch.sha256, tools.sha256(patch.archive));
});
