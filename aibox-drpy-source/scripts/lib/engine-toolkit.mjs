import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { builtinModules } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';
import { safePath, createZip, readZip } from './engine-zip.mjs';
export { safePath, createZip, readZip };

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = v => typeof v === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(v);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const builtins = new Set(builtinModules.map(x => x.replace(/^node:/, '')));
const packageName = spec => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
const keyOf = member => member?.computed ? member.property?.value : member?.property?.name;
const literal = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value
  : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;

export function inspectDependencies(source, { engineRoot } = {}) {
  const result = { npm: [], helpers: [], wasm: [], builtins: [], unresolved: [], coreJS: false };
  const ast = parse(String(source).replace(/^\uFEFF/, ''), { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, locations: true });
  let lock = {};
  if (engineRoot && fs.existsSync(path.join(engineRoot, 'package-lock.json'))) lock = json(path.join(engineRoot, 'package-lock.json')).packages || {};
  const add = (specifier, node, kind = '') => {
    if (specifier == null) { result.unresolved.push({ line: node.loc.start.line, reason: 'computed dependency; supply a pinned asset/package plan' }); return; }
    const entry = { specifier, line: node.loc.start.line };
    if (/\.wasm(?:$|[?#])/.test(specifier)) result.wasm.push(entry);
    else if (kind === 'helper' || /^(?:[./]|https?:)/.test(specifier)) result.helpers.push(entry);
    else if (builtins.has(specifier.replace(/^node:/, ''))) result.builtins.push(entry);
    else {
      const name = packageName(specifier);
      result.npm.push({ ...entry, name, version: lock[`node_modules/${name}`]?.version || null });
    }
  };
  simple(ast, {
    ImportDeclaration(n) { add(n.source.value, n); },
    ExportNamedDeclaration(n) { if (n.source) add(n.source.value, n); },
    ExportAllDeclaration(n) { add(n.source.value, n); },
    ImportExpression(n) { add(literal(n.source), n); },
    Identifier(n) { if (n.name === 'coreJS') result.coreJS = true; },
    CallExpression(n) {
      if (n.callee.type === 'Identifier' && n.callee.name === 'require') add(literal(n.arguments[0]), n);
      else if (n.callee.type === 'MemberExpression' && ['require', 'import'].includes(keyOf(n.callee))
        && ['$', 'globalThis'].includes(n.callee.object?.name)) add(literal(n.arguments[0]), n, n.callee.object.name === '$' ? 'helper' : '');
    },
    NewExpression(n) { if (n.callee.name === 'URL' && /\.wasm$/.test(literal(n.arguments[0]) || '')) add(literal(n.arguments[0]), n); },
  });
  for (const field of ['npm', 'helpers', 'wasm', 'builtins']) result[field] = result[field].filter((x, i, list) => list.findIndex(y => y.specifier === x.specifier) === i);
  return result;
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function isolated(target, engineRoot) {
  const resolved = path.resolve(target), engine = fs.realpathSync(engineRoot);
  let parent = resolved;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  if (inside(resolved, path.resolve(engineRoot)) || inside(fs.realpathSync(parent), engine)) throw new Error('Output/backup must be outside the active engine');
  return resolved;
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' }); }
function writeJson(file, value) { write(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`)); }
function filesAt(root, prefix = '') {
  const files = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = prefix ? `${prefix}/${e.name}` : e.name, full = path.join(root, e.name);
    safePath(name);
    if (e.isSymbolicLink()) throw new Error(`Symlink/junction rejected: ${full}`);
    if (e.isDirectory()) files.push(...filesAt(full, name));
    else if (e.isFile()) files.push({ name, full });
    else throw new Error(`Unsupported file: ${full}`);
  }
  return files;
}
export function cleanPath(name) {
  safePath(name);
  const parts = name.toLowerCase().split('/');
  if (parts.some(p => /^(?:\.git|\.svn|\.ssh|\.aws|\.npm|\.env.*|\.npmrc|\.netrc|\.yarnrc.*|\.aibox|local|data|userdata|user_data|user-data|config|configs|storage|sessions|cookies|logs?|backups?|secrets?|credentials?|cache|\.cache|\.bin|prebuilds)$/.test(p))) return false;
  if (/(?:^|\/)(?:cookies?|credentials?|secrets?|tokens?|settings|user[-_]?config)(?:[._-]|$)/i.test(name)) return false;
  if (/\.(?:pem|key|jks|p12|pfx|sqlite|sqlite3|db|log|node|dll|exe|dylib|so(?:\.\d+)*|bin|bat|cmd|ps1|sh|gyp|a|lib|o|obj)$/i.test(name)) return false;
  if (name.startsWith('spider/')) return /^spider\/js\/_lib\.[^/]+\.(?:js|mjs)$/.test(name) || name.startsWith('spider/catLib/');
  return ['package.json', 'package-lock.json', 'index.js', 'aibox-engine.json'].includes(name)
    || (/^(?:libs|libs_drpy|utils|controllers|runtime|node_modules)\//.test(name)
      && (/\.(?:js|mjs|cjs|json|wasm|txt|md|map)$/.test(name) || /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[._-].*)?$/.test(parts.at(-1).toUpperCase())));
}
function checkSecrets(name, bytes) {
  if (!/\.(?:js|mjs|cjs|json|txt|md)$/i.test(name)) return;
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /["']?(?:password|authorization|cookie|accessToken|refreshToken|apiKey|secret)["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/i.test(text)) {
    throw new Error(`Sensitive literal requires review/removal before clean sync: ${name}`);
  }
}
function assertClean(name, bytes) {
  if (!cleanPath(name)) throw new Error(`Private/unsupported release path rejected: ${name}`);
  checkSecrets(name, bytes);
}

export async function backupBaseline({ engineRoot, originalZip, backupDir }) {
  const parent = isolated(backupDir, engineRoot);
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'baseline-'));
  try {
    const files = [];
    for (const { name, full } of filesAt(engineRoot)) {
      const bytes = fs.readFileSync(full); write(path.join(directory, 'engine', name), bytes);
      files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    let original = null;
    if (originalZip) {
      const bytes = fs.readFileSync(originalZip); write(path.join(directory, 'original.zip'), bytes);
      original = { bytes: bytes.length, sha256: sha256(bytes) };
    }
    const record = { schemaVersion: 1, engineRoot: path.resolve(engineRoot), createdAt: new Date().toISOString(), files, original };
    writeJson(path.join(directory, 'backup.json'), record);
    // Re-read every byte before exposing a usable backup receipt.
    verifyBackup(directory);
    return { success: true, directory, record };
  } catch (e) { throw new Error(`BACKUP_FAILED (${directory}): ${e.message}`); }
}

export function verifyBackup(directory) {
  const record = json(path.join(directory, 'backup.json'));
  for (const f of record.files) if (sha256(fs.readFileSync(path.join(directory, 'engine', safePath(f.path)))) !== f.sha256) throw new Error(`Backup SHA mismatch: ${f.path}`);
  if (record.original && sha256(fs.readFileSync(path.join(directory, 'original.zip'))) !== record.original.sha256) throw new Error('Original ZIP backup SHA mismatch');
  return record;
}

async function npmRun(args, cwd) {
  // npm-cli.js avoids cmd.exe quoting and never runs in the original engine.
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(process.env.APPDATA || '', 'npm/node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find(p => fs.existsSync(p));
  const cmd = cli ? process.execPath : 'npm';
  if (!cli && process.platform === 'win32') throw new Error('npm-cli.js not found beside Node; configure npm installation');
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, cli ? [cli, ...args] : args, { cwd, windowsHide: true, shell: false,
      env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    // Do not print npm output: registry credentials can appear in error messages.
    child.stdout.resume(); child.stderr.resume();
    const timer = setTimeout(() => { child.kill(); reject(new Error('npm preparation timed out')); }, 120000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`npm failed (exit ${code}); inspect isolated preparation directory`)); });
  });
}

export async function prepareBundle({ engineRoot, source, out, pins = {}, assets = [], lockFile, install = false, runNpm = npmRun, sourcePath } = {}) {
  const output = isolated(out, engineRoot);
  if (fs.existsSync(output)) throw new Error('Preparation output already exists; choose a new directory');
  const scan = inspectDependencies(source, { engineRoot }), npm = new Map(scan.npm.map(x => [x.name, x.version]));
  if (scan.unresolved.length) throw new Error('UNRESOLVED_DEPENDENCY: computed import needs an explicit literal in the source/helper');
  const selectedAssets = new Map();
  const queue = [...assets];
  // Existing engine helper bytes form the trusted local baseline. New/remote
  // assets require a supplied SHA; no URLs are fetched or versions guessed.
  for (const dep of [...scan.helpers, ...scan.wasm]) {
    if (assets.some(a => a.specifier === dep.specifier || a.path.endsWith(dep.specifier.replace(/^\.\//, '')))) continue;
    if (/^https?:/.test(dep.specifier)) throw new Error(`PIN_REQUIRED: remote helper must be vendored with SHA and specifier mapping: ${dep.specifier}`);
    const candidates = dep.specifier.startsWith('.') && sourcePath
      ? [path.resolve(path.dirname(sourcePath), dep.specifier)]
      : ['spider/js', 'libs', 'libs_drpy', ''].map(dir => path.resolve(engineRoot, dir, dep.specifier));
    const found = candidates.find(p => inside(p, path.resolve(engineRoot)) && fs.existsSync(p) && fs.statSync(p).isFile());
    if (!found) throw new Error(`PIN_REQUIRED: helper/WASM ${dep.specifier}`);
    queue.push({ file: found, path: path.relative(engineRoot, found).replaceAll('\\', '/'), sha256: sha256(fs.readFileSync(found)) });
  }
  while (queue.length) {
    const asset = queue.shift(); safePath(asset.path);
    const bytes = fs.readFileSync(asset.file);
    if (!asset.sha256 || sha256(bytes) !== asset.sha256) throw new Error(`Asset SHA mismatch: ${asset.path}`);
    if (asset.path.endsWith('.wasm') && !bytes.subarray(0, 8).equals(Buffer.from('0061736d01000000', 'hex'))) throw new Error(`Invalid WASM header: ${asset.path}`);
    assertClean(asset.path, bytes);
    if (selectedAssets.has(asset.path)) { if (!selectedAssets.get(asset.path).equals(bytes)) throw new Error(`Asset conflict: ${asset.path}`); continue; }
    selectedAssets.set(asset.path, bytes);
    if (/\.(?:js|mjs|cjs)$/.test(asset.path)) {
      const child = inspectDependencies(bytes.toString('utf8'), { engineRoot });
      if (child.unresolved.length) throw new Error(`UNRESOLVED_DEPENDENCY: ${asset.path}`);
      for (const dep of child.npm) npm.set(dep.name, dep.version);
      for (const dep of [...child.helpers, ...child.wasm]) {
        const target = dep.specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(asset.path), dep.specifier)) : `spider/js/${dep.specifier}`;
        safePath(target);
        if (selectedAssets.has(target)) continue;
        const mapped = assets.find(a => a.path === target);
        if (mapped) queue.push(mapped);
        else {
          const file = path.join(engineRoot, target);
          if (!fs.existsSync(file)) throw new Error(`PIN_REQUIRED: helper/WASM ${target}`);
          queue.push({ file, path: target, sha256: sha256(fs.readFileSync(file)) });
        }
      }
    }
  }
  let lock = lockFile ? json(lockFile) : fs.existsSync(path.join(engineRoot, 'package-lock.json')) ? json(path.join(engineRoot, 'package-lock.json')) : { packages: {} };
  for (const name of npm.keys()) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error(`Invalid package name: ${name}`);
    const version = pins[name] || lock.packages?.[`node_modules/${name}`]?.version;
    if (!exact(version)) throw new Error(`PIN_REQUIRED: ${name} needs an exact version or a lockfile`);
    npm.set(name, version);
  }
  fs.mkdirSync(output, { recursive: true });
  let packageRoot = path.resolve(engineRoot);
  const needInstall = lockFile || [...npm].some(([name, v]) => {
    const file = path.join(packageRoot, 'node_modules', name, 'package.json');
    return !fs.existsSync(file) || json(file).version !== v || lock.packages?.[`node_modules/${name}`]?.version !== v;
  });
  if (needInstall) {
    if (!install) throw new Error('INSTALL_REQUIRED: use --install for pinned npm preparation in an isolated directory');
    packageRoot = path.join(output, 'npm-work'); fs.mkdirSync(packageRoot);
    const pkg = { name: 'aibox-dependency-preparation', version: '1.0.0', private: true, dependencies: Object.fromEntries(npm) };
    writeJson(path.join(packageRoot, 'package.json'), pkg);
    if (lockFile) write(path.join(packageRoot, 'package-lock.json'), fs.readFileSync(lockFile));
    else if ([...npm].every(([name, version]) => lock.packages?.[`node_modules/${name}`]?.version === version)) {
      const selected = {}, visited = new Set();
      function select(location) {
        if (visited.has(location)) return; visited.add(location);
        const item = lock.packages[location];
        if (!item || !exact(item.version)) throw new Error(`Incomplete lockfile: ${location}`);
        selected[location] = item;
        for (const name of new Set([...Object.keys(item.dependencies || {}), ...Object.keys(item.optionalDependencies || {}), ...Object.keys(item.peerDependencies || {})])) {
          let current = location, found;
          for (;;) {
            const candidate = current ? `${current}/node_modules/${name}` : `node_modules/${name}`;
            if (lock.packages[candidate]) { found = candidate; break; }
            if (!current) break;
            const cut = current.lastIndexOf('/node_modules/'); current = cut < 0 ? '' : current.slice(0, cut);
          }
          if (found) select(found);
          else if (!item.optionalDependencies?.[name] && !item.peerDependenciesMeta?.[name]?.optional) throw new Error(`Locked transitive missing: ${name}`);
        }
      }
      for (const name of npm.keys()) select(`node_modules/${name}`);
      writeJson(path.join(packageRoot, 'package-lock.json'), { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
        packages: { '': pkg, ...selected } });
    } else await runNpm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], packageRoot);
    await runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false'], packageRoot);
    lock = json(path.join(packageRoot, 'package-lock.json'));
  }
  const packages = [], platformRequirements = [], visited = new Set(), entries = new Map(selectedAssets);
  function locate(name, from = '') {
    let current = from;
    for (;;) {
      const candidate = current ? `${current}/node_modules/${name}` : `node_modules/${name}`;
      if (lock.packages?.[candidate] && fs.existsSync(path.join(packageRoot, candidate, 'package.json'))) return candidate;
      if (!current) break;
      const cut = current.lastIndexOf('/node_modules/'); current = cut < 0 ? '' : current.slice(0, cut);
    }
    throw new Error(`Locked transitive dependency missing: ${name} (from ${from || 'root'})`);
  }
  function bundle(location) {
    if (visited.has(location)) return; visited.add(location);
    const pinned = lock.packages?.[location], pkg = json(path.join(packageRoot, location, 'package.json'));
    if (!exact(pinned?.version) || pinned.version !== pkg.version || pinned.link) throw new Error(`Lock version mismatch: ${location}`);
    const files = filesAt(path.join(packageRoot, location)).filter(f => !f.name.startsWith('node_modules/') && !f.name.startsWith('.bin/'));
    const native = pkg.gypfile || pkg.os || pkg.cpu || /node-gyp|node-pre-gyp|prebuild-install|cmake-js/.test(pkg.scripts?.install || '')
      || files.some(f => /(?:\.(?:node|so|dll|dylib)$|binding\.gyp$)/.test(f.name));
    if (native) platformRequirements.push({ package: pkg.name, version: pkg.version, os: pkg.os || null, cpu: pkg.cpu || null, reason: 'native/platform package needs target ABI build and App verification' });
    packages.push({ path: location, name: pkg.name, version: pkg.version, integrity: pinned.integrity || null, resolved: pinned.resolved || null });
    for (const f of files) {
      const name = `${location}/${f.name}`, bytes = fs.readFileSync(f.full);
      if (cleanPath(name)) { checkSecrets(name, bytes); entries.set(name, bytes); }
    }
    for (const name of Object.keys(pkg.dependencies || {})) bundle(locate(name, location));
    for (const name of Object.keys(pkg.optionalDependencies || {})) {
      try { bundle(locate(name, location)); }
      catch (e) { platformRequirements.push({ package: name, reason: e.message }); }
    }
    for (const name of Object.keys(pkg.peerDependencies || {})) {
      if (!pkg.peerDependenciesMeta?.[name]?.optional) bundle(locate(name, location));
    }
  }
  for (const [name, version] of npm) {
    const location = locate(name);
    if (lock.packages[location].version !== version) throw new Error(`Pinned version mismatch: ${name}`);
    bundle(location);
  }
  const directory = path.join(output, 'bundle'); fs.mkdirSync(directory);
  const locked = { lockfileVersion: 3, packages: { '': { dependencies: Object.fromEntries(npm) }, ...Object.fromEntries(packages.map(p => [p.path, lock.packages[p.path]])) } };
  // The bundle lock is a receipt, not a replacement for the engine's full lock.
  const files = [];
  for (const [name, bytes] of entries) {
    write(path.join(directory, name), bytes);
    const base = path.join(engineRoot, name);
    files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes), baseSha256: fs.existsSync(base) ? sha256(fs.readFileSync(base)) : null });
  }
  const manifest = { schemaVersion: 1, kind: 'engine-dependency-patch', sourceSha256: sha256(Buffer.from(source)), coreJS: scan.coreJS,
    scriptsDisabled: true, packages, files, platformRequirements };
  writeJson(path.join(output, 'dependency-lock.json'), locked); writeJson(path.join(output, 'patch-manifest.json'), manifest);
  const archive = createZip([...entries].map(([name, content]) => ({ name, content })));
  write(path.join(output, 'bundle.zip'), archive);
  return { success: !platformRequirements.length, directory, archivePath: path.join(output, 'bundle.zip'), sha256: sha256(archive), manifest, platformRequirements };
}

function verifiedEntries(archive, expected, manifest) {
  if (manifest?.platformRequirements?.length) throw new Error('PLATFORM_REQUIREMENT: prepared native/platform dependencies cannot be applied as a portable patch');
  if (!/^[a-f0-9]{64}$/i.test(expected || '') || sha256(archive) !== expected) throw new Error('Export/archive SHA mismatch');
  const entries = readZip(archive);
  let files = manifest?.files;
  const metadata = manifest?.syncPatchMetadata || (manifest?.entries ? manifest : null);
  if (metadata) {
    const embedded = entries.find(e => e.name === 'engine-maintenance-patches.json');
    if (!embedded || !isDeepStrictEqual(JSON.parse(embedded.content.toString('utf8')), metadata)) throw new Error('Export patch metadata mismatch');
    for (const e of entries) {
      if (['aibox.json', 'index.json'].includes(e.name)) {
        const catalog = JSON.parse(e.content.toString('utf8'));
        if (Object.values(catalog).some(v => !Array.isArray(v) || v.length)) throw new Error(`Private export catalog rejected: ${e.name}`);
      } else if (e.name !== 'engine-maintenance-patches.json') assertClean(e.name, e.content);
    }
    files = metadata.entries.filter(e => !['aibox.json', 'index.json', 'engine-maintenance-patches.json'].includes(e.relativePath)).map(e => {
      if (e.storedArtifact != null && e.storedArtifact !== e.relativePath) throw new Error('Export storedArtifact/path mismatch');
      return { path: e.relativePath, baseSha256: e.baseSha256, sha256: e.newSha256, delete: e.storedArtifact == null };
    });
  }
  if (!Array.isArray(files)) throw new Error('Verified patch/export manifest.files is required');
  const seen = new Set();
  for (const f of files) {
    safePath(f.path);
    if (seen.has(f.path.toLowerCase())) throw new Error(`Duplicate manifest path: ${f.path}`);
    seen.add(f.path.toLowerCase());
    if (f.delete) { if (!cleanPath(f.path)) throw new Error(`Private delete rejected: ${f.path}`); continue; }
    const entry = entries.find(e => e.name === f.path);
    if (!entry || sha256(entry.content) !== f.sha256) throw new Error(`File SHA mismatch: ${f.path}`);
    assertClean(entry.name, entry.content);
  }
  if (!metadata && entries.some(e => !files.some(f => f.path === e.name && !f.delete))) throw new Error('Unlisted ZIP file');
  return { entries, files };
}

export function exportToPatch(archive, exported) {
  if (!exported?.syncPatchMetadata) throw new Error('Export has no syncPatchMetadata');
  const { entries, files } = verifiedEntries(archive, exported.sha256, exported);
  const patchEntries = entries.filter(e => files.some(f => !f.delete && f.path === e.name));
  const bytes = createZip(patchEntries);
  const identity = entries.find(e => e.name === 'aibox-engine.json');
  return { archive: bytes, sha256: sha256(bytes), manifest: { schemaVersion: 1, kind: 'engine-export-patch', exportSha256: exported.sha256,
    ...(identity ? { engineIdentity: JSON.parse(identity.content.toString('utf8')) } : {}), files } };
}
function conflictsFor(engineRoot, files) {
  const conflicts = [];
  for (const f of files) {
    if (!Object.hasOwn(f, 'baseSha256')) throw new Error(`Patch baseSha256 (null for new files) required: ${f.path}`);
    const file = path.join(engineRoot, f.path);
    const actual = fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
    if (actual !== f.baseSha256 && actual !== f.sha256) conflicts.push({ path: f.path, expected: f.baseSha256, actual, incoming: f.sha256 || null });
  }
  return conflicts;
}

export async function syncCandidate(options) {
  const { engineRoot, originalZip, backupDir, out, archive, manifest } = options;
  const { entries, files } = verifiedEntries(archive, options.sha256, manifest);
  const parent = isolated(out, engineRoot);
  const backup = await backupBaseline({ engineRoot, originalZip, backupDir });
  const conflicts = conflictsFor(engineRoot, files);
  const candidateVersion = `candidate-${Date.now()}-${randomUUID().slice(0, 8)}`;
  fs.mkdirSync(parent, { recursive: true });
  const directory = path.join(parent, candidateVersion); fs.mkdirSync(directory);
  const excluded = [];
  for (const f of filesAt(path.join(backup.directory, 'engine'))) {
    if (!cleanPath(f.name)) { excluded.push(f.name); continue; }
    const bytes = fs.readFileSync(f.full); checkSecrets(f.name, bytes); write(path.join(directory, f.name), bytes);
  }
  // No catalog from the device or local project enters a release candidate.
  writeJson(path.join(directory, 'aibox.json'), { sites: [], parses: [], lives: [] });
  writeJson(path.join(directory, 'index.json'), { sites: [], parses: [] });
  if (!conflicts.length) {
    for (const f of files) {
      const target = path.join(directory, f.path);
      if (fs.existsSync(target)) fs.unlinkSync(target);
      if (!f.delete) write(target, entries.find(e => e.name === f.path).content);
    }
  }
  const result = { success: !conflicts.length, candidateVersion, directory, backup: backup.directory, conflicts, excluded };
  if (!conflicts.length) {
    const identityPath = path.join(directory, 'aibox-engine.json');
    const exportedIdentity = entries.find(e => e.name === 'aibox-engine.json');
    const identity = manifest.engineIdentity || (exportedIdentity ? JSON.parse(exportedIdentity.content.toString('utf8')) : fs.existsSync(identityPath) ? json(identityPath) : null);
    if (identity) {
      if (fs.existsSync(identityPath)) fs.unlinkSync(identityPath);
      writeJson(identityPath, { schemaVersion: identity.schemaVersion || 1, engine: identity.engine || 'aibox-drpy-node',
        protocolVersion: identity.protocolVersion || 1, version: candidateVersion, platform: identity.platform,
        architecture: identity.architecture, includesNode: false, requiredFiles: (identity.requiredFiles || []).filter(f => cleanPath(f)) });
    }
    const finalEntries = filesAt(directory).map(f => ({ name: f.name, content: fs.readFileSync(f.full) }));
    const bytes = createZip(finalEntries);
    result.archivePath = path.join(parent, `${candidateVersion}.zip`); result.sha256 = sha256(bytes);
    write(result.archivePath, bytes);
    writeJson(path.join(parent, `${candidateVersion}.manifest.json`), { candidateVersion, sha256: result.sha256,
      files: finalEntries.map(e => ({ path: e.name, bytes: e.content.length, sha256: sha256(e.content) })) });
  }
  writeJson(path.join(parent, `${candidateVersion}.json`), result);
  return result;
}

export async function applyBundle(options) {
  options = { ...options, engineRoot: path.resolve(options.engineRoot) };
  const { entries, files } = verifiedEntries(options.archive, options.sha256, options.manifest);
  const backup = await backupBaseline(options);
  const conflicts = conflictsFor(options.engineRoot, files);
  if (conflicts.length) { writeJson(path.join(backup.directory, 'conflicts.json'), conflicts); return { success: false, backup: backup.directory, conflicts }; }
  // Fail before mutation if any parent is a symlink or existing non-directory.
  for (const f of files) {
    let target = path.join(options.engineRoot, f.path);
    while (target !== path.resolve(options.engineRoot)) {
      if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`Symlink target rejected: ${target}`);
      target = path.dirname(target);
    }
  }
  try {
    for (const f of files) {
      const target = path.join(options.engineRoot, f.path);
      if (f.delete) { if (fs.existsSync(target)) fs.unlinkSync(target); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.aibox-${randomUUID()}`;
      write(temporary, entries.find(e => e.name === f.path).content); fs.renameSync(temporary, target);
    }
    for (const f of files) if (!f.delete && sha256(fs.readFileSync(path.join(options.engineRoot, f.path))) !== f.sha256) throw new Error(`Applied SHA mismatch: ${f.path}`);
    return { success: true, backup: backup.directory, applied: files.length };
  } catch (e) { throw new Error(`APPLY_INCOMPLETE: restore reviewed files from ${backup.directory}; ${e.message}`); }
}
