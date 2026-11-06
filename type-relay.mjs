#!/usr/bin/env node
// Type Relay: lets an AI assistant work in the Figma desktop app with your locally
// activated fonts (Adobe Fonts, Typeface, anything installed), and change a font across
// a big file safely. No dependencies.
//
//   AI assistant <-stdio MCP-> type-relay.mjs <-localhost HTTP long-poll-> Figma plugin
//
// Several sessions can run at once: the first process owns the port (the "hub"), the
// others forward to it, and one of them takes over if the hub exits.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCoverage } from './glyphs.mjs';

const VERSION = '0.1.0';
const PORT = Number(process.env.TYPE_RELAY_PORT || 47831);
const HOME = process.env.TYPE_RELAY_HOME || path.join(os.homedir(), '.type-relay');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const POLL_HOLD_MS = 25_000;
const CLIENT_STALE_MS = 40_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_BODY_BYTES = 128 * 1024 * 1024;
const MAX_INLINE_IMAGE_BASE64 = 3_500_000;
const NOT_RUNNING =
  'The Type Relay plugin is not running. In the Figma desktop app, open the file, then ' +
  'Plugins > Development > Type Relay, and leave its small window open.';

const log = (...args) => console.error('[type-relay]', ...args);

// ---------------------------------------------------------------- token

function readToken({ create = false } = {}) {
  const file = path.join(HOME, 'token');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT' || !create) {
      if (err.code === 'ENOENT') throw new Error(`No token at ${file}. Run: node type-relay.mjs setup`);
      throw err;
    }
  }
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- hub (owns the port)

const clients = new Map(); // clientId -> { id, file, page, user, lastSeen, queue, pollRes, pollTimer, busy }
const pending = new Map(); // commandId -> { resolve, reject, timer, client }

function liveClients() {
  const now = Date.now();
  for (const [id, c] of clients) {
    if (!c.busy && !c.pollRes && now - c.lastSeen > CLIENT_STALE_MS) clients.delete(id);
  }
  return [...clients.values()];
}

const describeClient = (c) => ({
  id: c.id,
  file: c.file?.name ?? null,
  fileKey: c.file?.key ?? null,
  page: c.page ?? null,
  user: c.user ?? null,
  busy: c.busy,
});

function pickClient(target) {
  const live = liveClients();
  if (!live.length) throw new Error(NOT_RUNNING);
  const list = () => live.map((c) => `"${c.file?.name}"`).join(', ');
  if (target) {
    const t = String(target).toLowerCase();
    const hits = live.filter(
      (c) => c.id === target || c.file?.key === target || c.file?.name?.toLowerCase().includes(t),
    );
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new Error(`No open file matches "${target}". Connected: ${list()}.`);
    throw new Error(`"${target}" matches ${hits.length} files: ${list()}. Be more specific.`);
  }
  if (live.length === 1) return live[0];
  throw new Error(`The plugin is running in ${live.length} files: ${list()}. Pass target to choose one.`);
}

function flush(client) {
  if (client.busy || !client.pollRes || !client.queue.length) return;
  const command = client.queue.shift();
  client.busy = true;
  const res = client.pollRes;
  client.pollRes = null;
  clearTimeout(client.pollTimer);
  sendJson(res, 200, { command });
}

function dispatchLocal(op, args = {}, { target, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const client = pickClient(target);
    const id = crypto.randomUUID();
    const ms = Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      pending.delete(id);
      client.queue = client.queue.filter((c) => c.id !== id);
      client.busy = false;
      flush(client);
      reject(new Error(`Timed out after ${ms} ms. A script may have partly applied; check the file before retrying.`));
    }, ms);
    pending.set(id, { resolve, reject, timer, client });
    client.queue.push({ id, op, args, timeoutMs: ms });
    flush(client);
  });
}

function sendJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

