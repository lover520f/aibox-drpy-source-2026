import fs from 'node:fs';
import path from 'node:path';
import { sha256, verifyBackup, readZip, safePath, exportToPatch, isolated, syncCandidate } from './engine-toolkit.mjs';

const canonical = operation => `aibox.engine.${operation}`;
export async function uploadEngineBundle(client, { workspaceId, bytes, expectedDraftEtag, chunkBytes = 192 * 1024 } = {}) {
  if (!workspaceId || !Buffer.isBuffer(bytes) || !bytes.length) throw new Error('Upload needs workspaceId and nonempty bytes');
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 256 * 1024) throw new Error('chunkBytes must be 1..262144');
  const digest = sha256(bytes);
  const begin = await client.call(canonical('upload.begin'), { workspaceId, totalBytes: bytes.length, sha256: digest,
    ...(expectedDraftEtag ? { expectedDraftEtag } : {}) });
  const uploadId = begin.uploadId;
  if (!uploadId) throw new Error('upload.begin returned no uploadId');
  try {
    const limit = Math.min(chunkBytes, begin.chunkBytes || chunkBytes);
    for (let offset = 0; offset < bytes.length; offset += limit) {
      await client.call(canonical('upload.append'), { uploadId, offset, base64Chunk: bytes.subarray(offset, offset + limit).toString('base64') });
    }
    const status = await client.call(canonical('upload.status'), { uploadId });
    if ((status.receivedBytes ?? status.received) !== bytes.length || status.totalBytes !== bytes.length
      || (status.sha256 != null && status.sha256 !== digest)) throw new Error('Upload status byte/hash mismatch');
    // finish performs the server-side hash/path validation and updates draftEtag.
    const result = await client.call(canonical('upload.finish'), { uploadId,
      ...(expectedDraftEtag ? { expectedDraftEtag } : {}) });
    return { ...result, uploadId, uploadedSha256: digest, uploadedBytes: bytes.length };
  } catch (e) {
    try { await client.call(canonical('upload.abort'), { uploadId }); }
    catch { throw new Error(`${e.message}; upload abort failed; check session/upload.status`); }
    throw e;
  }
}

export class EngineWorkspaceClient {
  constructor(client, { backupDirectory } = {}) { this.client = client; this.backupDirectory = backupDirectory; this.workspaceId = null; this.draftEtag = null; }
  async call(operation, args = {}) { return this.client.call(canonical(operation), args); }
  async open() {
    const result = await this.call('workspace.open');
    if (!result.workspaceId || !result.draftEtag) throw new Error('workspace.open needs workspaceId and draftEtag');
    this.workspaceId = result.workspaceId; this.draftEtag = result.draftEtag; return result;
  }
  args(extra = {}, etag = false) {
    if (!this.workspaceId) throw new Error('Open the workspace in the current MCP session first');
    return { workspaceId: this.workspaceId, ...(etag ? { expectedDraftEtag: this.draftEtag } : {}), ...extra };
  }
  update(result) { if (result.draftEtag) this.draftEtag = result.draftEtag; return result; }
  async inspect(paths) { return this.call('dependencies.inspect', this.args(paths ? { paths } : {})); }
  async read(file, maxBytes = 8192) {
    let offset = 0, content = '', etag, draftEtag, redacted = false;
    for (;;) {
      const chunk = await this.call('workspace.file.read', this.args({ path: file, offset, maxBytes }));
      if (etag != null && chunk.etag !== etag) throw new Error('File ETag changed during chunk read');
      if (draftEtag != null && chunk.draftEtag !== draftEtag) throw new Error('Draft changed during chunk read');
      etag = chunk.etag; draftEtag = chunk.draftEtag; redacted ||= chunk.redacted === true;
      const text = chunk.content ?? chunk.code;
      if (typeof text !== 'string') throw new Error('file.read returned no UTF-8 content/code');
      content += text;
      if (Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error('file.read exceeds limit');
      if (chunk.complete === true) break;
      if (!Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset <= offset) throw new Error('Incomplete file.read needs increasing nextOffset');
      offset = chunk.nextOffset;
    }
    this.update({ draftEtag });
    return { path: file, content, etag, draftEtag, redacted, complete: true };
  }
  async patch(file, changes) {
    const result = await this.call('workspace.file.patch', this.args({ path: file, ...changes }, true));
    return this.update(result);
  }
  async delete(file) { return this.update(await this.call('workspace.file.delete', this.args({ path: file }, true))); }
  async diff() { return this.update(await this.call('workspace.diff', this.args())); }
  async validate(modules = []) { return this.call('workspace.validate', this.args({ modules })); }
  async upload(bytes, chunkBytes) {
    return this.update(await uploadEngineBundle(this.client, { workspaceId: this.workspaceId, expectedDraftEtag: this.draftEtag, bytes, chunkBytes }));
  }
  async commit(modules = [], sourceModules = []) {
    if (!this.backupDirectory) throw new Error('Verified local baseline backup is required before commit');
    verifyBackup(this.backupDirectory);
    await this.diff();
    const validation = await this.validate(modules);
    if (validation.valid !== true && validation.success !== true) throw new Error('Candidate validation did not explicitly pass');
    if (!Array.isArray(sourceModules) || sourceModules.some(m => typeof m !== 'string' || !m.trim())) throw new Error('sourceModules must contain business module names from aibox.source.list');
    const result = this.update(await this.call('workspace.commit', this.args({ modules, sourceModules }, true)));
    if (!result.transactionId) throw new Error('Commit returned no transactionId; inspect engine.status before retrying');
    return result;
  }
  async export() { return this.call('workspace.export', this.args({}, true)); }
  async downloadArtifact(exported, maxBytes = 192 * 1024) {
    safePath(exported?.artifactPath);
    if (!exported.artifactPath.startsWith('exports/') || !/^[a-f0-9]{64}$/i.test(exported.sha256 || '')
      || !Number.isSafeInteger(exported.size) || exported.size < 1 || exported.size > 268435456) throw new Error('Invalid exported artifact identity/size/SHA');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144) throw new Error('export.read maxBytes must be 1..262144');
    const chunks = []; let offset = 0;
    for (;;) {
      const chunk = await this.call('export.read', { artifactPath: exported.artifactPath, offset, maxBytes });
      if (chunk.totalBytes !== exported.size || chunk.sha256 !== exported.sha256) throw new Error('Export chunk size/SHA identity mismatch');
      if (typeof chunk.base64Content !== 'string') throw new Error('export.read returned no base64Content');
      const bytes = Buffer.from(chunk.base64Content, 'base64');
      if (bytes.toString('base64') !== chunk.base64Content) throw new Error('Invalid export Base64');
      if (chunk.nextOffset !== offset + bytes.length || chunk.nextOffset <= offset || bytes.length > maxBytes || chunk.nextOffset > exported.size) throw new Error('Export byte offset/progress mismatch');
      chunks.push(bytes); offset = chunk.nextOffset;
      if (chunk.complete === true) { if (offset !== exported.size) throw new Error('Export completed before all bytes'); break; }
      if (offset === exported.size) throw new Error('Export has all bytes but is not complete');
    }
    const archive = Buffer.concat(chunks);
    if (archive.length !== exported.size || sha256(archive) !== exported.sha256) throw new Error('Completed export SHA mismatch');
    return archive;
  }
  async rollback(transactionId, expectedCurrentEtag) {
    return this.call('workspace.rollback', { transactionId, ...(expectedCurrentEtag ? { expectedCurrentEtag } : {}) });
  }
}

