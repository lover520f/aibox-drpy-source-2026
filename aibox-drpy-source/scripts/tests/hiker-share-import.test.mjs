import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  decodeHikerCloudRecord,
  extractHikerCloudReference,
  importHikerRule,
  parseHikerShareText,
  saveImportedHikerRule,
} from '../lib/hiker-share-import.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, '..', '..');
const cliPath = path.join(skillRoot, 'scripts', 'aibox-skill-cli.mjs');

test('解析海阔云2别名与 textdb URL，并去掉仅用于口令的 apidb 段', () => {
  assert.deepEqual(extractHikerCloudReference('云2oooole/apidb/exampleKey'), {
    key: 'exampleKey',
    kind: 'hiker-cloud2-alias',
    original: '云2oooole/apidb/exampleKey',
  });
  assert.deepEqual(extractHikerCloudReference('https://api.textdb.online/apidb/exampleKey'), {
    key: 'exampleKey',
    kind: 'textdb-url',
    original: 'https://api.textdb.online/apidb/exampleKey',
  });
});

test('解析带名称的 base64://@名称@载荷并识别内嵌页面依赖', () => {
  const fixture = createRuleFixture();
  const phrase = `海阔视界规则分享，当前分享的是：小程序￥home_rule_v2￥base64://@示例应用@${base64(JSON.stringify(fixture))}`;
  const stored = base64Url(phrase);
  const parsed = parseHikerShareText(decodeHikerCloudRecord(stored));

  assert.equal(parsed.format, 'home_rule_v2');
  assert.equal(parsed.shareName, '示例应用');
  assert.equal(parsed.summary.title, '示例应用');
  assert.equal(parsed.summary.pageCount, 2);
  assert.deepEqual(parsed.pages.map((item) => item.path), ['hanshu', 'examplePage']);
  assert.deepEqual(parsed.dependencies, [
    { name: 'hanshu', kind: 'embedded-page', embedded: true },
    { name: 'hiker://assets/crypto-java.js', kind: 'hiker-builtin-asset', embedded: false },
  ]);
  assert.deepEqual(parsed.warnings, []);
});

test('兼容 aibox-hiker 导出的 encodeURIComponent home_rule_v2', () => {
  const fixture = createRuleFixture();
  const payload = base64(encodeURIComponent(JSON.stringify(fixture)));
  const parsed = parseHikerShareText(`海阔视界，首页频道￥home_rule_v2￥${payload}`);

  assert.equal(parsed.summary.title, '示例应用');
  assert.equal(parsed.rule.author, 'zhao');
});

test('下载时跳过空的 apidb 响应并使用 textdb 根路径内容', async () => {
  const fixture = createRuleFixture();
  const phrase = `海阔视界规则分享￥home_rule_v2￥base64://@示例应用@${base64(JSON.stringify(fixture))}`;
  const stored = base64Url(phrase);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => stored,
    };
  };
  const imported = await importHikerRule({
    text: '云2oooole/apidb/testKey',
    fetchImpl,
  });

  assert.deepEqual(calls, ['https://api.textdb.online/testKey']);
  assert.equal(imported.source.url, 'https://api.textdb.online/testKey');
  assert.equal(imported.summary.title, '示例应用');
});

test('保存海阔规则时原子写入并回读 SHA-256', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-hiker-import-'));
  try {
    const filePath = path.join(root, '示例应用.json');
    const fixture = createRuleFixture();
    const saved = saveImportedHikerRule({ rule: fixture, filePath });

    assert.equal(saved.filePath, filePath);
    assert.equal(saved.sha256.length, 64);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), fixture);
    assert.throws(() => saveImportedHikerRule({ rule: fixture, filePath }), /文件已存在/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hiker-import CLI 从文本文件解析并保存规则', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-hiker-import-cli-'));
  try {
    const fixture = createRuleFixture();
    const phrase = `海阔视界规则分享￥home_rule_v2￥base64://@示例应用@${base64(JSON.stringify(fixture))}`;
    const textFile = path.join(root, 'share.txt');
    const outputFile = path.join(root, '示例应用.json');
    fs.writeFileSync(textFile, phrase, 'utf8');

    const result = spawnSync(process.execPath, [
      cliPath,
      'hiker-import',
      '--text-file', textFile,
      '--output-file', outputFile,
    ], {
      cwd: skillRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || '').trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'hiker-import');
    assert.equal(payload.data.summary.title, '示例应用');
    assert.equal(payload.data.execution, 'not-evaluated');
    assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, 'utf8')), fixture);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createRuleFixture() {
  const pageList = [
    {
      name: '函数',
      path: 'hanshu',
      col_type: 'movie_3',
      rule: '$.exports = { load: () => require("hiker://assets/crypto-java.js") };',
    },
    {
      name: '示例',
      path: 'examplePage',
      col_type: 'movie_3',
      rule: 'js:\n$.require("hanshu").shouye();',
    },
  ];
  return {
    title: '示例应用',
    author: 'zhao',
    version: 1,
    type: 'video',
    group: '#',
    url: 'hiker://empty##fypage',
    search_url: 'hiker://empty##**',
    find_rule: 'js:\n$.require("hanshu").shouye();',
    pages: JSON.stringify(pageList),
  };
}

function base64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function base64Url(value) {
  return base64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