const CORS = {
  'access-control-allow-origin': '*', // plugin iframes have a null origin; the token is the gate
  'access-control-allow-headers': 'content-type,x-relay-token',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-private-network': 'true',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function handlePoll(body, res) {
  const id = String(body.clientId || '');
  if (!id) return sendJson(res, 400, { error: 'clientId required' });
  const update = { file: body.file, page: body.page, user: body.user, lastSeen: Date.now() };
  let client = clients.get(id);
  if (!client) {
    client = { id, queue: [], busy: false, pollRes: null, pollTimer: null, ...update };
    clients.set(id, client);
    log(`plugin connected: ${body.file?.name}`);
    // Answer the first poll at once so the plugin can show "Connected" without waiting out the hold.
    return sendJson(res, 200, {});
  }
  Object.assign(client, update);
  if (client.pollRes) sendJson(client.pollRes, 200, {});
  clearTimeout(client.pollTimer);
  client.pollRes = res;
  client.pollTimer = setTimeout(() => {
    if (client.pollRes === res) {
      client.pollRes = null;
      client.lastSeen = Date.now();
      sendJson(res, 200, {});
    }
  }, POLL_HOLD_MS);
  res.on('close', () => {
    if (client.pollRes !== res) return;
    // Plugin closed or reloaded. Allow 3 s for a normal reconnect, then treat it as gone.
    client.pollRes = null;
    clearTimeout(client.pollTimer);
    client.lastSeen = Date.now() - (CLIENT_STALE_MS - 3_000);
  });
  flush(client);
}

function handleResult(body, res) {
  const entry = pending.get(body.commandId);
  if (entry) {
    pending.delete(body.commandId);
    clearTimeout(entry.timer);
    entry.client.busy = false;
    entry.client.lastSeen = Date.now();
    if (body.ok) entry.resolve(body.result);
    else entry.reject(new Error(body.error || 'Plugin reported an error'));
    flush(entry.client);
  }
  sendJson(res, 200, { ok: true });
}

function startHub(token) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }
      if (!sameToken(req.headers['x-relay-token'], token)) return sendJson(res, 401, { error: 'bad token' });
      const route = `${req.method} ${req.url}`;
      if (route === 'GET /status') {
        return sendJson(res, 200, { version: VERSION, pid: process.pid, clients: liveClients().map(describeClient) });
      }
      if (req.method !== 'POST') return sendJson(res, 404, { error: 'not found' });
      const body = await readBody(req);
      if (route === 'POST /poll') return handlePoll(body, res);
      if (route === 'POST /ping') {
        // Sent while a command runs, so a long or stuck script isn't mistaken for a closed plugin.
        const client = clients.get(String(body.clientId || ''));
        if (client) client.lastSeen = Date.now();
        return sendJson(res, 200, { ok: true });
      }
      if (route === 'POST /result') return handleResult(body, res);
      if (route === 'POST /exec') {
        try {
          const result = await dispatchLocal(body.op, body.args, body);
          return sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: err.message });
        }
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err) => (err.code === 'EADDRINUSE' ? resolve(null) : reject(err)));
    server.listen(PORT, '127.0.0.1', () => {
      server.unref();
      resolve(server);
    });
  });
}

// ---------------------------------------------------------------- calling the hub

