#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveNativeEngineLayout } from './lib/aibox-engine-adapter.mjs';
import { inspectDependencies, prepareBundle, backupBaseline, applyBundle, syncCandidate } from './lib/engine-toolkit.mjs';
import { McpClient } from './lib/mcp-client.mjs';
import { runEnginePlan } from './lib/engine-mcp.mjs';

const usage = `AIBOX engine tools (Node >=22; JSON output)
  inspect --source FILE [--engine-root DIR]
  prepare --source FILE --out NEW_DIR [--pins JSON_FILE] [--assets JSON_FILE] [--lockfile FILE] [--install]
  backup --backup-dir DIR [--original-zip ZIP]
  apply --archive ZIP --sha256 SHA --manifest JSON --backup-dir DIR [--original-zip ZIP]
  sync --archive ZIP --sha256 SHA --manifest JSON --backup-dir DIR --out DIR [--original-zip ZIP]
  mcp --url http://HOST:8765/mcp [--plan JSON_ARRAY] [--backup-dir DIR] [--original-zip ZIP]
      [--source-modules JSON_ARRAY_OR_FILE] [--download-dir DIR] [--sync-out DIR]
All local commands accept --engine-root DIR. Explicit root wins; otherwise cwd ancestors are searched.
Pins: {"webp-wasm":"1.0.5"}; assets: [{"file":"helper.js","path":"spider/js/_lib.helper.js","sha256":"..."}].
--install runs npm only in a new isolated directory, with scripts disabled.
mcp without --plan lists actual advertised tool names and schemas. Plans run in ONE MCP session.
Token: optional AIBOX_STUDIO_TOKEN environment variable; never put credentials in URL/plan.
Commit plans require --backup-dir; the App also creates its own durable runtime backup.
--download-dir downloads/verifies workspace.export through advertised export.read; --sync-out also merges a patch-only ZIP into a clean local candidate.
modules are runtime file paths; sourceModules are business module names (source L3), never library paths.
`;

function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument: ${argv[i]}`);
    const [key, inline] = argv[i].slice(2).split(/=(.*)/s);
    options[key] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return options;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function need(options, ...names) {
  for (const name of names) if (typeof options[name] !== 'string' || !options[name]) throw new Error(`Missing --${name}`);
}
function archiveOptions(options, engineRoot) {
  need(options, 'archive', 'sha256', 'manifest', 'backup-dir');
  return { engineRoot, archive: fs.readFileSync(options.archive), sha256: options.sha256, manifest: readJson(options.manifest),
    originalZip: options['original-zip'], backupDir: options['backup-dir'] };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) { process.stdout.write(usage); return; }
  const options = parse(rest), engineRoot = resolveNativeEngineLayout(null, { engineRoot: options['engine-root'] }).engineRoot;
  let result;
  switch (command) {
    case 'inspect':
      need(options, 'source'); result = inspectDependencies(fs.readFileSync(options.source, 'utf8'), { engineRoot }); break;
    case 'prepare': {
      need(options, 'source', 'out');
      const assets = options.assets ? readJson(options.assets).map(a => ({ ...a, file: path.resolve(path.dirname(options.assets), a.file) })) : [];
      result = await prepareBundle({ engineRoot, sourcePath: path.resolve(options.source), source: fs.readFileSync(options.source, 'utf8'),
        out: options.out, pins: options.pins ? readJson(options.pins) : {}, assets, lockFile: options.lockfile, install: options.install === true }); break;
    }
    case 'backup':
      need(options, 'backup-dir'); result = await backupBaseline({ engineRoot, originalZip: options['original-zip'], backupDir: options['backup-dir'] }); break;
    case 'apply': result = await applyBundle(archiveOptions(options, engineRoot)); break;
    case 'sync': need(options, 'out'); result = await syncCandidate({ ...archiveOptions(options, engineRoot), out: options.out }); break;
    case 'mcp': {
      need(options, 'url');
      const client = new McpClient({ url: options.url, token: process.env.AIBOX_STUDIO_TOKEN || '', timeout: options.timeout ? Number(options.timeout) : undefined });
      const tools = await client.connect();
      if (!options.plan) { result = { connected: true, tools }; break; }
      const steps = readJson(options.plan);
      if (options['source-modules']) need(options, 'source-modules');
      const sourceModules = options['source-modules'] ? (options['source-modules'].trim().startsWith('[') ? JSON.parse(options['source-modules']) : readJson(options['source-modules'])) : [];
      if (!Array.isArray(sourceModules) || sourceModules.some(m => typeof m !== 'string' || !m.trim())) throw new Error('--source-modules must be a JSON array or JSON file of business module names');
      if (options['sync-out']) need(options, 'backup-dir');
      let backupDirectory;
      if (steps.some(s => s.operation === 'workspace.commit')) {
        need(options, 'backup-dir');
        backupDirectory = (await backupBaseline({ engineRoot, originalZip: options['original-zip'], backupDir: options['backup-dir'] })).directory;
      }
      const results = await runEnginePlan(client, steps, { backupDirectory, sourceModules, engineRoot,
        backupDir: options['backup-dir'], originalZip: options['original-zip'], downloadDir: options['download-dir'], syncOut: options['sync-out'] });
      result = { connected: true, success: !Object.values(results).some(r => r.success === false || r.sync?.success === false), backupDirectory, results }; break;
    }
    default: throw new Error(`Unknown engine command: ${command}`);
  }
  if (result.success === false) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => {
  const token = process.env.AIBOX_STUDIO_TOKEN;
  process.stderr.write(`ERROR: ${token ? e.message.replaceAll(token, '<redacted>') : e.message}\n`); process.exitCode = 1;
});
