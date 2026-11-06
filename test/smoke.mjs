// Smoke test: drives the real helper over MCP stdio with a simulated plugin, and runs
// plugin/code.js against a stub figma object. Does not touch Figma or your real token.
// Run: node test/smoke.mjs

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'type-relay-test-'));
const PORT = 47899;
const env = { ...process.env, TYPE_RELAY_PORT: String(PORT), TYPE_RELAY_HOME: HOME };
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// Minimal MCP client over the helper's stdio.
function startMcp() {
  const child = spawn(process.execPath, [path.join(ROOT, 'type-relay.mjs'), 'mcp'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let nextId = 1;
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const tool = async (name, args = {}) => {
    const { result } = await request('tools/call', { name, arguments: args });
    return result;
  };
  return { child, request, tool, stop: () => child.kill() };
}

// Simulated plugin: same HTTP protocol as ui.html.
function fakePlugin(name, token, handler) {
  const headers = { 'content-type': 'application/json', 'x-relay-token': token };
  const clientId = `fake-${name}`;
  let running = true;
  const controller = new AbortController();
  (async () => {
    while (running) {
      try {
        const res = await fetch(`${BASE}/poll`, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({ clientId, file: { name, key: `key-${name}` }, page: 'Page 1', user: 'Test' }),
        });
        const { command } = await res.json();
        if (!command) continue;
        let body;
        try {
          body = { commandId: command.id, ok: true, result: await handler(command) };
        } catch (err) {
          body = { commandId: command.id, ok: false, error: err.message };
        }
        await fetch(`${BASE}/result`, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch {
        if (running) await sleep(50);
      }
    }
  })();
  return {
    stop() {
      running = false;
      controller.abort();
    },
  };
}

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function handler(command) {
  if (command.op === 'run') return { result: `ran: ${command.args.code}`, logs: [] };
  if (command.op === 'fonts') {
    return [
      { family: 'Effra', styles: ['Regular', 'Bold'] },
      { family: 'Inter', styles: ['Regular'] },
    ];
  }
  if (command.op === 'export') return { id: '1:2', name: 'Frame / One', width: 1, height: 1, scale: 1, base64: PNG_1PX };
  throw new Error('unexpected op');
}

const waitForClients = async (mcp, n) => {
  for (let i = 0; i < 100; i++) {
    const status = JSON.parse((await mcp.tool('type_status')).content[0].text);
    if (status.clients.length === n) return status;
    await sleep(50);
  }
  throw new Error(`never reached ${n} clients`);
};

let first;
let second;
let pluginA;
let pluginB;
try {
  fs.mkdirSync(HOME, { recursive: true });
  const tokenCheck = spawnSync(process.execPath, [path.join(ROOT, 'type-relay.mjs'), 'status'], { env, encoding: 'utf8' });
  await test('CLI without a token explains what to do', () => {
    assert.equal(tokenCheck.status, 1);
    assert.match(tokenCheck.stderr, /type-relay\.mjs setup/);
  });

  first = startMcp();

  await test('MCP handshake and tool list', async () => {
    const init = await first.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'type-relay');
    const { result } = await first.request('tools/list');
    assert.deepEqual(result.tools.map((t) => t.name), [
      'type_status',
      'type_list_fonts',
      'type_audit',
      'type_preview',
      'type_swap',
      'type_check',
      'type_run',
      'type_screenshot',
    ]);
  });

  await test('unknown method returns a JSON-RPC error', async () => {
    const reply = await first.request('nope/nope');
    assert.equal(reply.error.code, -32601);
  });

  const token = fs.readFileSync(path.join(HOME, 'token'), 'utf8').trim();

  await test('token file is private', () => {
    assert.equal(fs.statSync(path.join(HOME, 'token')).mode & 0o777, 0o600);
  });

  await test('hub rejects a missing or wrong token', async () => {
    assert.equal((await fetch(`${BASE}/status`)).status, 401);
    assert.equal((await fetch(`${BASE}/status`, { headers: { 'x-relay-token': 'x'.repeat(48) } })).status, 401);
    const res = await fetch(`${BASE}/poll`, { method: 'POST', headers: { 'x-relay-token': 'wrong' }, body: '{}' });
    assert.equal(res.status, 401);
  });

  await test('preflight allows a plugin iframe', async () => {
    const res = await fetch(`${BASE}/poll`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
  });

  await test('first poll from a new plugin is answered at once', async () => {
    const started = Date.now();
    const res = await fetch(`${BASE}/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relay-token': token },
      body: JSON.stringify({ clientId: 'quick', file: { name: 'Quick' }, page: 'P' }),
    });
    assert.deepEqual(await res.json(), {});
    assert.ok(Date.now() - started < 1000);
    // Close it so later tests start with no plugin: one abandoned poll, then the grace period.
    const controller = new AbortController();
    fetch(`${BASE}/poll`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-relay-token': token },
      body: JSON.stringify({ clientId: 'quick', file: { name: 'Quick' }, page: 'P' }),
    }).catch(() => {});
    await sleep(100);
    controller.abort();
    await sleep(3200);
    await waitForClients(first, 0);
  });

  await test('ping keeps a busy plugin known, and commands carry their timeout', async () => {
    const headers = { 'content-type': 'application/json', 'x-relay-token': token };
    const res = await fetch(`${BASE}/ping`, { method: 'POST', headers, body: JSON.stringify({ clientId: 'nobody' }) });
    assert.deepEqual(await res.json(), { ok: true });
    const seen = [];
    const plugin = fakePlugin('Timeouts', token, (command) => {
      seen.push(command.timeoutMs);
      return { result: 1, logs: [] };
    });
    await waitForClients(first, 1);
    await first.tool('type_run', { code: 'x', timeout_ms: 1234 });
    assert.deepEqual(seen, [1234]);
    await sleep(100); // Let it start its next poll: stopping between polls leaves it known for 40 s.
    plugin.stop();
    await sleep(3200);
    await waitForClients(first, 0);
  });

  await test('no plugin: tools say how to start it', async () => {
    const result = await first.tool('type_run', { code: 'return 1' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Plugins > Development > Type Relay/);
    assert.match((await first.tool('type_status')).content[0].text, /Type Relay/);
  });

  pluginA = fakePlugin('Sample File', token, handler);
  await waitForClients(first, 1);

  await test('run reaches the plugin and returns its result', async () => {
    const result = await first.tool('type_run', { code: 'return 1' });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).result, 'ran: return 1');
  });

  await test('run requires code', async () => {
    const result = await first.tool('type_run', {});
    assert.equal(result.isError, true);
  });

  await test('font list: names without a query, styles with one', async () => {
    const all = JSON.parse((await first.tool('type_list_fonts')).content[0].text);
    assert.deepEqual(all, { count: 2, families: ['Effra', 'Inter'] });
    const one = JSON.parse((await first.tool('type_list_fonts', { query: 'eff' })).content[0].text);
    assert.deepEqual(one, { count: 1, fonts: [{ family: 'Effra', styles: ['Regular', 'Bold'] }] });
  });

  await test('screenshot saves a PNG and returns it inline', async () => {
    const result = await first.tool('type_screenshot', { node_id: '1:2' });
    const summary = JSON.parse(result.content[0].text);
    assert.equal(result.content[1].type, 'image');
    assert.ok(path.basename(summary.file).endsWith('-Frame-One.png'), summary.file);
    assert.deepEqual(fs.readFileSync(summary.file).subarray(1, 4).toString(), 'PNG');
  });

  await test('concurrent runs all complete', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => first.tool('type_run', { code: `return ${n}` })));
    results.forEach((r, i) => assert.equal(JSON.parse(r.content[0].text).result, `ran: return ${i + 1}`));
  });

  await test('plugin errors come back as tool errors', async () => {
    const result = await first.tool('type_screenshot', {});
    assert.equal(result.isError, undefined); // handler above succeeds with no node id
    const failing = fakePlugin('Failing', token, () => {
      throw new Error('boom');
    });
    await waitForClients(first, 2);
    const failed = await first.tool('type_run', { code: 'x', target: 'failing' });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /boom/);
    failing.stop();
    for (let i = 0; i < 100; i++) {
      const hit = await first.tool('type_run', { code: 'x', target: 'failing' });
      if (/No open file matches/.test(hit.content[0].text)) break;
      await sleep(50);
    }
  });

  await test('closed plugin disappears within the grace period', async () => {
    await sleep(3200);
    await waitForClients(first, 1);
  });

  pluginB = fakePlugin('Another File', token, handler);
  await waitForClients(first, 2);

  await test('two open files: refuses to guess, target chooses', async () => {
    const ambiguous = await first.tool('type_run', { code: 'return 1' });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0].text, /Pass target/);
    const named = await first.tool('type_run', { code: 'return 1', target: 'sample' });
    assert.equal(named.isError, undefined);
    const byKey = await first.tool('type_run', { code: 'return 1', target: 'key-Another File' });
    assert.equal(byKey.isError, undefined);
    const none = await first.tool('type_run', { code: 'return 1', target: 'nothing' });
    assert.match(none.content[0].text, /No open file matches/);
  });


  // ---- font tools through the helper, with a simulated plugin

  const scanResult = (mapping = [{ from: 'SemiBold', to: 'Bold', kind: 'nearest', note: null, segments: 2, layers: 2, chars: { A: { layers: 2, sample: '1:1' }, '→': { layers: 1, sample: '1:2' } } }]) => ({
    file: 'Fonts File',
    scope: { type: 'page', pageId: '0:1', exclude: [] },
    label: 'page "One"',
    textLayers: 3,
    matchedLayers: 2,
    matchedSegments: 2,
    fromAvailable: true,
    target: { family: 'Helvetica', styles: ['Regular', 'Bold'] },
    mapping,
    styles: [{ name: 'Body', action: 'clone', segmentsInScope: 2, segmentsOutside: 1, remote: false, published: false }],
    componentsOutside: [],
  });
  const emptyCheck = (extra = {}) => ({ file: 'Fonts File', label: 'page "One"', textLayers: 3, clipped: [], overflow: [], fixedBoxes: 0, frames: [{ id: 'f', name: 'Frame', x: 0, y: 0, w: 10, h: 10 }], overlaps: [], ...extra });
  let nextScan = scanResult();
  let checks = [emptyCheck(), emptyCheck({ clipped: [{ id: 't', px: 9, frame: 'Frame', text: 'Long' }], frames: [{ id: 'f', name: 'Frame', x: 0, y: 0, w: 10, h: 30 }] })];
  let swapArgs = null;
  const fontPlugin = fakePlugin('Fonts File', token, (command) => {
    if (command.op === 'fontScan') return nextScan;
    if (command.op === 'fontCheck') return checks.shift() ?? emptyCheck();
    if (command.op === 'fontAudit') return { file: 'Fonts File', scope: command.args.scope, fonts: [] };
    if (command.op === 'fontSwap') {
      swapArgs = command.args;
      return { restorePoint: { name: 'Before', id: '9' }, stats: {}, errorCount: 0, errors: [], leftoverCount: 0, leftover: [], outside: [{ page: 'Two', layers: 1, changed: false }], ms: 1 };
    }
    return handler(command);
  });
  await waitForClients(first, 3);
  const callJson = async (name, args) => {
    const r = await first.tool(name, { target: 'fonts file', ...args });
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };

  await test('audit defaults to the current page', async () => {
    const out = await callJson('type_audit', {});
    assert.equal(out.scope.type, 'page');
  });

  await test('preview needs a font and a scope', async () => {
    await assert.rejects(callJson('type_preview', { from: 'A', scope: 'page' }), /from and to/);
    await assert.rejects(callJson('type_preview', { from: 'A', to: 'B' }), /Say what to change/);
    await assert.rejects(callJson('type_preview', { from: 'A', to: 'A', scope: 'page' }), /same font/);
  });

  let previewOut;
  await test('preview reports weights and keeps what the new font lacks', async () => {
    previewOut = await callJson('type_preview', { from: 'Menlo', to: 'Helvetica', scope: 'page' });
    assert.match(previewOut.preview_id, /^[0-9a-f]{8}$/);
    assert.ok(previewOut.warnings.some((w) => /SemiBold isn't in the new family, so 2 layers become Bold/.test(w)));
    assert.equal(previewOut.weights[0].chars, undefined);
    if (process.platform === 'darwin') {
      assert.equal(previewOut.missingCharacters.checked, true);
      assert.equal(previewOut.missingCharacters.list[0].char, '→');
      assert.equal(previewOut.keptInOldFont, '→');
    } else {
      assert.equal(previewOut.missingCharacters.checked, false);
    }
  });

  await test('preview says so when a font file can\'t be read', async () => {
    const out = await callJson('type_preview', { from: 'Helvetica Neue', to: 'Hosted By Figma Only', scope: 'page', keep_characters: '✓' });
    assert.equal(out.missingCharacters.checked, false);
    assert.equal(out.keptInOldFont, '✓');
    assert.ok(out.warnings.some((w) => /weren't checked/.test(w)));
  });

  await test('swap applies the preview and reports what moved', async () => {
    const out = await callJson('type_swap', { preview_id: previewOut.preview_id });
    assert.equal(swapArgs.from, 'Menlo');
    assert.equal(swapArgs.expectedFile, 'Fonts File');
    assert.deepEqual(swapArgs.scope, { type: 'page', pageId: '0:1', exclude: [] });
    assert.equal(out.layoutChanges.newlyCutOff.count, 1);
    assert.equal(out.layoutChanges.framesResized.items[0].heightChange, 20);
    assert.match(out.verdict, /Clean/);
    assert.match(out.snapshot_id, /^[0-9a-f]{8}$/);
  });

  await test('swap refuses a stale preview, a bad id and no id', async () => {
    nextScan = scanResult([{ from: 'SemiBold', to: 'Regular', kind: 'nearest', note: null, segments: 2, layers: 2, chars: { A: { layers: 2, sample: '1:1' } } }]);
    swapArgs = null;
    await assert.rejects(callJson('type_swap', { preview_id: previewOut.preview_id }), /Run type_preview again/);
    assert.equal(swapArgs, null);
    await assert.rejects(callJson('type_swap', { preview_id: '../../etc' }), /Not a valid id/);
    await assert.rejects(callJson('type_swap', { preview_id: 'aaaaaaaa' }), /Nothing saved/);
    await assert.rejects(callJson('type_swap', {}), /Run type_preview first/);
    nextScan = scanResult();
  });

  await test('check compares against an earlier snapshot', async () => {
    checks = [emptyCheck()];
    const a = await callJson('type_check', {});
    assert.equal(a.cutOff.count, 0);
    checks = [emptyCheck({ clipped: [{ id: 't', px: 5, frame: 'F', text: 'x' }], overlaps: [{ a: '1', b: '2', names: 'A / B' }] })];
    const b = await callJson('type_check', { compare_to: a.snapshot_id });
    assert.equal(b.comparedTo.newlyCutOff.count, 1);
    assert.equal(b.comparedTo.newOverlaps.count, 1);
    assert.equal(b.comparedTo.framesResized.count, 0);
  });

  await sleep(100);
  fontPlugin.stop();
  await sleep(3200);
  await waitForClients(first, 2);

  second = startMcp();
  await second.request('initialize', { protocolVersion: '2025-06-18' });
  await sleep(200);

  await test('second session forwards to the first hub', async () => {
    const status = JSON.parse((await second.tool('type_status')).content[0].text);
    assert.equal(status.pid, first.child.pid);
    const result = await second.tool('type_run', { code: 'return 2', target: 'sample' });
    assert.equal(JSON.parse(result.content[0].text).result, 'ran: return 2');
  });

  await test('second session takes over when the hub exits, plugins reconnect', async () => {
    first.child.kill();
    await new Promise((r) => first.child.once('exit', r));
    await sleep(100);
    const status = await waitForClients(second, 2);
    assert.equal(status.pid, second.child.pid);
    const result = await second.tool('type_run', { code: 'return 3', target: 'sample' });
    assert.equal(JSON.parse(result.content[0].text).result, 'ran: return 3');
  });

  pluginA.stop();
  pluginB.stop();

  // ---- plugin/code.js against a stub figma

  const posted = [];
  const nodes = { '1:2': { id: '1:2', name: 'Frame', type: 'FRAME', parent: null, width: 10, height: 20, exportAsync: async () => new Uint8Array([1, 2]) } };
  let undoCount = 0;
  const figma = {
    mixed: Symbol('mixed'),
    root: { name: 'My File' },
    currentPage: { name: 'Page 1', selection: [] },
    get currentUser() {
      throw new Error('needs the currentuser permission');
    },
    get fileKey() {
      throw new Error('private API');
    },
    showUI() {},
    on() {},
    commitUndo: () => undoCount++,
    ui: { postMessage: (m) => posted.push(m), onmessage: null },
    getNodeByIdAsync: async (id) => nodes[id] ?? null,
    base64Encode: () => 'QUI=',
    listAvailableFontsAsync: async () => [
      { fontName: { family: 'Inter', style: 'Bold' } },
      { fontName: { family: 'Effra', style: 'Regular' } },
      { fontName: { family: 'Inter', style: 'Regular' } },
    ],
  };
  // eval inside the context so the plugin's (0, eval) resolves there.
  const context = vm.createContext({ figma, __html__: '', Uint8Array, Object, SyntaxError, JSON, Error, String, Number, Map, Set, Array, Math, Promise, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'plugin', 'code.js'), 'utf8'), context);
  const command = async (op, args) => {
    posted.length = 0;
    await figma.ui.onmessage({ type: 'command', command: { id: 'c1', op, args } });
    return posted[0];
  };

  await test('plugin: ready sends file info when fileKey and currentUser are blocked', async () => {
    await figma.ui.onmessage({ type: 'ready' });
    assert.deepEqual(JSON.parse(JSON.stringify(posted[0])), {
      type: 'info',
      info: { file: { name: 'My File', key: null }, page: 'Page 1', user: null },
    });
  });

  await test('plugin: run returns plain JSON, logs, one undo step', async () => {
    const before = undoCount;
    const reply = await command('run', {
      code: `console.log('hi', {a: 1}); const n = await figma.getNodeByIdAsync('1:2'); return {n, m: figma.mixed, f() {}, b: new Uint8Array(3)} // comment`,
    });
    assert.equal(reply.ok, true, reply.error);
    assert.deepEqual(JSON.parse(JSON.stringify(reply.result)), {
      result: { n: { id: '1:2', type: 'FRAME', name: 'Frame' }, m: 'figma.mixed', b: { bytes: 3 } },
      logs: ['hi {"a":1}'],
    });
    assert.equal(undoCount, before + 1);
  });

  await test('plugin: undefined result and script errors', async () => {
    assert.equal((await command('run', { code: 'const a = 1;' })).result.result, null);
    const thrown = await command('run', { code: `console.log('before'); throw new Error('nope')` });
    assert.equal(thrown.ok, false);
    assert.match(thrown.error, /nope/);
    assert.match(thrown.error, /before/);
    const syntax = await command('run', { code: 'this is not js' });
    assert.equal(syntax.ok, false);
  });

  await test('plugin: fonts grouped and sorted', async () => {
    const reply = await command('fonts', {});
    assert.deepEqual(JSON.parse(JSON.stringify(reply.result)), [
      { family: 'Effra', styles: ['Regular'] },
      { family: 'Inter', styles: ['Bold', 'Regular'] },
    ]);
  });

  await test('plugin: export by id, and clear errors', async () => {
    const reply = await command('export', { nodeId: '1:2', scale: 2 });
    assert.equal(reply.result.base64, 'QUI=');
    assert.equal(reply.result.scale, 2);
    assert.match((await command('export', {})).error, /Nothing selected/);
    assert.match((await command('export', { nodeId: '9:9' })).error, /Node not found/);
    assert.match((await command('nope', {})).error, /Unknown operation/);
  });


  // ---- plugin font tools against a small model of a Figma file

  function buildFile() {
    const calls = [];
    const loadedFonts = new Set();
    let nextId = 100;
    const sized = { fontSize: 14, letterSpacing: { unit: 'PERCENT', value: 0 }, lineHeight: { unit: 'AUTO' }, textCase: 'ORIGINAL', textDecoration: 'NONE' };
    const styles = {};
    const addStyle = (id, name, font, published = false) =>
      (styles[id] = {
        id, type: 'TEXT', name, remote: false, description: '', ...sized, _font: font,
        getPublishStatusAsync: async () => (published ? 'CURRENT' : 'UNPUBLISHED'),
        get fontName() { return this._font; },
        set fontName(f) {
          calls.push('edit:' + this.name);
          this._font = f;
          for (const t of allText()) for (const r of t.runs) if (r.textStyleId === id) r.fontName = f;
        },
      });
    addStyle('S:shared', 'Shared', { family: 'Old', style: 'Regular' });
    addStyle('S:only', 'Only', { family: 'Old', style: 'SemiBold' });
    addStyle('S:lib', 'Library', { family: 'Old', style: 'Regular' }, true);

    function text(id, name, characters, run, parent) {
      const node = {
        id, name, type: 'TEXT', parent, visible: true, characters, width: 10, height: 10, textAutoResize: 'HEIGHT', hasMissingFont: false,
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        runs: [{ start: 0, end: characters.length, ...sized, textStyleId: '', fontName: { family: 'Old', style: 'Regular' }, ...run }],
        inherits: null,
        ownRuns() {
          if (this.inherits) { this.runs = this.inherits.runs.map((r) => ({ ...r })); }
          return this.runs;
        },
        split(start, end) {
          const out = [];
          for (const r of this.ownRuns()) {
            for (const [a, b] of [[r.start, Math.min(r.end, start)], [Math.max(r.start, start), Math.min(r.end, end)], [Math.max(r.start, end), r.end]]) {
              if (b > a) out.push({ ...r, start: a, end: b });
            }
          }
          this.runs = out;
        },
        getRangeParagraphSpacing() { return this.paragraphSpacing || 0; },
        setRangeParagraphSpacing(start, end, value) { this.paragraphSpacing = value; },
        getRangeParagraphIndent() { return 0; },
        setRangeParagraphIndent() {},
        getRangeListSpacing() { return 0; },
        setRangeListSpacing() {},
        getRangeAllFontNames(start, end) {
          return this.ownRuns().filter((r) => r.start < end && r.end > start).map((r) => r.fontName);
        },
        set(start, end, patch) {
          // Real Figma refuses the write if any font on the layer isn't loaded yet.
          for (const r of this.ownRuns()) {
            if (!loadedFonts.has(r.fontName.family + '/' + r.fontName.style) && r.fontName.style !== 'Gone') throw new Error('Cannot write to node with unloaded font');
          }
          this.split(start, end);
          this.inherits = null;
          for (const r of this.runs) if (r.start >= start && r.end <= end) Object.assign(r, patch);
        },
        getStyledTextSegments(fields) {
          const segs = [];
          for (const r of this.ownRuns()) {
            const last = segs[segs.length - 1];
            if (last && fields.every((f) => JSON.stringify(last[f]) === JSON.stringify(r[f]))) last.end = r.end;
            else {
              const seg = { start: r.start, end: r.end };
              for (const f of fields) seg[f] = r[f];
              segs.push(seg);
            }
          }
          for (const seg of segs) seg.characters = this.characters.slice(seg.start, seg.end);
          return segs;
        },
        get fontName() { return this.ownRuns()[0].fontName; },
        set fontName(fontName) { calls.push('font:' + id); this.ownRuns()[0].fontName = fontName; this.ownRuns()[0].textStyleId = ''; },
        get textStyleId() { return this.ownRuns()[0].textStyleId; },
        async setTextStyleIdAsync(styleId) { Object.assign(this.ownRuns()[0], { textStyleId: styleId, fontName: styles[styleId].fontName }); },
        getRangeFontName(start, end) {
          const fonts = this.ownRuns().filter((r) => r.start < end && r.end > start).map((r) => r.fontName);
          return fonts.every((f) => JSON.stringify(f) === JSON.stringify(fonts[0])) ? fonts[0] : figmaFonts.mixed;
        },
        setRangeFontName(start, end, fontName) {
          calls.push('font:' + id);
          this.set(start, end, { fontName, textStyleId: '' });
        },
        async setRangeTextStyleIdAsync(start, end, styleId) {
          const st = styles[styleId];
          this.set(start, end, { textStyleId: styleId, fontName: st.fontName, fontSize: st.fontSize, letterSpacing: st.letterSpacing, lineHeight: st.lineHeight, textCase: st.textCase, textDecoration: st.textDecoration });
        },
        setRangeFontSize(start, end, fontSize) { this.set(start, end, { fontSize }); },
        setRangeLetterSpacing(start, end, letterSpacing) { this.set(start, end, { letterSpacing }); },
        setRangeLineHeight(start, end, lineHeight) { this.set(start, end, { lineHeight }); },
        setRangeTextCase(start, end, textCase) { this.set(start, end, { textCase }); },
        setRangeTextDecoration(start, end, textDecoration) { this.set(start, end, { textDecoration }); },
      };
      return node;
    }
    const container = (id, type, name, parent, extra = {}) => {
      const c = {
        id, type, name, parent, children: [], visible: true, clipsContent: false,
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        findAllWithCriteria() {
          const out = [];
          const walk = (n) => (n.children || []).forEach((k) => { if (k.type === 'TEXT') out.push(k); walk(k); });
          walk(this);
          return out;
        },
        findOne(fn) { return this.findAllWithCriteria().find(fn) || null; },
        ...extra,
      };
      if (parent) parent.children.push(c);
      return c;
    };
    const doc = { id: '0:0', type: 'DOCUMENT', name: 'Doc', children: [] };
    const one = container('0:1', 'PAGE', 'One', null, { parent: doc, loadAsync: async () => {} });
    const two = container('0:2', 'PAGE', 'Two', null, { parent: doc, loadAsync: async () => {} });
    doc.children.push(one, two);
    const frame = container('1:1', 'FRAME', 'Card', one, { clipsContent: true });
    const main = container('1:2', 'COMPONENT', 'Button', one);
    main.getInstancesAsync = async () => [instance, outsideInstance];
    const instance = container('1:3', 'INSTANCE', 'Button', frame);
    const outsideInstance = container('2:2', 'INSTANCE', 'Button', two);
    const add = (parent, ...args) => { const t = text(...args, parent); parent.children.push(t); return t; };
    const nodes = {};
    nodes.hard = add(frame, '1:10', 'Hard', 'Next → page', { fontName: { family: 'Old', style: 'SemiBold' } });
    nodes.shared = add(frame, '1:11', 'Shared use', 'Shared text', { textStyleId: 'S:shared' });
    nodes.only = add(frame, '1:12', 'Only use', 'Only ✓', { textStyleId: 'S:only', fontName: { family: 'Old', style: 'SemiBold' } });
    nodes.sized = add(frame, '1:13', 'Sized', 'Big shared', { textStyleId: 'S:shared', fontSize: 40 });
    nodes.lib = add(frame, '1:14', 'Published', 'Library text', { textStyleId: 'S:lib' });
    nodes.symbolOnly = add(frame, '1:15', 'Arrow', '→', {});
    nodes.other = add(frame, '1:16', 'Other', 'Other font', { fontName: { family: 'Unrelated', style: 'Regular' } });
    nodes.main = add(main, '1:20', 'Label', 'Click', {});
    nodes.inst = add(instance, 'I1:3;1:20', 'Label', 'Click', {});
    nodes.inst.inherits = nodes.main;
    nodes.outInst = add(outsideInstance, 'I2:2;1:20', 'Label', 'Click', {});
    nodes.outInst.inherits = nodes.main;
    nodes.outside = add(two, '2:10', 'Elsewhere', 'Elsewhere', { textStyleId: 'S:shared' });
    nodes.excluded = add(frame, '1:17', 'Trial', 'Leave me', {});
    nodes.arrowLinked = add(frame, '1:18', 'Linked arrow', 'Go → on', { textStyleId: 'S:shared' });
    nodes.empty = add(frame, '1:19', 'Empty', '', { textStyleId: 'S:shared' });
    nodes.emptyHard = add(frame, '1:21', 'Empty hard', '', { fontName: { family: 'Old', style: 'SemiBold' } });
    nodes.tokened = add(frame, '1:22', 'Token', 'From a variable', { boundVariables: { fontFamily: { type: 'VARIABLE_ALIAS', id: 'V:family' } } });
    nodes.hard.absoluteBoundingBox = { x: 0, y: 0, width: 150, height: 10 };
    nodes.mixedFonts = add(frame, '1:23', 'Two fonts', 'Other then old', {});
    nodes.mixedFonts.runs = [
      { ...nodes.mixedFonts.runs[0], end: 5, fontName: { family: 'Unrelated', style: 'Regular' } },
      { ...nodes.mixedFonts.runs[0], start: 5 },
    ];
    const allText = () => Object.values(nodes);
    const byId = new Map();
    const index = (n) => { byId.set(n.id, n); (n.children || []).forEach(index); };
    index(doc);
    const figmaFonts = {
      mixed: Symbol('mixed'),
      root: doc,
      currentPage: one,
      commitUndo() { calls.push('undo'); },
      variables: { getVariableByIdAsync: async (id) => ({ id, name: 'font/family' }) },
      loadAllPagesAsync: async () => {},
      loadFontAsync: async (f) => {
        if (f.family === 'Old' && f.style === 'Gone') throw new Error('no font');
        loadedFonts.add(f.family + '/' + f.style);
      },
      getNodeByIdAsync: async (id) => byId.get(id) || null,
      getStyleByIdAsync: async (id) => styles[id] || null,
      getLocalTextStylesAsync: async () => Object.values(styles),
      saveVersionHistoryAsync: async (name) => { calls.push('version:' + name); return { id: 'v1' }; },
      createTextStyle() {
        const id = 'S:new' + nextId++;
        return addStyle(id, '', null);
      },
      listAvailableFontsAsync: async () =>
        ['Regular', 'Medium', 'Bold', 'Bold Italic'].map((style) => ({ fontName: { family: 'New', style } }))
          .concat(['Regular', 'SemiBold'].map((style) => ({ fontName: { family: 'Old', style } })))
          .concat([{ fontName: { family: 'Unrelated', style: 'Regular' } }]),
    };
    return { figmaFonts, nodes, styles, calls };
  }

  const fontsContext = (fileFigma) => {
    const uiPosted = [];
    const stub = Object.assign(fileFigma, {
      showUI() {},
      on() {},
      ui: { postMessage: (m) => uiPosted.push(m), onmessage: null },
    });
    const ctx = vm.createContext({ figma: stub, __html__: '', Uint8Array, Object, SyntaxError, JSON, Error, String, Number, Map, Set, Array, Math, Promise, setTimeout, Symbol });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'plugin', 'code.js'), 'utf8'), ctx);
    return async (op, args) => {
      uiPosted.length = 0;
      await stub.ui.onmessage({ type: 'command', command: { id: 'c', op, args } });
      const reply = uiPosted[0];
      if (!reply.ok) throw new Error(reply.error);
      return JSON.parse(JSON.stringify(reply.result));
    };
  };
  const pageScope = { type: 'page', pageId: '0:1', exclude: ['1:17'] };

  await test('fonts: audit counts families and flags fonts Figma lacks', async () => {
    const file = buildFile();
    file.nodes.other.runs[0].fontName = { family: 'Vanished', style: 'Regular' };
    const send = fontsContext(file.figmaFonts);
    const out = await send('fontAudit', { scope: { type: 'page', pageId: '0:1', exclude: [] } });
    const old = out.fonts.find((f) => f.family === 'Old');
    assert.ok(old.layers >= 8);
    assert.ok(old.segmentsLinkedToStyles >= 3);
    assert.deepEqual(out.fonts.find((f) => f.family === 'Vanished').missing, ['Regular']);
  });

  await test('fonts: scan maps weights and decides copy or edit per text style', async () => {
    const send = fontsContext(buildFile().figmaFonts);
    const out = await send('fontScan', { from: 'Old', to: 'New', scope: pageScope });
    const semi = out.mapping.find((m) => m.from === 'SemiBold');
    assert.equal(semi.to, 'Bold');
    assert.equal(semi.kind, 'nearest');
    assert.ok(semi.chars['→']);
    const action = (name) => out.styles.find((s) => s.name === name).action;
    assert.equal(action('Shared'), 'clone'); // used on page Two
    assert.equal(action('Only'), 'edit');
    assert.equal(action('Library'), 'clone'); // published
    assert.deepEqual(out.componentsOutside.map((c) => c.instancesOutside), [1]);
  });

  await test('fonts: scan rejects an unavailable target and suggests similar names', async () => {
    const send = fontsContext(buildFile().figmaFonts);
    await assert.rejects(send('fontScan', { from: 'Old', to: 'Newish', scope: pageScope }), /can't see a font called "Newish".*New/);
    await assert.rejects(send('fontScan', { from: 'Old', to: 'New', styleMap: { Regular: 'Nope' }, scope: pageScope }), /no style "Nope"/);
  });

  await test('fonts: swap changes the scope only, and keeps symbols, overrides and styles', async () => {
    const file = buildFile();
    file.nodes.only.paragraphSpacing = 6;
    const send = fontsContext(file.figmaFonts);
    const out = await send('fontSwap', { from: 'Old', to: 'New', scope: pageScope, keep: '→✓' });
    const { nodes, styles, calls } = file;
    assert.equal(out.errorCount, 0, JSON.stringify(out.errors));
    const fontsOf = (n) => n.getStyledTextSegments(['fontName']).map((s) => `${s.characters}:${s.fontName.family}/${s.fontName.style}`);

    assert.equal(calls[0], 'version:Before Type Relay: Old to New');
    assert.equal(out.restorePoint.id, 'v1');
    assert.equal(calls[calls.length - 1], 'undo');
    assert.deepEqual(fontsOf(nodes.hard), ['Next :New/Bold', '→:Old/SemiBold', ' page:New/Bold']);

    const clone = Object.values(styles).find((s) => s.name === 'New/Shared');
    assert.equal(clone.fontName.family, 'New');
    assert.equal(nodes.shared.runs[0].textStyleId, clone.id);
    assert.equal(styles['S:shared'].fontName.family, 'Old');
    assert.ok(Object.values(styles).some((s) => s.name === 'New/Library'));

    assert.equal(styles['S:only'].fontName.family, 'New');
    assert.equal(styles['S:only'].fontName.style, 'Bold');
    assert.deepEqual(fontsOf(nodes.only), ['Only :New/Bold', '✓:Old/SemiBold']);
    assert.equal(nodes.only.paragraphSpacing, 6);

    assert.equal(nodes.sized.runs[0].fontSize, 40);
    assert.equal(nodes.sized.runs[0].textStyleId, clone.id);
    assert.deepEqual(fontsOf(nodes.symbolOnly), ['→:Old/Regular']);
    assert.deepEqual(fontsOf(nodes.other), ['Other font:Unrelated/Regular']);
    assert.deepEqual(fontsOf(nodes.excluded), ['Leave me:Old/Regular']);
    assert.deepEqual(fontsOf(nodes.outside), ['Elsewhere:Old/Regular']);

    assert.deepEqual(fontsOf(nodes.main), ['Click:New/Regular']);
    assert.deepEqual(fontsOf(nodes.inst), ['Click:New/Regular']);
    assert.ok(!calls.includes('font:I1:3;1:20'), 'instance picked up an override');

    assert.equal(out.errorCount, 0);
    assert.equal(out.leftoverCount, 0);
    assert.equal(out.stats.stylesCloned, 2);
    assert.equal(out.stats.stylesEdited, 1);
    assert.equal(out.stats.keptOnlySegments, 1);
    // Kept characters stay linked to the old style when the rest moves to a copy.
    assert.deepEqual(nodes.arrowLinked.getStyledTextSegments(['fontName', 'textStyleId']).map((s) => [s.characters, s.fontName.family, s.textStyleId]), [
      ['Go ', 'New', clone.id],
      ['→', 'Old', 'S:shared'],
      [' on', 'New', clone.id],
    ]);
    // Empty layers still hold a font.
    assert.equal(nodes.empty.fontName.family, 'New');
    assert.equal(nodes.empty.textStyleId, clone.id);
    assert.equal(nodes.emptyHard.fontName.family, 'New');
    assert.equal(nodes.emptyHard.fontName.style, 'Bold');
    assert.equal(out.stats.emptyLayers, 2);
    // The instance on page Two inherits the main component. That's expected, and kept
    // apart from ordinary layers, which must not move.
    assert.deepEqual(out.outside.filter((p) => p.changed), []);
    assert.deepEqual(out.outside.filter((p) => p.instancesChanged).map((p) => p.page), ['Two']);
  });

  await test('fonts: scan reports fonts that come from variables', async () => {
    const send = fontsContext(buildFile().figmaFonts);
    const out = await send('fontScan', { from: 'Old', to: 'New', scope: pageScope });
    assert.deepEqual(out.fontVariables, [{ name: 'font/family', layers: 1 }]);
  });

  await test('fonts: a missing old font is replaced rather than kept', async () => {
    const file = buildFile();
    file.nodes.hard.runs[0].fontName = { family: 'Old', style: 'Gone' };
    const send = fontsContext(file.figmaFonts);
    const out = await send('fontSwap', { from: 'Old', to: 'New', scope: pageScope, keep: '→' });
    assert.equal(file.nodes.hard.getStyledTextSegments(['fontName']).length, 1);
    assert.equal(file.nodes.hard.runs[0].fontName.family, 'New');
    assert.equal(out.stats.keptNotPossible, 1);
  });

  await test('fonts: running a swap twice reuses copies and changes nothing new', async () => {
    const file = buildFile();
    const send = fontsContext(file.figmaFonts);
    await send('fontSwap', { from: 'Old', to: 'New', scope: pageScope, keep: '→✓' });
    const count = Object.keys(file.styles).length;
    const again = await send('fontSwap', { from: 'Old', to: 'New', scope: pageScope, keep: '→✓' });
    assert.equal(Object.keys(file.styles).length, count);
    assert.equal(again.stats.hardCoded + again.stats.relinked, 0);
    assert.equal(again.leftoverCount, 0);
  });

  await test('fonts: swap stops on the wrong file, and on no restore point', async () => {
    const file = buildFile();
    const send = fontsContext(file.figmaFonts);
    await assert.rejects(send('fontSwap', { from: 'Old', to: 'New', scope: pageScope, expectedFile: 'Other' }), /previewed on "Other"/);
    file.figmaFonts.saveVersionHistoryAsync = async () => { throw new Error('no versions'); };
    await assert.rejects(send('fontSwap', { from: 'Old', to: 'New', scope: pageScope }), /no versions/);
    assert.equal(file.nodes.hard.runs[0].fontName.family, 'Old');
  });

  await test('fonts: one bad layer is reported and the rest still change', async () => {
    const file = buildFile();
    file.nodes.shared.setRangeTextStyleIdAsync = async () => { throw new Error('locked'); };
    const send = fontsContext(file.figmaFonts);
    const out = await send('fontSwap', { from: 'Old', to: 'New', scope: pageScope, keep: '' });
    assert.equal(out.errorCount, 1);
    assert.match(out.errors[0].error, /locked/);
    assert.equal(out.leftoverCount, 1);
    assert.equal(file.nodes.other.runs[0].fontName.family, 'Unrelated');
    assert.equal(file.nodes.lib.runs[0].fontName.family, 'New');
  });

  await test('fonts: check finds cut-off text and skips hidden layers', async () => {
    const file = buildFile();
    const send = fontsContext(file.figmaFonts);
    const out = await send('fontCheck', { scope: pageScope });
    assert.deepEqual(out.clipped.map((c) => [c.id, c.px]), [['1:10', 50]]);
    file.nodes.hard.parent.visible = false;
    const hidden = await send('fontCheck', { scope: pageScope });
    assert.equal(hidden.clipped.length, 0);
  });

  await test('fonts: selection scope uses the selection, and an empty one is refused', async () => {
    const file = buildFile();
    const send = fontsContext(file.figmaFonts);
    file.figmaFonts.currentPage.selection = [];
    await assert.rejects(send('fontAudit', { scope: { type: 'selection' } }), /Nothing is selected/);
    file.figmaFonts.currentPage.selection = [file.nodes.hard];
    const out = await send('fontAudit', { scope: { type: 'selection' } });
    assert.equal(out.textLayers, 1);
    assert.deepEqual(out.scope, { type: 'nodes', ids: ['1:10'], exclude: [] });
  });

  await test('setup can add to a named app without losing its settings', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'type-relay-home-'));
    const uiFile = path.join(ROOT, 'plugin', 'ui.html');
    const existing = fs.existsSync(uiFile) ? fs.readFileSync(uiFile) : null;
    try {
      const cursor = path.join(fakeHome, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(cursor), { recursive: true });
      fs.writeFileSync(cursor, JSON.stringify({ mcpServers: { keepme: { command: 'x' } }, other: 1 }));
      const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'type-relay.mjs'), 'setup', ...args], { env: { ...env, HOME: fakeHome }, encoding: 'utf8' });
      const dry = run('--clients', 'cursor', '--dry-run');
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /Would add/);
      assert.equal(JSON.parse(fs.readFileSync(cursor, 'utf8')).mcpServers['type-relay'], undefined);
      const real = run('--clients', 'cursor');
      assert.equal(real.status, 0, real.stderr);
      const after = JSON.parse(fs.readFileSync(cursor, 'utf8'));
      assert.equal(after.mcpServers.keepme.command, 'x');
      assert.equal(after.other, 1);
      assert.equal(after.mcpServers['type-relay'].args[1], 'mcp');
      assert.ok(fs.existsSync(`${cursor}.type-relay.bak`));
      fs.writeFileSync(cursor, '{ // comments\n}');
      assert.match(run('--clients', 'cursor').stdout, /left alone/);
      assert.equal(run('--clients', 'nope').status, 1);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      if (existing) fs.writeFileSync(uiFile, existing);
      else fs.rmSync(uiFile, { force: true });
    }
  });

  await test('setup builds ui.html with the token and port', () => {
    const uiFile = path.join(ROOT, 'plugin', 'ui.html');
    const existing = fs.existsSync(uiFile) ? fs.readFileSync(uiFile) : null;
    try {
      const out = spawnSync(process.execPath, [path.join(ROOT, 'type-relay.mjs'), 'setup', '--no-register'], { env, encoding: 'utf8' });
      assert.equal(out.status, 0, out.stderr);
      const html = fs.readFileSync(uiFile, 'utf8');
      assert.ok(html.includes(token));
      assert.ok(html.includes(`localhost:${PORT}`));
      assert.ok(!html.includes('__RELAY_'));
      // Run the window script as a non-secure plugin frame: no crypto.randomUUID.
      const sent = [];
      const element = { textContent: '', className: '' };
      vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], {
        crypto: { getRandomValues: (a) => a },
        document: { getElementById: () => element },
        parent: { postMessage: (m) => sent.push(m) },
        window: {},
        Uint8Array,
        Array,
        Math,
        Promise,
        setTimeout,
        JSON,
        fetch: () => new Promise(() => {}),
      });
      assert.equal(sent[0].pluginMessage.type, 'ready');
    } finally {
      if (existing) fs.writeFileSync(uiFile, existing);
      else fs.rmSync(uiFile);
    }
  });

  console.log(`\n${passed} passed`);
} finally {
  pluginA?.stop();
  pluginB?.stop();
  first?.stop();
  second?.stop();
  fs.rmSync(HOME, { recursive: true, force: true });
}
process.exit(0);
