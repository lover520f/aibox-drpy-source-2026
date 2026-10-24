// Kept self-contained in each distributable Skill (no cross-Skill imports).
export function checkToolResult(result) {
  if (!result || typeof result !== 'object') throw new Error('MCP result is not an object');
  if (result.isError === true) throw new Error('MCP isError=true; inspect the redacted tool result');
  let value = result.structuredContent;
  if (value == null) {
    const texts = (result.content || []).filter(x => x.type === 'text').map(x => x.text);
    try { value = JSON.parse(texts.join('\n')); }
    catch { throw new Error('MCP tool did not return structured JSON'); }
  }
  if (!value || typeof value !== 'object') throw new Error('MCP structured result missing');
  if (value.success === false || value.valid === false || value.ok === false) {
    throw new Error('MCP success=false / valid=false / ok=false; inspect validation diagnostics');
  }
  return value;
}

function validate(schema, value, name = 'arguments') {
  if (!schema) return;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
    for (const field of schema.required || []) if (!Object.hasOwn(value, field)) throw new Error(`Missing ${name}.${field}`);
    for (const [field, child] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, field)) validate(child, value[field], `${name}.${field}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
    value.forEach((x, i) => validate(schema.items, x, `${name}[${i}]`));
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  } else if (schema.type && typeof value !== schema.type) throw new Error(`${name} must be ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${name} is not in advertised enum`);
  if (typeof value === 'number' && ((schema.minimum != null && value < schema.minimum) || (schema.maximum != null && value > schema.maximum))) throw new Error(`${name} is out of bounds`);
  if (typeof value === 'string' && ((schema.minLength != null && value.length < schema.minLength) || (schema.maxLength != null && value.length > schema.maxLength))) throw new Error(`${name} has invalid length`);
}

export class McpClient {
  constructor({ url, token = '', timeout = 15000, protocolVersion = '2025-11-25', fetchImpl = fetch } = {}) {
    this.url = new URL(url);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password || this.url.search || this.url.hash) throw new Error('Use a plain MCP HTTP URL; credentials belong in environment');
    this.token = token; this.timeout = timeout; this.protocolVersion = protocolVersion; this.fetch = fetchImpl;
    this.sessionId = null; this.tools = new Map(); this.connected = false; this.id = 0;
  }
  async request(method, params = {}, notification = false) {
    const id = notification ? undefined : ++this.id;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': this.protocolVersion };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let response;
    try {
      response = await this.fetch(this.url, { method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
        signal: AbortSignal.timeout(this.timeout) });
    } catch { this.connected = false; throw new Error('MCP connection failed; App validation was not completed'); }
    if (!response.ok) {
      await response.body?.cancel(); this.connected = false;
      throw new Error(`MCP HTTP ${response.status}; reconnect and rediscover (workspace/upload IDs belong to the session)`);
    }
    const session = response.headers.get('mcp-session-id');
    if (session && this.sessionId && session !== this.sessionId) {
      await response.body?.cancel(); this.connected = false; throw new Error('MCP session changed; reopen workspace');
    }
    if (session) this.sessionId = session;
    if (notification) { await response.body?.cancel(); return; }
    let message;
    if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '', bytes = 0;
      try {
        while (!message) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 32 * 1024 * 1024) throw new Error('MCP response exceeds size limit');
          buffer += decoder.decode(chunk.value, { stream: true });
          buffer = buffer.replaceAll('\r\n', '\n');
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
            const data = block.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).replace(/^ /, '')).join('\n');
            if (!data) continue;
            const candidate = JSON.parse(data);
            if (candidate.id === id) { message = candidate; break; }
          }
        }
      } finally { await reader.cancel(); }
    } else {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 32 * 1024 * 1024) throw new Error('MCP response exceeds size limit');
      message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    if (!message || message.id !== id) throw new Error('MCP response ID mismatch/missing');
    if (message.error) throw new Error(`MCP JSON-RPC error ${message.error.code}; inspect server diagnostics`);
    return message.result;
  }
  async connect() {
    this.connected = false; this.sessionId = null; this.tools.clear();
    const init = await this.request('initialize', { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: { name: 'aibox-skill-tools', version: '1.0.0' } });
    if (init?.protocolVersion) this.protocolVersion = init.protocolVersion;
    // Streamable HTTP permits sessionless servers. AIBOX direct LAN mode can
    // use one owner connection without a returned transport session header.
    this.sessionMode = this.sessionId ? 'stateful' : 'sessionless';
    await this.request('notifications/initialized', {}, true);
    let cursor; const cursors = new Set();
    do {
      const list = await this.request('tools/list', cursor ? { cursor } : {});
      for (const tool of list.tools || []) this.tools.set(tool.name, tool);
      cursor = list.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('MCP tool pagination repeated a cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.connected = true;
    return [...this.tools.values()];
  }
  async call(name, args = {}) {
    if (!this.connected) throw new Error('MCP not connected; reconnect and rediscover');
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not advertised by current App: ${name}`);
    validate(tool.inputSchema, args);
    return checkToolResult(await this.request('tools/call', { name, arguments: args }));
  }
}
