import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const defaultOptions = {
  timeoutMs: 15000,
  maxBytes: 5 * 1024 * 1024,
};

export function extractHikerCloudReference(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  const urlMatch = text.match(/https?:\/\/(?:api\.)?textdb\.online\/(?:apidb\/)?([A-Za-z0-9._-]+)/i);
  if (urlMatch) {
    return {
      key: validateCloudKey(urlMatch[1]),
      kind: 'textdb-url',
      original: urlMatch[0],
    };
  }

  const aliasMatch = text.match(/(?:云2)?[^\s/]*oooole\/apidb\/([A-Za-z0-9._-]+)/i)
    || text.match(/(?:云2)?[^\s]*?\/apidb\/([A-Za-z0-9._-]+)/i);
  if (aliasMatch) {
    return {
      key: validateCloudKey(aliasMatch[1]),
      kind: 'hiker-cloud2-alias',
      original: aliasMatch[0],
    };
  }

  return null;
}

export function decodeHikerCloudRecord(input) {
  const raw = stripBom(String(input || '')).trim();
  if (!raw) throw new Error('云剪切板内容为空');
  if (looksLikeHikerRule(raw)) return raw;

  const decodedBytes = decodeBase64Bytes(raw);
  if (!decodedBytes) return raw;

  let bytes = decodedBytes;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = gunzipSync(bytes);
  }
  const decoded = stripBom(bytes.toString('utf8')).trim();
  return decoded || raw;
}

export function parseHikerShareText(input) {
  const text = stripBom(String(input || '')).trim();
  if (!text) throw new Error('海阔分享内容为空');

  const v2Marker = '￥home_rule_v2￥';
  const plainMarker = '￥home_rule￥';
  let format = 'json';
  let label = '';
  let shareName = '';
  let jsonText = '';

  if (text.includes(v2Marker)) {
    format = 'home_rule_v2';
    const markerIndex = text.indexOf(v2Marker);
    label = text.slice(0, markerIndex).trim();
    let payload = text.slice(markerIndex + v2Marker.length).trim();
    const wrapped = payload.match(/^base64:\/\/@([^@]+)@([A-Za-z0-9+/_=\-\s]+)/);
    if (wrapped) {
      shareName = wrapped[1].trim();
      payload = wrapped[2];
    }
    jsonText = decodeHomeRuleV2Payload(payload);
  } else if (text.includes(plainMarker)) {
    format = 'home_rule';
    const markerIndex = text.indexOf(plainMarker);
    label = text.slice(0, markerIndex).trim();
    jsonText = extractJsonObject(text.slice(markerIndex + plainMarker.length));
  } else {
    jsonText = extractJsonObject(text);
  }

  let rule;
  try {
    rule = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`海阔规则 JSON 解析失败: ${error.message}`);
  }
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error('海阔分享载荷不是规则对象');
  }

  const analysis = analyzeHikerRule(rule);
  return {
    format,
    label,
    shareName: shareName || String(rule.title || '').trim(),
    rule,
    ...analysis,
  };
}

export async function importHikerRule({
  text = '',
  key = '',
  url = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = defaultOptions.timeoutMs,
  maxBytes = defaultOptions.maxBytes,
} = {}) {
  const directText = String(text || '').trim();
  if (Buffer.byteLength(directText, 'utf8') > maxBytes) {
    throw new Error(`海阔分享文本超过 ${maxBytes} 字节`);
  }
  let reference = null;
  let content = directText;
  let download = null;

  if (url) reference = extractHikerCloudReference(url);
  if (!reference && key) {
    reference = { key: validateCloudKey(key), kind: 'explicit-key', original: String(key) };
  }
  if (!reference && directText && !looksLikeHikerRule(directText)) {
    reference = extractHikerCloudReference(directText);
  }

  if (reference) {
    download = await downloadHikerCloudRecord(reference, {
      fetchImpl,
      timeoutMs,
      maxBytes,
    });
    content = download.content;
  }
  if (!content) {
    throw new Error('需要 --clipboard、--text-file、--share-code、--key 或 --url');
  }

  const decoded = decodeHikerCloudRecord(content);
  const parsed = parseHikerShareText(decoded);
  return {
    ...parsed,
    source: download
      ? {
          kind: reference.kind,
          key: reference.key,
          url: download.url,
          attempts: download.attempts,
          storedBytes: Buffer.byteLength(content, 'utf8'),
          decodedBytes: Buffer.byteLength(decoded, 'utf8'),
        }
      : {
          kind: 'inline',
          storedBytes: Buffer.byteLength(content, 'utf8'),
          decodedBytes: Buffer.byteLength(decoded, 'utf8'),
        },
  };
}