function hubRequest(token, method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path: route,
        headers: {
          'x-relay-token': token,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 401) return reject(new Error(`Port ${PORT} rejected our token. Re-run: node type-relay.mjs setup, then reopen the plugin.`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class Relay {
  constructor({ mayOwn }) {
    this.mayOwn = mayOwn;
    this.token = readToken({ create: mayOwn });
    this.owner = null;
  }

  async tryOwn() {
    if (this.mayOwn && !this.owner) {
      this.owner = await startHub(this.token);
      if (this.owner) log(`hub listening on 127.0.0.1:${PORT}`);
    }
    return Boolean(this.owner);
  }

  // Runs fn against the remote hub; if that hub has gone, take over the port once.
  async viaHub(local, remote) {
    if (await this.tryOwn()) return local();
    try {
      return await remote();
    } catch (err) {
      if (err.code !== 'ECONNREFUSED' && err.code !== 'ECONNRESET') throw err;
      if (await this.tryOwn()) return local();
      if (!this.mayOwn) throw new Error(`Type Relay isn't running on port ${PORT}. Start it with: node type-relay.mjs serve`);
      throw err;
    }
  }

  status() {
    return this.viaHub(
      () => ({ version: VERSION, pid: process.pid, clients: liveClients().map(describeClient) }),
      () => hubRequest(this.token, 'GET', '/status'),
    );
  }

  exec(op, args, opts = {}) {
    return this.viaHub(
      () => dispatchLocal(op, args, opts),
      async () => {
        const reply = await hubRequest(this.token, 'POST', '/exec', { op, args, ...opts });
        if (!reply.ok) throw new Error(reply.error || 'Plugin error');
        return reply.result;
      },
    );
  }
}

// ---------------------------------------------------------------- operations

async function listFonts(relay, { query, target }) {
  const fonts = await relay.exec('fonts', {}, { target });
  const q = query ? String(query).toLowerCase() : null;
  const hits = q ? fonts.filter((f) => f.family.toLowerCase().includes(q)) : fonts;
  // Without a query, family names only: a full list with styles is very long.
  return q ? { count: hits.length, fonts: hits } : { count: hits.length, families: hits.map((f) => f.family) };
}

async function screenshot(relay, { node_id, scale, target, out }) {
  const shot = await relay.exec('export', { nodeId: node_id, scale: scale ?? 1 }, { target, timeoutMs: 120_000 });
  const safeName = String(shot.name || 'node').replace(/[^\w.-]+/g, '-').slice(0, 60);
  const file = out || path.join(HOME, 'shots', `${Date.now()}-${safeName}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(shot.base64, 'base64'));
  return { ...shot, file };
}

// ---------------------------------------------------------------- font tools

const LONG_TIMEOUT_MS = 300_000;
const LIST_LIMIT = 40;
const KEEP_FILES = 50;

function saveRecord(kind, record) {
  const dir = path.join(HOME, kind);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record));
  const old = fs
    .readdirSync(dir)
    .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time)
    .slice(KEEP_FILES);
  for (const f of old) fs.rmSync(path.join(dir, f.name), { force: true });
  return id;
}

function loadRecord(kind, id) {
  if (!/^[0-9a-f]{8}$/.test(String(id))) throw new Error(`Not a valid id: ${id}`);
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, kind, `${id}.json`), 'utf8'));
  } catch {
    throw new Error(`Nothing saved under ${id}.`);
  }
}

function scopeFrom(args, fallback) {
  const exclude = args.exclude_ids || [];
  if (args.node_ids?.length) return { type: 'nodes', ids: args.node_ids, exclude };
  const type = args.scope || fallback;
  if (!type) throw new Error('Say what to change: scope ("selection", "page" or "document") or node_ids.');
  if (!['selection', 'page', 'document'].includes(type)) throw new Error(`Unknown scope: ${type}`);
  return { type, pageId: args.page_id, exclude };
}

// Spaces, control characters and combining marks aren't worth checking.
const checkable = (ch) => !/^[\p{Z}\p{C}\p{M}]$/u.test(ch);

// Which characters does the target font lack? Those stay in the old font, as long as it has them.
async function glyphReport(from, to, mapping, extraKeep) {
  const toRequests = mapping.map((m) => ({ family: to, style: m.to, codes: Object.keys(m.chars).filter(checkable).map((c) => c.codePointAt(0)) }));
  const fromRequests = mapping.map((m) => ({ family: from, style: m.from, codes: Object.keys(m.chars).filter(checkable).map((c) => c.codePointAt(0)) }));
  const [toResult, fromResult] = await Promise.all([checkCoverage(toRequests), checkCoverage(fromRequests)]);
  const manual = Array.from(extraKeep || '');
  if (!toResult || toResult.some((r) => !r.found)) {
    return {
      checked: false,
      reason: !toResult
        ? 'The character check needs macOS.'
        : `"${to}" isn't installed on this computer as a font file (it may be hosted by Figma), so its characters can't be read.`,
      missing: [],
      keep: manual.join(''),
    };
  }
  const missing = new Map();
  mapping.forEach((m, i) => {
    for (const code of toResult[i].missing) {
      const ch = String.fromCodePoint(code);
      const info = m.chars[ch];
      const entry = missing.get(ch) || { char: ch, code: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`, layers: 0, sample: info.sample, inOldFont: null };
      entry.layers += info.layers;
      const old = fromResult?.[i];
      if (old?.found) entry.inOldFont = entry.inOldFont === true || !old.missing.includes(code);
      missing.set(ch, entry);
    }
  });
  const list = [...missing.values()].sort((a, b) => b.layers - a.layers);
  // Unknown (a hosted old font) counts as worth keeping: it's what you see today.
  const keep = new Set([...manual, ...list.filter((m) => m.inOldFont !== false).map((m) => m.char)]);
  return {
    checked: true,
    approximate: toResult.some((r) => !r.exactStyle),
    oldFontChecked: Boolean(fromResult?.every((r) => r.found)),
    missing: list,
    keep: [...keep].join(''),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function previewWarnings(scan, glyphs) {
  const out = [];
  if (!scan.matchedLayers) out.push(`No text in ${scan.label} uses this font, so there is nothing to change.`);
  for (const m of scan.mapping) {
    if (m.kind === 'nearest') out.push(`${m.from} isn't in the new family, so ${plural(m.layers, 'layer')} become${m.layers === 1 ? 's' : ''} ${m.to}${m.note ? ` (${m.note})` : ''}.`);
    if (m.kind === 'equivalent') out.push(`${m.from} maps to ${m.to}, which looks like the same weight.`);
  }
  if (!glyphs.checked) out.push(`Missing characters weren't checked: ${glyphs.reason} Figma will fall back to another font for anything the new font lacks.`);
  if (glyphs.missing.length) {
    const kept = glyphs.missing.filter((m) => glyphs.keep.includes(m.char)).map((m) => m.char);
    if (kept.length) out.push(`The new font lacks ${kept.join(' ')}. They stay in the old font, which shows as mixed text styles on those layers.`);
  }
  for (const s of scan.styles) {
    if (s.action === 'edit') out.push(`Text style "${s.name}" will be edited in place. On a big file this can take minutes.`);
    if (s.published) out.push(`Text style "${s.name}" is published to a library, so it's copied rather than edited.`);
  }
  for (const c of scan.componentsOutside) {
    out.push(`Component "${c.name}" is in scope but has ${plural(c.instancesOutside, 'instance')} outside it, which will change too.`);
  }
  for (const v of scan.fontVariables || []) {
    out.push(`${plural(v.layers, 'layer')} take their font from the variable "${v.name}". The swap replaces that link with a fixed font. To keep the link, change the variable instead.`);
  }
  return out;
}

const previewSignature = (scan, glyphs) =>
  JSON.stringify({
    mapping: scan.mapping.map((m) => `${m.from}>${m.to}`).sort(),
    keep: [...glyphs.keep].sort(),
    styles: scan.styles.map((s) => `${s.name}:${s.action}`).sort(),
  });

async function scanWithGlyphs(relay, spec, target) {
  const scan = await relay.exec(
    'fontScan',
    { from: spec.from, to: spec.to, styleMap: spec.styleMap, styleMode: spec.styleMode, scope: spec.scope },
    { target, timeoutMs: LONG_TIMEOUT_MS },
  );
  const glyphs = await glyphReport(spec.from, spec.to, scan.mapping, spec.keepCharacters);
  return { scan, glyphs };
}

async function preview(relay, args) {
  if (!args.from || !args.to) throw new Error('from and to are required.');
  if (args.from === args.to) throw new Error('from and to are the same font.');
  const spec = {
    from: args.from,
    to: args.to,
    styleMap: args.style_map,
    styleMode: args.style_mode,
    stylePrefix: args.style_prefix,
    keepCharacters: args.keep_characters,
    scope: scopeFrom(args),
  };
  const { scan, glyphs } = await scanWithGlyphs(relay, spec, args.target);
  spec.scope = scan.scope; // Fixed now, so a later change of page or selection can't widen the swap.
  const id = saveRecord('previews', { spec, target: args.target, file: scan.file, signature: previewSignature(scan, glyphs) });
  return {
    preview_id: id,
    file: scan.file,
    scope: scan.label,
    change: `${args.from} to ${args.to}`,
    textLayers: scan.textLayers,
    layersUsingOldFont: scan.matchedLayers,
    newFontStyles: scan.target.styles,
    weights: scan.mapping.map(({ chars, ...m }) => m),
    missingCharacters: glyphs.checked
      ? { checked: true, approximate: glyphs.approximate, oldFontChecked: glyphs.oldFontChecked, list: glyphs.missing.slice(0, LIST_LIMIT), count: glyphs.missing.length }
      : { checked: false, reason: glyphs.reason },
    keptInOldFont: glyphs.keep,
    textStyles: scan.styles,
    warnings: previewWarnings(scan, glyphs),
    note: 'Nothing has changed. To apply this, call type_swap with preview_id.',
  };
}

function capped(list) {
  return { count: list.length, items: list.slice(0, LIST_LIMIT) };
}

function compareChecks(before, after) {
  const beforeClipped = new Map(before.clipped.map((c) => [c.id, c.px]));
  const afterClipped = new Map(after.clipped.map((c) => [c.id, c.px]));
  const beforeFrames = new Map(before.frames.map((f) => [f.id, f]));
  const beforeOverlaps = new Set(before.overlaps.map((o) => `${o.a}|${o.b}`));
  const resized = after.frames
    .filter((f) => beforeFrames.has(f.id))
    .map((f) => ({ id: f.id, name: f.name, widthChange: Math.round(f.w - beforeFrames.get(f.id).w), heightChange: Math.round(f.h - beforeFrames.get(f.id).h) }))
    .filter((f) => f.widthChange || f.heightChange)
    .sort((a, b) => Math.abs(b.heightChange) - Math.abs(a.heightChange));
  return {
    newlyCutOff: capped(after.clipped.filter((c) => !beforeClipped.has(c.id) || c.px > beforeClipped.get(c.id) + 1).sort((a, b) => b.px - a.px)),
    noLongerCutOff: before.clipped.filter((c) => !afterClipped.has(c.id)).length,
    framesResized: capped(resized),
    newOverlaps: capped(after.overlaps.filter((o) => !beforeOverlaps.has(`${o.a}|${o.b}`))),
  };
}

const checkOpts = (target) => ({ target, timeoutMs: LONG_TIMEOUT_MS });

async function check(relay, args) {
  const result = await relay.exec('fontCheck', { scope: scopeFrom(args, 'page') }, checkOpts(args.target));
  const id = saveRecord('snapshots', result);
  const summary = {
    snapshot_id: id,
    file: result.file,
    scope: result.label,
    textLayers: result.textLayers,
    cutOff: capped([...result.clipped].sort((a, b) => b.px - a.px)),
    spillingOutOfParent: capped([...result.overflow].sort((a, b) => b.px - a.px)),
    fixedSizeTextBoxes: result.fixedBoxes,
    overlappingFrames: capped(result.overlaps),
    limits: 'Cut-off is measured from text box edges. Text overflowing a fixed-size text box can\'t be detected, so check those by eye.',
  };
  if (args.compare_to) summary.comparedTo = { snapshot_id: args.compare_to, ...compareChecks(loadRecord('snapshots', args.compare_to), result) };
  return summary;
}

async function swap(relay, args) {
  if (!args.preview_id) throw new Error('Run type_preview first and pass its preview_id.');
  const saved = loadRecord('previews', args.preview_id);
  const target = args.target ?? saved.target;
  const { scan, glyphs } = await scanWithGlyphs(relay, saved.spec, target);
  if (previewSignature(scan, glyphs) !== saved.signature) {
    throw new Error('The file has changed since this preview in a way that affects the result (weights, kept characters or text styles). Run type_preview again.');
  }
  const scope = saved.spec.scope;
  const before = await relay.exec('fontCheck', { scope }, checkOpts(target));
  const result = await relay.exec(
    'fontSwap',
    {
      from: saved.spec.from,
      to: saved.spec.to,
      styleMap: saved.spec.styleMap,
      styleMode: saved.spec.styleMode,
      stylePrefix: saved.spec.stylePrefix,
      scope,
      keep: glyphs.keep,
      expectedFile: saved.file,
      restorePoint: args.restore_point,
    },
    { target, timeoutMs: MAX_TIMEOUT_MS },
  );
  const after = await relay.exec('fontCheck', { scope }, checkOpts(target));
  const snapshotId = saveRecord('snapshots', after);
  const changedOutside = (result.outside || []).filter((p) => p.changed);
  const instancesMoved = (result.outside || []).some((p) => p.instancesChanged);
  const unexplained = instancesMoved && !scan.componentsOutside.length;
  return {
    change: `${saved.spec.from} to ${saved.spec.to}`,
    scope: scan.label,
    ...result,
    keptInOldFont: glyphs.keep,
    layoutChanges: compareChecks(before, after),
    snapshot_id: snapshotId,
    verdict:
      result.errorCount || result.leftoverCount || changedOutside.length || unexplained
        ? 'Needs a look: see errors, leftover and outside.'
        : instancesMoved
          ? 'Clean: every layer changed. Outside the scope, only instances of swapped components moved, as the preview warned.'
          : 'Clean: every layer changed, and nothing outside the scope moved.',
    undo: `File > Show version history > "${result.restorePoint.name}". Undo in Figma also reverts this as one step.`,
  };
}

// ---------------------------------------------------------------- MCP over stdio

const targetProp = {
  target: {
    type: 'string',
    description: 'File name (partial match) or file key. Only needed when the plugin is running in several files.',
  },
};

const scopeProps = {
  scope: { type: 'string', enum: ['selection', 'page', 'document'], description: 'What to cover. "page" means the current page unless page_id is set.' },
  page_id: { type: 'string', description: 'A page id, when scope is "page".' },
  node_ids: { type: 'array', items: { type: 'string' }, description: 'Specific layers to cover, instead of scope.' },
  exclude_ids: { type: 'array', items: { type: 'string' }, description: 'Layers to leave out, with everything inside them.' },
};

const TOOLS = [
  {
    name: 'type_status',
    description: 'Show which Figma desktop files have the Type Relay plugin running, and the current page in each.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'type_list_fonts',
    description:
      'List fonts available in the Figma desktop app, including local Adobe Fonts and Typeface activations. Pass query to filter by family and get its styles; without it, returns family names only.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Part of a family name, e.g. "effra".' }, ...targetProp },
    },
  },
  {
    name: 'type_audit',
    description:
      'Report which fonts text uses in a selection, page or file: layers per family, styles, how much is linked to text styles or hard-coded, and which fonts are missing. Read-only. Defaults to the current page.',
    inputSchema: { type: 'object', properties: { ...scopeProps, ...targetProp } },
  },
  {
    name: 'type_preview',
    description:
      'Work out what changing one font family to another would do, without changing anything: how each weight maps, which characters the new font lacks (these stay in the old font), which text styles get copied or edited, and any components that reach outside the scope. Returns a preview_id for type_swap. Show the warnings to the person before swapping.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Font family to replace, exactly as Figma names it.' },
        to: { type: 'string', description: 'Font family to change to.' },
        style_map: { type: 'object', additionalProperties: { type: 'string' }, description: 'Override the weight mapping, e.g. {"SemiBold": "Medium"}.' },
        style_mode: { type: 'string', enum: ['auto', 'clone', 'edit'], description: 'Text styles. "auto" (default) edits a style only if nothing outside the scope uses it and it isn\'t published, and copies it otherwise. "clone" always copies. "edit" edits local styles even if used elsewhere.' },
        style_prefix: { type: 'string', description: 'Prefix for copied text style names. Default is the new family name plus "/".' },
        keep_characters: { type: 'string', description: 'Extra characters to leave in the old font.' },
        ...scopeProps,
        ...targetProp,
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'type_swap',
    description:
      'Apply a type_preview: saves a named restore point in version history, updates text styles, changes the text, keeps manual overrides, and leaves characters the new font lacks in the old font. Reports errors, leftovers, whether anything outside the scope changed, and what moved in the layout (cut-off text, resized frames, new overlaps). Refuses if the file has changed in a way that affects the preview.',
    inputSchema: {
      type: 'object',
      properties: {
        preview_id: { type: 'string', description: 'From type_preview.' },
        restore_point: { type: 'string', description: 'Name for the version history entry.' },
        ...targetProp,
      },
      required: ['preview_id'],
    },
  },
  {
    name: 'type_check',
    description:
      'Find layout problems in text: cut-off layers, text spilling out of its parent, and top-level frames that overlap. Read-only. Returns a snapshot_id; pass one as compare_to to see only what changed since then. Defaults to the current page.',
    inputSchema: {
      type: 'object',
      properties: { compare_to: { type: 'string', description: 'A snapshot_id from an earlier type_check or type_swap.' }, ...scopeProps, ...targetProp },
    },
  },
  {
    name: 'type_run',
    description:
      'Run Figma Plugin API JavaScript in the file open in the desktop app, for anything the other tools don\'t cover. Use this instead of a remote Figma tool when text needs a local font. The code is an async function body with figma in scope: use await, and return a JSON-serialisable value. console.log output comes back as logs. Before changing text, call await figma.loadFontAsync({family, style}) for its font; check exact style names with type_list_fonts. Pages load on demand, so use await figma.getNodeByIdAsync(id) and await page.loadAsync(). Each run is one undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Async function body.' },
        timeout_ms: { type: 'number', description: 'Default 60000, maximum 600000.' },
        ...targetProp,
      },
      required: ['code'],
    },
  },
  {
    name: 'type_screenshot',
    description:
      'Export a node as PNG from the desktop app, rendered with the real local fonts. Defaults to the current selection. Saves a file and returns its path, plus the image itself when small enough.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'Node id, e.g. "12:345". Defaults to the first selected node.' },
        scale: { type: 'number', description: 'Export scale, default 1.' },
        ...targetProp,
      },
    },
  },
];