// Plan operations run on one initialized session. IDs/ETags are never persisted
// as reusable credentials. Each step's output can be referenced by name.
export async function runEnginePlan(client, steps, { backupDirectory, sourceModules = [], engineRoot, backupDir, originalZip, downloadDir, syncOut } = {}) {
  if (!Array.isArray(steps)) throw new Error('Plan must be a JSON array');
  const workspace = new EngineWorkspaceClient(client, { backupDirectory }), results = {};
  for (const step of steps) {
    const op = step.operation;
    let result;
    switch (op) {
      case 'info': case 'backups.list': case 'status': result = await workspace.call(op, step.args || {}); break;
      case 'workspace.open': result = await workspace.open(); break;
      case 'dependencies.inspect': result = await workspace.inspect(step.args?.paths); break;
      case 'workspace.file.read': result = await workspace.read(step.args.path, step.args.maxBytes); break;
      case 'workspace.file.patch': { const { path, ...changes } = step.args; result = await workspace.patch(path, changes); break; }
      case 'workspace.file.delete': result = await workspace.delete(step.args.path); break;
      case 'workspace.diff': result = await workspace.diff(); break;
      case 'workspace.validate': result = await workspace.validate(step.args?.modules); break;
      case 'upload': {
        const bytes = fs.readFileSync(step.file);
        if (!step.sha256 || sha256(bytes) !== step.sha256) throw new Error('Plan upload SHA mismatch');
        readZip(bytes); result = await workspace.upload(bytes, step.chunkBytes); break;
      }
      case 'workspace.commit': result = await workspace.commit(step.args?.modules, step.args?.sourceModules || sourceModules); break;
      case 'workspace.export': {
        result = await workspace.export();
        if (step.out || downloadDir || syncOut) {
          const bytes = await workspace.downloadArtifact(result, step.maxBytes);
          const patch = exportToPatch(bytes, result);
          const parent = isolated(step.out || downloadDir || path.join(syncOut, '.verified-exports'), engineRoot);
          fs.mkdirSync(parent, { recursive: true });
          const directory = fs.mkdtempSync(path.join(parent, 'export-'));
          fs.writeFileSync(path.join(directory, 'engine-export.zip'), bytes, { flag: 'wx' });
          fs.writeFileSync(path.join(directory, 'export-metadata.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
          fs.writeFileSync(path.join(directory, 'patch.zip'), patch.archive, { flag: 'wx' });
          fs.writeFileSync(path.join(directory, 'patch-manifest.json'), JSON.stringify(patch.manifest, null, 2), { flag: 'wx' });
          result.download = { directory, bytes: bytes.length, sha256: result.sha256, patchSha256: patch.sha256 };
          if (syncOut) result.sync = await syncCandidate({ engineRoot, originalZip, backupDir, out: syncOut, archive: patch.archive, sha256: patch.sha256, manifest: patch.manifest });
        }
        break;
      }
      case 'workspace.rollback': {
        const tx = step.args?.transactionId || results[step.from]?.transactionId;
        if (!tx) throw new Error('Rollback needs a transactionId or from: commit-step-id');
        result = await workspace.rollback(tx, step.args?.expectedCurrentEtag); break;
      }
      default: throw new Error(`Unknown engine plan operation: ${op}`);
    }
    const id = step.id || `${Object.keys(results).length + 1}:${op}`;
    if (Object.hasOwn(results, id)) throw new Error(`Duplicate plan step id: ${id}`);
    results[id] = result;
  }
  return results;
}
