import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

async function clientModule() {
  const url = new URL('../lib/mcp-client.mjs', import.meta.url);
  assert.ok(fs.existsSync(url), 'session-aware MCP discovery/client is missing');
  return import(url);
}
async function withServer(t, responder) {
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    await responder(body, req, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

test('MCP persists session, discovers paginated advertised tools, decodes split UTF8 SSE and rejects both error layers', async t => {
  const { McpClient } = await clientModule();
  const seen = [];
  const url = await withServer(t, async (body, req, res) => {
    seen.push({ body, session: req.headers['mcp-session-id'] });
    if (body.method === 'initialize') {
      res.setHeader('Mcp-Session-Id', 'session-1');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25' } })); return;
    }
    assert.equal(req.headers['mcp-session-id'], 'session-1');
    if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    let result;
    if (body.method === 'tools/list') result = body.params.cursor
      ? { tools: [{ name: 'aibox.engine.workspace.validate', inputSchema: { type: 'object', required: ['workspaceId'], properties: { workspaceId: { type: 'string' } } } }] }
      : { tools: [{ name: 'aibox.engine.info', inputSchema: { type: 'object' } }], nextCursor: 'page-2' };
    else result = body.params.arguments.fail === 'transport'
      ? { isError: true, content: [{ type: 'text', text: '{"success":true}' }] }
      : { isError: false, content: [{ type: 'text', text: JSON.stringify({ success: body.params.arguments.fail !== 'validation', label: '中文🙂' }) }] };
    const encoded = Buffer.from(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`);
    res.setHeader('Content-Type', 'text/event-stream');
    const split = Math.max(1, encoded.indexOf(Buffer.from('中文')) + 2);
    res.write(encoded.subarray(0, split)); setImmediate(() => res.end(encoded.subarray(split)));
  });
  const client = new McpClient({ url }); await client.connect();
  assert.equal(client.tools.size, 2);
  assert.equal((await client.call('aibox.engine.info', {})).label, '中文🙂');
  await assert.rejects(client.call('aibox.engine.unadvertised', {}), /advertised/);
  await assert.rejects(client.call('aibox.engine.workspace.validate', {}), /workspaceId/);
  await assert.rejects(client.call('aibox.engine.info', { fail: 'transport' }), /isError/);
  await assert.rejects(client.call('aibox.engine.info', { fail: 'validation' }), /success=false/);
  assert.ok(seen.slice(1).every(x => x.session === 'session-1'));
});

test('engine upload uses byte offsets, verifies status and aborts failed chunks', async () => {
  const url = new URL('../lib/engine-mcp.mjs', import.meta.url);
  assert.ok(fs.existsSync(url), 'engine flow / verified chunk upload is missing');
  const { uploadEngineBundle } = await import(url);
  const sent = [], bytes = Buffer.from('中文🙂binary');
  const { sha256 } = await import('../lib/engine-toolkit.mjs');
  const client = { async call(name, args) {
    sent.push({ name, args });
    if (name.endsWith('.begin')) return { uploadId: 'u1' };
    if (name.endsWith('.status')) return { receivedBytes: bytes.length, totalBytes: bytes.length, sha256: sha256(bytes) };
    return { success: true };
  } };
  await uploadEngineBundle(client, { workspaceId: 'w1', bytes, chunkBytes: 4 });
  const chunks = sent.filter(x => x.name.endsWith('.append'));
  assert.deepEqual(chunks.map(x => x.args.offset), [0, 4, 8, 12]);
  assert.ok(Buffer.concat(chunks.map(x => Buffer.from(x.args.base64Chunk, 'base64'))).equals(bytes));
  assert.equal(sent[0].args.totalBytes, bytes.length);
  client.call = async (name, args) => { sent.push({ name, args }); if (name.endsWith('.begin')) return { uploadId: 'u2' }; if (name.endsWith('.append')) throw new Error('chunk failed'); return {}; };
  await assert.rejects(uploadEngineBundle(client, { workspaceId: 'w1', bytes }), /chunk failed/);
  assert.equal(sent.at(-1).name, 'aibox.engine.upload.abort');
});

test('disconnected MCP never returns App-test success', async () => {
  const { McpClient } = await clientModule();
  const client = new McpClient({ url: 'http://127.0.0.1:1/mcp', timeout: 100 });
  await assert.rejects(client.connect());
  await assert.rejects(client.call('aibox.engine.info', {}), /connect/);
});

test('direct App MCP can negotiate sessionless transport without inventing a server session header', async t => {
  const { McpClient } = await clientModule();
  const url = await withServer(t, (body, req, res) => {
    assert.equal(req.headers['mcp-session-id'], undefined);
    if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize'
      ? { protocolVersion: '2025-11-25' } : { tools: [] } }));
  });
  const client = new McpClient({ url });
  await client.connect(); assert.equal(client.connected, true); assert.equal(client.sessionMode, 'sessionless');
});

test('engine workspace follows draft ETags, UTF8 offsets, validate/commit/status/export and transaction rollback', async t => {
  const { EngineWorkspaceClient, runEnginePlan } = await import('../lib/engine-mcp.mjs');
  const { backupBaseline } = await import('../lib/engine-toolkit.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-mcp-flow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'engine'); fs.mkdirSync(engine); fs.writeFileSync(path.join(engine, 'index.js'), 'export const x = 1;');
  const backup = await backupBaseline({ engineRoot: engine, backupDir: path.join(root, 'backups') });
  const calls = []; let version = 'draft-1';
  const client = { async call(name, args) {
    calls.push({ name, args });
    if (name.endsWith('workspace.open')) return { workspaceId: 'w1', draftEtag: version };
    if (name.endsWith('file.read')) return args.offset === 0
      ? { content: '中文', etag: 'file-etag', draftEtag: version, complete: false, nextOffset: 6, redacted: true }
      : { code: 'done', etag: 'file-etag', draftEtag: version, complete: true, redacted: true };
    if (name.endsWith('file.patch') || name.endsWith('file.delete')) { assert.equal(args.expectedDraftEtag, version); version = `draft-${calls.length}`; return { draftEtag: version }; }
    if (name.endsWith('workspace.validate')) return { valid: true, runtimeValidationRequired: true };
    if (name.endsWith('workspace.commit')) { assert.equal(args.expectedDraftEtag, version); assert.deepEqual(args.modules, ['libs/helper.js']); return { transactionId: 'tx1', draftEtag: version }; }
    if (name.endsWith('workspace.export')) return { artifactPath: 'exports/clean.zip', sha256: 'digest', syncPatchMetadata: { entries: [] } };
    return { draftEtag: version, success: true };
  } };
  const workspace = new EngineWorkspaceClient(client, { backupDirectory: backup.directory }); await workspace.open();
  const read = await workspace.read('libs/helper.js'); assert.equal(read.content, '中文done'); assert.equal(read.redacted, true);
  assert.equal(calls.at(-1).args.offset, 6);
  await workspace.patch('libs/helper.js', { patches: [{ find: 'old', replace: 'new' }] });
  await workspace.delete('libs/old.js'); await workspace.commit(['libs/helper.js']);
  const result = await runEnginePlan(client, [
    { operation: 'workspace.open' }, { operation: 'dependencies.inspect', args: { paths: ['libs/helper.js'] } },
    { id: 'commit', operation: 'workspace.commit', args: { modules: ['libs/helper.js'] } },
    { operation: 'workspace.export' }, { operation: 'status', args: { transactionId: 'tx1' } },
    { operation: 'backups.list' }, { operation: 'workspace.rollback', from: 'commit' }
  ], { backupDirectory: backup.directory });
  assert.equal(result.commit.transactionId, 'tx1');
  assert.equal(calls.at(-1).args.transactionId, 'tx1');
  const withoutBackup = new EngineWorkspaceClient(client); await withoutBackup.open();
  await assert.rejects(withoutBackup.commit(), /backup/);
});

test('export.read downloads byte chunks and verifies total size, offsets, completion and overall SHA', async () => {
  const { EngineWorkspaceClient } = await import('../lib/engine-mcp.mjs');
  const { sha256 } = await import('../lib/engine-toolkit.mjs');
  const bytes = Buffer.from('中文🙂full-zip-bytes'), calls = [];
  const exported = { artifactPath: 'exports/opaque.zip', sha256: sha256(bytes), size: bytes.length, syncPatchMetadata: { entries: [] } };
  const client = { async call(name, args) {
    calls.push({ name, args });
    const next = Math.min(args.offset + args.maxBytes, bytes.length);
    return { base64Content: bytes.subarray(args.offset, next).toString('base64'), nextOffset: next, totalBytes: bytes.length, complete: next === bytes.length, sha256: exported.sha256 };
  } };
  const workspace = new EngineWorkspaceClient(client);
  assert.equal(typeof workspace.downloadArtifact, 'function', 'artifact download is missing');
  const result = await workspace.downloadArtifact(exported, 4);
  assert.ok(result.equals(bytes)); assert.ok(calls.every(c => c.name === 'aibox.engine.export.read'));
  assert.deepEqual(calls.map(c => c.args.offset), [0, 4, 8, 12, 16, 20]);
  client.call = async () => ({ base64Content: bytes.toString('base64'), nextOffset: bytes.length, totalBytes: bytes.length, complete: true, sha256: '0'.repeat(64) });
  await assert.rejects(workspace.downloadArtifact(exported), /SHA/);
  client.call = async () => ({ base64Content: 'AQ==', nextOffset: 0, totalBytes: bytes.length, complete: false, sha256: exported.sha256 });
  await assert.rejects(workspace.downloadArtifact(exported), /offset|progress/);
});

test('commit keeps business sourceModules separate from runtime modules', async t => {
  const { EngineWorkspaceClient } = await import('../lib/engine-mcp.mjs');
  const { backupBaseline } = await import('../lib/engine-toolkit.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-source-modules-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'engine'); fs.mkdirSync(engine);
  const backup = await backupBaseline({ engineRoot: engine, backupDir: path.join(root, 'backups') });
  let commit;
  const client = { async call(name, args) {
    if (name.endsWith('.open')) return { workspaceId: 'w', draftEtag: 'd' };
    if (name.endsWith('.validate')) return { valid: true };
    if (name.endsWith('.commit')) { commit = args; return { transactionId: 't' }; }
    return { draftEtag: 'd' };
  } };
  const workspace = new EngineWorkspaceClient(client, { backupDirectory: backup.directory }); await workspace.open();
  await workspace.commit(['spider/js/_lib.helper.js'], ['business-source']);
  assert.deepEqual(commit.sourceModules, ['business-source']);
  assert.deepEqual(commit.modules, ['spider/js/_lib.helper.js']);
});