const textContent = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

async function callTool(relay, name, args = {}) {
  switch (name) {
    case 'type_status': {
      const status = await relay.status();
      return textContent(status.clients.length ? status : { ...status, note: NOT_RUNNING });
    }
    case 'type_list_fonts':
      return textContent(await listFonts(relay, args));
    case 'type_run': {
      if (typeof args.code !== 'string') throw new Error('code is required');
      return textContent(await relay.exec('run', { code: args.code }, { target: args.target, timeoutMs: args.timeout_ms }));
    }
    case 'type_screenshot': {
      const shot = await screenshot(relay, args);
      const summary = { file: shot.file, node: shot.id, name: shot.name, width: shot.width, height: shot.height, scale: shot.scale };
      const result = textContent(summary);
      if (shot.base64.length <= MAX_INLINE_IMAGE_BASE64) {
        result.content.push({ type: 'image', data: shot.base64, mimeType: 'image/png' });
      } else {
        result.content[0].text += '\nImage too large to return inline; open the saved file, or use a lower scale.';
      }
      return result;
    }
    case 'type_audit':
      return textContent(await relay.exec('fontAudit', { scope: scopeFrom(args, 'page') }, { target: args.target, timeoutMs: LONG_TIMEOUT_MS }));
    case 'type_preview':
      return textContent(await preview(relay, args));
    case 'type_swap':
      return textContent(await swap(relay, args));
    case 'type_check':
      return textContent(await check(relay, args));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function runMcp() {
  const relay = new Relay({ mayOwn: true });
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg) {
    const { id, method, params } = msg;
    if (id === undefined) return; // notification
    switch (method) {
      case 'initialize':
        return respond(id, {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'type-relay', version: VERSION },
        });
      case 'ping':
        return respond(id, {});
      case 'tools/list':
        return respond(id, { tools: TOOLS });
      case 'tools/call':
        try {
          return respond(id, await callTool(relay, params?.name, params?.arguments));
        } catch (err) {
          return respond(id, { ...textContent(err.message), isError: true });
        }
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      handle(msg).catch((err) => log(err));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  relay.tryOwn().catch((err) => log(err)); // be ready for the plugin as soon as a session starts
}

// ---------------------------------------------------------------- CLI

// Apps whose MCP settings are a plain JSON file. Setup only touches the ones you name.
function jsonClients() {
  const home = os.homedir();
  const support = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : process.env.APPDATA || path.join(home, '.config');
  return {
    'claude-desktop': path.join(support, 'Claude', 'claude_desktop_config.json'),
    cursor: path.join(home, '.cursor', 'mcp.json'),
    windsurf: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
  };
}

function registerClaudeCode(serverArgs, dryRun) {
  const has = (() => {
    try {
      execFileSync('claude', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  if (!has) return 'Claude Code not found, skipped.';
  if (dryRun) return 'Would register with Claude Code.';
  try {
    execFileSync('claude', ['mcp', 'remove', 'type-relay', '-s', 'user'], { stdio: 'ignore' });
  } catch {
    // Wasn't registered yet.
  }
  execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'type-relay', '--', ...serverArgs], { stdio: 'ignore' });
  return 'Registered with Claude Code. Sessions started from now on have the tools.';
}

function registerJson(name, file, serverArgs, dryRun) {
  if (!fs.existsSync(path.dirname(file))) return `${name} not found (${path.dirname(file)}), skipped.`;
  if (dryRun) return `Would add Type Relay to ${file}.`;
  let config = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    try {
      config = text.trim() ? JSON.parse(text) : {};
    } catch {
      return `${file} isn't plain JSON, so it was left alone. Add this yourself: ${JSON.stringify({ 'type-relay': { command: serverArgs[0], args: serverArgs.slice(1) } })}`;
    }
    fs.writeFileSync(`${file}.type-relay.bak`, text);
  }
  config.mcpServers = { ...config.mcpServers, 'type-relay': { command: serverArgs[0], args: serverArgs.slice(1) } };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return `Added to ${name} (${file}). Your old settings are saved next to it as .type-relay.bak. Restart ${name}.`;
}

// process.execPath can be a versioned folder that disappears when Node is upgraded.
function stableNodePath() {
  try {
    return execFileSync('which', ['node'], { encoding: 'utf8' }).trim() || process.execPath;
  } catch {
    return process.execPath;
  }
}

function setup(flags) {
  const dryRun = Boolean(flags['dry-run']);
  const token = dryRun ? null : readToken({ create: true });
  if (!dryRun) {
    const template = fs.readFileSync(path.join(ROOT, 'plugin', 'ui.template.html'), 'utf8');
    const html = template.replaceAll('__RELAY_TOKEN__', token).replaceAll('__RELAY_PORT__', String(PORT));
    fs.writeFileSync(path.join(ROOT, 'plugin', 'ui.html'), html, { mode: 0o600 });
  }
  const serverArgs = [stableNodePath(), path.join(ROOT, 'type-relay.mjs'), 'mcp'];
  const clients = jsonClients();
  const named = flags.clients ? String(flags.clients).split(',').map((c) => c.trim()).filter(Boolean) : null;
  for (const name of named || []) {
    if (name !== 'claude-code' && !clients[name]) throw new Error(`Unknown app: ${name}. Choose from claude-code, ${Object.keys(clients).join(', ')}.`);
  }
  if (flags['no-register']) console.log('Skipped registering with any app.');
  else if (!named || named.includes('claude-code')) console.log(registerClaudeCode(serverArgs, dryRun));
  if (!flags['no-register']) {
    for (const name of named || []) if (clients[name]) console.log(registerJson(name, clients[name], serverArgs, dryRun));
    if (!named) {
      const found = Object.keys(clients).filter((c) => fs.existsSync(path.dirname(clients[c])));
      if (found.length) console.log(`Also found ${found.join(', ')}. Add with: node type-relay.mjs setup --clients ${found.join(',')}`);
    }
  }
  console.log(dryRun ? 'Dry run: nothing changed.' : `Plugin built. In Figma desktop, open any file, then: Plugins > Development > Import plugin from manifest...`);
  if (!dryRun) console.log(`  ${path.join(ROOT, 'plugin', 'manifest.json')}`);
}

const BOOLEAN_FLAGS = new Set(['dry-run', 'no-register']);

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2);
      flags[name] = BOOLEAN_FLAGS.has(name) ? true : argv[++i];
    } else positional.push(argv[i]);
  }
  return { flags, positional };
}