export async function downloadHikerCloudRecord(reference, options = {}) {
  if (typeof options.fetchImpl !== 'function') throw new Error('当前 Node 环境不支持 fetch');
  const key = validateCloudKey(reference?.key);
  const timeoutMs = numberOrDefault(options.timeoutMs, defaultOptions.timeoutMs);
  const maxBytes = numberOrDefault(options.maxBytes, defaultOptions.maxBytes);
  const urls = buildCloudCandidateUrls(key, reference?.original);
  const attempts = [];

  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await options.fetchImpl(url, {
        headers: { 'User-Agent': 'Aibox-Skill/1.0' },
        signal: controller.signal,
      });
      const declaredLength = Number(response.headers?.get?.('content-length') || 0);
      if (declaredLength > maxBytes) {
        attempts.push({ url, status: response.status, error: `响应超过 ${maxBytes} 字节` });
        continue;
      }
      const content = await response.text();
      const bytes = Buffer.byteLength(content, 'utf8');
      attempts.push({ url, status: response.status, bytes });
      if (response.ok && content.trim()) {
        if (bytes > maxBytes) throw new Error(`云剪切板响应超过 ${maxBytes} 字节`);
        return { url, content: content.trim(), attempts };
      }
    } catch (error) {
      attempts.push({ url, error: error.name === 'AbortError' ? `请求超时 ${timeoutMs}ms` : error.message });
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`海阔云2回读失败: ${attempts.map((item) => `${item.url} ${item.error || `HTTP ${item.status}`}`).join('; ')}`);
}

export function saveImportedHikerRule({ rule, filePath, overwrite = false } = {}) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error('saveImportedHikerRule 需要规则对象');
  }
  const targetPath = path.resolve(String(filePath || ''));
  if (!filePath) throw new Error('saveImportedHikerRule 需要 filePath');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (fs.existsSync(targetPath) && !overwrite) throw new Error(`文件已存在: ${targetPath}`);

  const content = `${JSON.stringify(rule, null, 2)}\n`;
  const expectedHash = sha256(content);
  const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = fs.openSync(tempPath, 'wx');
    try {
      fs.writeFileSync(handle, content, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    const written = fs.readFileSync(tempPath, 'utf8');
    const actualHash = sha256(written);
    if (Buffer.byteLength(written, 'utf8') !== Buffer.byteLength(content, 'utf8') || actualHash !== expectedHash) {
      throw new Error(`海阔规则回读不一致: expected=${expectedHash} actual=${actualHash}`);
    }
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    throw error;
  }

  return {
    filePath: targetPath,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: expectedHash,
  };
}

