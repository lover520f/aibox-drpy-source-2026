import { inflateRawSync } from 'node:zlib';

export function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')
    || /[\x00-\x1f:*?"<>|]/.test(value)
    || value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error(`Unsafe path: ${value}`);
  return value;
}

const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? (0xedb88320 ^ (n >>> 1)) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let n = 0xffffffff;
  for (const b of bytes) n = table[(n ^ b) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}

export function createZip(entries) {
  if (entries.length > 65534) throw new Error('ZIP64 is unsupported');
  const names = new Set(), locals = [], centrals = [];
  let offset = 0;
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    safePath(e.name);
    if (names.has(e.name.toLowerCase())) throw new Error(`Duplicate ZIP path: ${e.name}`);
    names.add(e.name.toLowerCase());
    const name = Buffer.from(e.name), bytes = Buffer.from(e.content), crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, bytes); centrals.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

export function readZip(bytes, { maxBytes = 256 * 1024 * 1024, maxFiles = 20000 } = {}) {
  const b = Buffer.from(bytes), names = new Set(), entries = [], spans = [];
  let end = b.length - 22;
  while (end >= Math.max(0, b.length - 65557) && b.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || end < b.length - 65557 || end + 22 + b.readUInt16LE(end + 20) !== b.length) throw new Error('Invalid ZIP header');
  const count = b.readUInt16LE(end + 10), start = b.readUInt32LE(end + 16), size = b.readUInt32LE(end + 12);
  if (b.readUInt16LE(end + 4) || b.readUInt16LE(end + 6) || count !== b.readUInt16LE(end + 8)
    || count === 65535 || count > maxFiles || start + size !== end) throw new Error('Unsupported ZIP layout/size');
  let pos = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || b.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid ZIP central header');
    const flags = b.readUInt16LE(pos + 8), method = b.readUInt16LE(pos + 10), crc = b.readUInt32LE(pos + 16);
    const packed = b.readUInt32LE(pos + 20), length = b.readUInt32LE(pos + 24), nl = b.readUInt16LE(pos + 28);
    const next = pos + 46 + nl + b.readUInt16LE(pos + 30) + b.readUInt16LE(pos + 32), local = b.readUInt32LE(pos + 42);
    if (next > end || flags & 1 || ![0, 8].includes(method) || b.readUInt16LE(pos + 34)) throw new Error('Unsupported ZIP encryption/header');
    if (((b.readUInt32LE(pos + 38) >>> 16) & 0xf000) === 0xa000) throw new Error('ZIP symlink rejected');
    const rawName = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(pos + 46, pos + 46 + nl));
    const directory = rawName.endsWith('/'), name = safePath(directory ? rawName.slice(0, -1) : rawName);
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate ZIP path: ${name}`);
    names.add(name.toLowerCase()); total += length;
    if (total > maxBytes || local + 30 > start || b.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP size/header invalid');
    const lnl = b.readUInt16LE(local + 26), data = local + 30 + lnl + b.readUInt16LE(local + 28), stop = data + packed;
    if (stop > start || b.readUInt16LE(local + 8) !== method || b.readUInt16LE(local + 6) !== flags
      || !b.subarray(local + 30, local + 30 + lnl).equals(Buffer.from(rawName))) throw new Error('ZIP local header mismatch');
    if (spans.some(([a, z]) => local < z && stop > a)) throw new Error('Overlapping ZIP entries');
    spans.push([local, stop]);
    const content = method === 0 ? b.subarray(data, stop) : inflateRawSync(b.subarray(data, stop), { maxOutputLength: Math.max(1, length) });
    if (content.length !== length || crc32(content) !== crc) throw new Error('ZIP CRC/size mismatch');
    if (!directory) entries.push({ name, content });
    pos = next;
  }
  if (pos !== end) throw new Error('ZIP central size mismatch');
  return entries;
}