const USAGE = `Usage: node type-relay.mjs <command>
  setup [--clients a,b] [--dry-run] [--no-register]
                                          create the token, build the plugin, register with your AI app
  mcp                                     MCP server over stdio (what your AI app runs)
  serve                                   run the hub in the foreground
  status                                  show connected files
  fonts [query] [--target file]           list fonts Figma can see
  audit [scope flags]                     which fonts are used, and what's missing
  preview <from> <to> [scope flags] [--map SemiBold=Medium,...] [--keep chars] [--style-mode auto|clone|edit] [--prefix text]
  swap <previewId> [--restore-point name]
  check [scope flags] [--compare snapshotId]
  run <file.js|-> [--target file] [--timeout ms]
  shot [nodeId] [--scale n] [--out path] [--target file]

Scope flags: --scope selection|page|document  --page id  --nodes a,b  --exclude a,b`;

const list = (value) => (value ? String(value).split(',').map((v) => v.trim()).filter(Boolean) : undefined);

const scopeArgs = (flags) => ({
  scope: flags.scope,
  page_id: flags.page,
  node_ids: list(flags.nodes),
  exclude_ids: list(flags.exclude),
  target: flags.target,
});

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseFlags(rest);
  const print = (value) => console.log(JSON.stringify(value, null, 2));
  const callJson = async (tool, args) => JSON.parse((await callTool(new Relay({ mayOwn: false }), tool, args)).content[0].text);
  switch (command) {
    case 'setup':
      return setup(flags);
    case 'mcp':
      return runMcp();
    case 'serve': {
      const relay = new Relay({ mayOwn: true });
      if (!(await relay.tryOwn())) throw new Error(`Port ${PORT} is already in use.`);
      relay.owner.ref();
      return;
    }
    case 'status':
      return print(await new Relay({ mayOwn: false }).status());
    case 'fonts':
      return print(await listFonts(new Relay({ mayOwn: false }), { query: positional[0], target: flags.target }));
    case 'audit':
      return print(await callJson('type_audit', scopeArgs(flags)));
    case 'preview': {
      if (positional.length < 2) throw new Error(USAGE);
      const style_map = flags.map ? Object.fromEntries(list(flags.map).map((pair) => pair.split('='))) : undefined;
      return print(
        await callJson('type_preview', {
          from: positional[0],
          to: positional[1],
          style_map,
          keep_characters: flags.keep,
          style_mode: flags['style-mode'],
          style_prefix: flags.prefix,
          ...scopeArgs(flags),
        }),
      );
    }
    case 'swap':
      if (!positional[0]) throw new Error(USAGE);
      return print(await callJson('type_swap', { preview_id: positional[0], restore_point: flags['restore-point'], target: flags.target }));
    case 'check':
      return print(await callJson('type_check', { compare_to: flags.compare, ...scopeArgs(flags) }));
    case 'run': {
      if (!positional[0]) throw new Error(USAGE);
      const code = fs.readFileSync(positional[0] === '-' ? 0 : positional[0], 'utf8');
      return print(
        await new Relay({ mayOwn: false }).exec('run', { code }, { target: flags.target, timeoutMs: flags.timeout }),
      );
    }
    case 'shot': {
      const shot = await screenshot(new Relay({ mayOwn: false }), {
        node_id: positional[0],
        scale: flags.scale ? Number(flags.scale) : undefined,
        target: flags.target,
        out: flags.out,
      });
      return print({ file: shot.file, node: shot.id, name: shot.name, width: shot.width, height: shot.height });
    }
    case 'help':
      return console.log(USAGE);
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
