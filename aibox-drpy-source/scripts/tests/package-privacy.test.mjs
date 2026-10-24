import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readZip } from '../lib/engine-zip.mjs';

const skillRoot = fileURLToPath(new URL('../../', import.meta.url));

test('public ZIP excludes local configuration, private engine and backups', { timeout: 90000, skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-skill-public-package-'));
  try {
    const candidate = path.join(root, 'aibox-drpy-source');
    fs.cpSync(skillRoot, candidate, {
      recursive: true,
      filter: file => !path.relative(skillRoot, file).split(path.sep).some(p => ['node_modules', 'output', 'temp'].includes(p)),
    });
    for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      fs.copyFileSync(path.join(skillRoot, '..', name), path.join(root, name));
    }
    const privatePaths = ['config/env.json', '.env.local', 'private.jks',
      'third_party/aibox-engine/index.js', 'backups/private.js', 'output/private.js'];
    for (const relative of privatePaths) {
      const file = path.join(candidate, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'test-only-private-payload');
    }
    const output = path.join(root, 'packages');
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
      path.join(candidate, 'scripts/package-skill.ps1'), '-SkillRoot', candidate,
      '-OutputDir', output, '-PackageName', 'test.zip'], { encoding: 'utf8', windowsHide: true, timeout: 75000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const entries = readZip(fs.readFileSync(path.join(output, 'test.zip')));
    for (const relative of privatePaths) {
      assert.ok(!entries.some(e => e.name === `aibox-drpy-source/${relative}`), relative);
    }
    assert.ok(entries.some(e => e.name === 'aibox-drpy-source/SKILL.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
