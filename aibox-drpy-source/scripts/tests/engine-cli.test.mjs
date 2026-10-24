import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { main } from '../aibox-engine-tools.mjs';
import { createZip, sha256 } from '../lib/engine-toolkit.mjs';

test('CLI performs one-session commit, verified remote download, patch conversion and backed-up clean sync', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-engine-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'engine'); fs.mkdirSync(path.join(engine, 'libs'), { recursive: true });
  fs.mkdirSync(path.join(engine, 'spider/js'), { recursive: true });
  fs.writeFileSync(path.join(engine, 'spider/js/private.js'), 'private-source');
  fs.writeFileSync(path.join(engine, 'package.json'), '{"name":"aibox-engine"}');
  fs.writeFileSync(path.join(engine, 'libs/drpyS.js'), 'export const engine = true;');
  const changed = Buffer.from('export const helper = true;');
  const metadata = { schemaVersion: 1, entries: [{ relativePath: 'libs/helper.js', baseSha256: null, newSha256: sha256(changed), storedArtifact: 'libs/helper.js', platform: 'android', arch: 'arm64' }] };
  const archive = createZip([
    { name: 'libs/helper.js', content: changed },
    { name: 'aibox.json', content: Buffer.from('{"sites":[],"parses":[],"lives":[]}') },
    { name: 'aibox-engine.json', content: Buffer.from('{"version":"remote","platform":"android","architecture":"arm64","requiredFiles":["libs/helper.js"]}') },
    { name: 'engine-maintenance-patches.json', content: Buffer.from(JSON.stringify(metadata)) }
  ]);
  const original = path.join(root, 'original.zip'); fs.writeFileSync(original, archive);
  const exported = { artifactPath: 'exports/remote.zip', sha256: sha256(archive), size: archive.length, syncPatchMetadata: metadata };
  const calls = []; let draftEtag = 'draft-1';
  const names = ['info', 'workspace.open', 'workspace.file.patch', 'workspace.diff', 'workspace.validate', 'workspace.commit', 'workspace.export', 'export.read', 'status', 'backups.list'];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const c of req) text += c;
    const request = JSON.parse(text); let result;
    if (request.method === 'initialize') { res.setHeader('Mcp-Session-Id', 's1'); result = { protocolVersion: '2025-11-25' }; }
    else if (request.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    else if (request.method === 'tools/list') result = { tools: names.map(n => ({ name: `aibox.engine.${n}`, inputSchema: { type: 'object' } })) };
    else {
      const { name, arguments: args } = request.params; calls.push({ name, args, session: req.headers['mcp-session-id'] });
      let value = {};
      if (name.endsWith('workspace.open')) value = { workspaceId: 'w1', draftEtag };
      else if (name.endsWith('file.patch')) { draftEtag = 'draft-2'; value = { draftEtag }; }
      else if (name.endsWith('workspace.diff')) value = { draftEtag };
      else if (name.endsWith('workspace.validate')) value = { valid: true };
      else if (name.endsWith('workspace.commit')) value = { transactionId: 'tx1', draftEtag };
      else if (name.endsWith('workspace.export')) value = exported;
      else if (name.endsWith('export.read')) {
        const nextOffset = Math.min(args.offset + args.maxBytes, archive.length);
        value = { base64Content: archive.subarray(args.offset, nextOffset).toString('base64'), nextOffset, totalBytes: archive.length, complete: nextOffset === archive.length, sha256: exported.sha256 };
      }
      result = { isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] };
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const plan = path.join(root, 'plan.json'); fs.writeFileSync(plan, JSON.stringify([
    { operation: 'workspace.open' }, { operation: 'workspace.file.patch', args: { path: 'libs/helper.js', content: changed.toString() } },
    { operation: 'workspace.commit', args: { modules: ['libs/helper.js'] } }, { id: 'export', operation: 'workspace.export', maxBytes: 64 }
  ]));
  const originalWrite = process.stdout.write; let output = '';
  process.stdout.write = (value, ...args) => {
    // Node's test runner also writes binary IPC on stdout; leave it intact.
    if (typeof value !== 'string') return originalWrite.call(process.stdout, value, ...args);
    output += value; return true;
  };
  let result;
  try {
    result = await main(['mcp', '--url', `http://127.0.0.1:${server.address().port}/mcp`, '--plan', plan,
      '--engine-root', engine, '--backup-dir', path.join(root, 'backups'), '--original-zip', original,
      '--download-dir', path.join(root, 'downloads'), '--sync-out', path.join(root, 'candidates'), '--source-modules', '["business-source"]']);
  } finally { process.stdout.write = originalWrite; }
  assert.equal(JSON.parse(output).success, true); assert.equal(result.success, true);
  assert.deepEqual(calls.find(c => c.name.endsWith('workspace.commit')).args.sourceModules, ['business-source']);
  assert.equal(calls.find(c => c.name.endsWith('workspace.commit')).args.expectedDraftEtag, 'draft-2');
  assert.ok(calls.every(c => c.session === 's1'));
  assert.ok(calls.filter(c => c.name.endsWith('export.read')).length > 1);
  const sync = result.results.export.sync;
  assert.equal(sync.success, true);
  assert.equal(fs.readFileSync(path.join(sync.directory, 'libs/helper.js'), 'utf8'), changed.toString());
  assert.equal(fs.existsSync(path.join(sync.directory, 'spider/js/private.js')), false);
  const identity = JSON.parse(fs.readFileSync(path.join(sync.directory, 'aibox-engine.json'), 'utf8'));
  assert.equal(identity.version, sync.candidateVersion);
  assert.equal(identity.platform, 'android');
  assert.ok(fs.readFileSync(path.join(sync.backup, 'original.zip')).equals(archive));
  assert.equal(fs.existsSync(path.join(engine, 'libs/helper.js')), false);
});