function analyzeHikerRule(rule) {
  const warnings = [];
  let pageList = [];
  if (Array.isArray(rule.pageList)) {
    pageList = rule.pageList;
  } else if (typeof rule.pages === 'string' && rule.pages.trim()) {
    try {
      const parsed = JSON.parse(rule.pages);
      if (Array.isArray(parsed)) pageList = parsed;
      else warnings.push('pages 不是数组');
    } catch (error) {
      warnings.push(`pages JSON 解析失败: ${error.message}`);
    }
  }

  const dependencyNames = collectDependencies(rule, pageList);
  const pagePaths = new Set(pageList.map((item) => String(item?.path || '').trim()).filter(Boolean));
  const pageNames = new Set(pageList.map((item) => String(item?.name || '').trim()).filter(Boolean));
  const dependencies = dependencyNames.map((name) => {
    let kind = 'unresolved';
    let embedded = false;
    if (pagePaths.has(name) || pageNames.has(name)) {
      kind = 'embedded-page';
      embedded = true;
    } else if (/^hiker:\/\/assets\//i.test(name)) {
      kind = 'hiker-builtin-asset';
    } else if (/^https?:\/\//i.test(name)) {
      kind = 'remote-module';
    } else if (/^hiker:\/\/files\//i.test(name)) {
      kind = 'hiker-local-file';
    }
    return { name, kind, embedded };
  });
  const unresolved = dependencies.filter((item) => ['unresolved', 'hiker-local-file'].includes(item.kind));
  if (unresolved.length) warnings.push(`存在未随规则内嵌的依赖: ${unresolved.map((item) => item.name).join(', ')}`);

  return {
    summary: {
      title: String(rule.title || ''),
      type: String(rule.type || ''),
      group: String(rule.group || ''),
      author: String(rule.author || ''),
      version: rule.version ?? null,
      url: String(rule.url || ''),
      searchUrl: String(rule.search_url || ''),
      pageCount: pageList.length,
      hasPreRule: Boolean(rule.preRule),
      hasSearch: Boolean(rule.search_url || rule.searchFind),
      hasDetailRule: Boolean(rule.detail_find_rule || rule.sdetail_find_rule),
    },
    pages: pageList.map((item, index) => ({
      index,
      name: String(item?.name || ''),
      path: String(item?.path || ''),
      colType: String(item?.col_type || ''),
      ruleLength: typeof item?.rule === 'string' ? item.rule.length : 0,
    })),
    dependencies,
    warnings,
  };
}

function collectDependencies(rule, pageList) {
  const names = new Set();
  const patterns = [
    /\$\.require\(\s*['"]([^'"]+)['"]/g,
    /\brequirejs\(\s*['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]/g,
  ];
  const strings = [];
  collectStrings(rule, strings);
  collectStrings(pageList, strings);
  for (const value of strings) {
    if (value.startsWith('data:')) continue;
    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) names.add(match[1]);
    }
  }
  return [...names];
}

function collectStrings(value, output, seen = new WeakSet()) {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) collectStrings(item, output, seen);
}

function decodeHomeRuleV2Payload(input) {
  const token = String(input || '').trim().match(/^[A-Za-z0-9+/_=-]+/)?.[0] || '';
  const bytes = decodeBase64Bytes(token);
  if (!bytes) throw new Error('home_rule_v2 Base64 载荷无效');
  const decoded = stripBom(bytes.toString('utf8')).trim();
  const candidates = [decoded];
  try {
    const uriDecoded = decodeURIComponent(decoded);
    if (uriDecoded !== decoded) candidates.push(uriDecoded);
  } catch (_) {}
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch (_) {}
  }
  throw new Error('home_rule_v2 解码后不是有效 JSON');
}

function extractJsonObject(input) {
  const text = String(input || '').trim();
  const start = text.indexOf('{');
  if (start < 0) throw new Error('未找到海阔规则 JSON');
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error('海阔规则 JSON 不完整');
}

function buildCloudCandidateUrls(key, original = '') {
  const urls = [];
  const add = (value) => {
    if (value && !urls.includes(value)) urls.push(value);
  };
  const originalUrl = String(original || '').match(/https?:\/\/[^\s]+/i)?.[0];
  if (originalUrl) {
    try {
      const parsed = new URL(originalUrl);
      if (/^(?:api\.)?textdb\.online$/i.test(parsed.hostname)) {
        add(`${parsed.protocol}//${parsed.host}/${encodeURIComponent(key)}`);
      }
    } catch (_) {}
  }
  add(`https://api.textdb.online/${encodeURIComponent(key)}`);
  add(`https://textdb.online/${encodeURIComponent(key)}`);
  return urls;
}

function validateCloudKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) throw new Error(`云剪切板 key 无效: ${key}`);
  return key;
}

function decodeBase64Bytes(value) {
  const compact = String(value || '').replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/_=-]+$/.test(compact)) return null;
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  try {
    return Buffer.from(normalized + (padding ? '='.repeat(4 - padding) : ''), 'base64');
  } catch (_) {
    return null;
  }
}

function looksLikeHikerRule(value) {
  const text = String(value || '').trim();
  return text.includes('￥home_rule￥') || text.includes('￥home_rule_v2￥') || text.startsWith('{');
}

function stripBom(value) {
  return String(value || '').replace(/^\uFEFF/, '');
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function numberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
