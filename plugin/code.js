// Runs inside the Figma desktop app, so figma.loadFontAsync can use local fonts.
// ui.html does the networking; this file carries out the commands it receives.

figma.showUI(__html__, { width: 260, height: 92, themeColors: true });

// fileKey and currentUser are permission-gated and throw when not granted.
function optional(read) {
  try {
    return read();
  } catch (err) {
    return null;
  }
}

function fileInfo() {
  return {
    file: {
      name: figma.root.name,
      key: optional(function () {
        return figma.fileKey || null;
      }),
    },
    page: figma.currentPage.name,
    user: optional(function () {
      return figma.currentUser.name;
    }),
  };
}

function sendInfo() {
  try {
    figma.ui.postMessage({ type: 'info', info: fileInfo() });
  } catch (err) {
    figma.ui.postMessage({ type: 'fatal', error: String(err) });
  }
}

// postMessage can't carry nodes or symbols, so reduce results to plain JSON.
function plain(value) {
  if (value === undefined) return null;
  var text = JSON.stringify(value, function (key, v) {
    if (typeof v === 'symbol') return v === figma.mixed ? 'figma.mixed' : String(v);
    if (typeof v === 'function') return undefined;
    if (v instanceof Uint8Array) return { bytes: v.length };
    if (v && typeof v === 'object' && typeof v.id === 'string' && typeof v.type === 'string' && 'parent' in v) {
      return { id: v.id, type: v.type, name: v.name };
    }
    return v;
  });
  return text === undefined ? null : JSON.parse(text);
}

function compile(source) {
  var wrapped = '(async function (console) {\n' + source + '\n})';
  try {
    return (0, eval)(wrapped);
  } catch (err) {
    if (err instanceof SyntaxError) throw err;
    // Fallback in case the sandbox blocks indirect eval.
    var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return new AsyncFunction('console', source);
  }
}

async function runScript(args) {
  var logs = [];
  var capture = function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      parts.push(typeof a === 'string' ? a : JSON.stringify(plain(a)));
    }
    logs.push(parts.join(' '));
  };
  var fakeConsole = { log: capture, info: capture, warn: capture, error: capture, debug: capture };
  try {
    var result = await compile(args.code)(fakeConsole);
    return { result: plain(result), logs: logs };
  } catch (err) {
    var message = err && err.stack ? String(err.stack) : String(err);
    if (logs.length) message += '\nLogs before the error:\n' + logs.join('\n');
    throw new Error(message);
  } finally {
    figma.commitUndo(); // one undo step per run
  }
}

async function exportNode(args) {
  var node = args.nodeId ? await figma.getNodeByIdAsync(args.nodeId) : figma.currentPage.selection[0];
  if (!node) throw new Error(args.nodeId ? 'Node not found: ' + args.nodeId : 'Nothing selected. Pass a node id or select a layer.');
  if (typeof node.exportAsync !== 'function') throw new Error('Node cannot be exported: ' + node.type);
  var scale = Number(args.scale) || 1;
  var bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
  return {
    id: node.id,
    name: node.name,
    width: node.width,
    height: node.height,
    scale: scale,
    base64: figma.base64Encode(bytes),
  };
}

async function listFonts() {
  var fonts = await figma.listAvailableFontsAsync();
  var families = {};
  fonts.forEach(function (f) {
    var family = f.fontName.family;
    (families[family] = families[family] || []).push(f.fontName.style);
  });
  return Object.keys(families)
    .sort()
    .map(function (family) {
      return { family: family, styles: families[family] };
    });
}

// ---------------------------------------------------------------- font tools

const SEGMENT_FIELDS = ['fontName', 'textStyleId', 'fontSize', 'letterSpacing', 'lineHeight', 'textCase', 'textDecoration'];
const RANGE_SETTERS = {
  fontSize: 'setRangeFontSize',
  letterSpacing: 'setRangeLetterSpacing',
  lineHeight: 'setRangeLineHeight',
  textCase: 'setRangeTextCase',
  textDecoration: 'setRangeTextDecoration',
};
const STYLE_PROPS = [
  'fontSize', 'letterSpacing', 'lineHeight', 'paragraphIndent', 'paragraphSpacing', 'listSpacing',
  'hangingPunctuation', 'hangingList', 'textCase', 'textDecoration', 'leadingTrim', 'description',
];
const PARAGRAPH_SETTINGS = ['ParagraphSpacing', 'ParagraphIndent', 'ListSpacing'];
const FONT_BINDINGS = ['fontFamily', 'fontStyle', 'fontWeight'];
const SAMPLE_LIMIT = 40;

const NOTHING = new Set();
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isBlank = (ch) => /^\s$/.test(ch);

function parseStyle(name) {
  const n = String(name).toLowerCase().replace(/[\s_-]+/g, '');
  const width = (n.match(/(ultra|extra|semi)?(condensed|compressed|narrow|expanded|extended|wide)/) || [''])[0];
  const rest = n.replace(width, '');
  let weight = 400;
  if (/thin|hairline/.test(rest)) weight = 100;
  else if (/(extra|ultra)light/.test(rest)) weight = 200;
  else if (/(semi|demi)light/.test(rest)) weight = 350;
  else if (/light/.test(rest)) weight = 300;
  else if (/(semi|demi)bold|demi/.test(rest)) weight = 600;
  else if (/(extra|ultra)bold/.test(rest)) weight = 800;
  else if (/bold/.test(rest)) weight = 700;
  else if (/black|heavy/.test(rest)) weight = 900;
  else if (/medium/.test(rest)) weight = 500;
  return { weight, italic: /italic|oblique/.test(rest), width };
}

// Same style name, else its equivalent, else the nearest weight. A tie goes heavier from
// Medium up (SemiBold -> Bold) and lighter below it, so emphasis isn't lost.
function mapStyle(from, toStyles, styleMap) {
  const forced = styleMap && styleMap[from];
  if (forced) {
    if (toStyles.indexOf(forced) < 0) throw new Error('The target family has no style "' + forced + '". It has: ' + toStyles.join(', '));
    return { style: forced, kind: 'forced' };
  }
  if (toStyles.indexOf(from) >= 0) return { style: from, kind: 'exact' };
  const src = parseStyle(from);
  let best = null;
  let bestScore = Infinity;
  for (const candidate of toStyles) {
    const c = parseStyle(candidate);
    const score = Math.abs(c.weight - src.weight) + (c.italic !== src.italic ? 1000 : 0) + (c.width !== src.width ? 2000 : 0);
    const preferred = src.weight >= 500 ? c.weight > (best ? parseStyle(best).weight : -1) : c.weight < (best ? parseStyle(best).weight : Infinity);
    if (score < bestScore || (score === bestScore && preferred)) {
      best = candidate;
      bestScore = score;
    }
  }
  const b = parseStyle(best);
  const result = { style: best, kind: bestScore === 0 ? 'equivalent' : 'nearest' };
  if (src.italic && !b.italic) result.note = 'italic lost';
  if (src.width !== b.width) result.note = (result.note ? result.note + ', ' : '') + 'width changed';
  return result;
}

async function availableFonts() {
  const families = {};
  for (const f of await figma.listAvailableFontsAsync()) {
    (families[f.fontName.family] = families[f.fontName.family] || []).push(f.fontName.style);
  }
  return families;
}

function pageOf(node) {
  let n = node;
  while (n && n.type !== 'PAGE') n = n.parent;
  return n;
}

function topLevelOf(node) {
  let n = node;
  while (n.parent && n.parent.type !== 'PAGE' && n.parent.type !== 'DOCUMENT') n = n.parent;
  return n;
}

async function resolveScope(spec) {
  const s = spec || {};
  const exclude = s.exclude || [];
  let roots;
  let normal;
  let label;
  if (s.type === 'document') {
    await figma.loadAllPagesAsync();
    roots = figma.root.children.slice();
    normal = { type: 'document', exclude };
    label = 'whole file';
  } else if (s.type === 'nodes' || s.type === 'selection') {
    const ids = s.type === 'selection' ? figma.currentPage.selection.map((n) => n.id) : s.ids || [];
    if (!ids.length) throw new Error(s.type === 'selection' ? 'Nothing is selected.' : 'No node ids given.');
    roots = [];
    for (const id of ids) {
      const node = await figma.getNodeByIdAsync(id);
      if (!node) throw new Error('Node not found: ' + id);
      const page = node.type === 'PAGE' ? node : pageOf(node);
      if (page) await page.loadAsync();
      roots.push(node);
    }
    normal = { type: 'nodes', ids, exclude };
    label = ids.length + ' chosen layer' + (ids.length === 1 ? '' : 's');
  } else {
    const page = s.pageId ? await figma.getNodeByIdAsync(s.pageId) : figma.currentPage;
    if (!page || page.type !== 'PAGE') throw new Error('Page not found: ' + s.pageId);
    await page.loadAsync();
    roots = [page];
    normal = { type: 'page', pageId: page.id, exclude };
    label = 'page "' + page.name + '"';
  }
  return { roots, normal, label, exclude };
}

// Main components first, then ordinary layers, then instance layers. By the time an instance
// is reached its main component has changed, so it doesn't pick up a needless override.
function collectText(scope) {
  const excluded = new Set();
  const seen = new Map();
  const add = (node) => {
    if (seen.has(node.id)) return;
    let rank = 1;
    if (node.id.charAt(0) === 'I') rank = 2;
    else {
      for (let a = node.parent; a && a.type !== 'PAGE'; a = a.parent) {
        if (a.type === 'COMPONENT') {
          rank = 0;
          break;
        }
      }
    }
    seen.set(node.id, { node, rank });
  };
  const walkRoot = (root, visit) => {
    if (root.type === 'TEXT') visit(root);
    else if (root.findAllWithCriteria) root.findAllWithCriteria({ types: ['TEXT'] }).forEach(visit);
  };
  return (async () => {
    for (const id of scope.exclude) {
      const node = await figma.getNodeByIdAsync(id);
      if (!node) throw new Error('Excluded node not found: ' + id);
      walkRoot(node, (t) => excluded.add(t.id));
    }
    for (const root of scope.roots) {
      walkRoot(root, (t) => {
        if (!excluded.has(t.id)) add(t);
      });
    }
    return Array.from(seen.values())
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.node);
  })();
}

function allOtherText(textIds) {
  const out = [];
  for (const page of figma.root.children) {
    for (const t of page.findAllWithCriteria({ types: ['TEXT'] })) {
      if (!textIds.has(t.id)) out.push({ page, node: t });
    }
  }
  return out;
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

async function outsideFingerprint(scope, textIds) {
  if (scope.normal.type === 'document' && !scope.exclude.length) return null;
  await figma.loadAllPagesAsync();
  const pages = {};
  for (const { page, node } of allOtherText(textIds)) {
    const entry = (pages[page.id] = pages[page.id] || { page: page.name, layers: 0, instanceLayers: 0, parts: [], instanceParts: [] });
    const inInstance = node.id.charAt(0) === 'I';
    entry[inInstance ? 'instanceLayers' : 'layers'] += 1;
    const segments = segmentsOf(node, ['fontName', 'textStyleId']);
    entry[inInstance ? 'instanceParts' : 'parts'].push(node.id + ':' + segments.map((x) => x.fontName.family + '/' + x.fontName.style + '/' + x.textStyleId).join(',') + ':' + node.width + 'x' + node.height);
  }
  const out = {};
  for (const id of Object.keys(pages)) {
    const e = pages[id];
    out[id] = { page: e.page, layers: e.layers, instanceLayers: e.instanceLayers, hash: hash(e.parts.join(';')), instanceHash: hash(e.instanceParts.join(';')) };
  }
  return out;
}

// An empty layer has no segments, but it still has a font, and anything typed there uses it.
function segmentsOf(node, fields) {
  if (node.characters.length) return node.getStyledTextSegments(fields);
  const seg = { start: 0, end: 0, characters: '' };
  for (const field of fields) seg[field] = node[field];
  return [seg];
}

function keepRunsOf(characters, start, keep) {
  const runs = [];
  let offset = start;
  for (const ch of Array.from(characters)) {
    if (keep.has(ch)) {
      const last = runs[runs.length - 1];
      if (last && last.end === offset) last.end += ch.length;
      else runs.push({ start: offset, end: offset + ch.length });
    }
    offset += ch.length;
  }
  return runs;
}

// The parts of a segment to change: everything except the characters being kept.
function changeRunsOf(seg, keep) {
  const runs = [];
  let at = seg.start;
  for (const run of keepRunsOf(seg.characters, seg.start, keep)) {
    if (run.start > at) runs.push({ start: at, end: run.start });
    at = run.end;
  }
  if (at < seg.end) runs.push({ start: at, end: seg.end });
  return runs;
}

async function scanFonts(args, keep) {
  const scope = await resolveScope(args.scope);
  const available = await availableFonts();
  const toStyles = available[args.to];
  if (!toStyles) {
    const q = String(args.to).toLowerCase().slice(0, 3);
    const similar = Object.keys(available).filter((f) => f.toLowerCase().indexOf(q) >= 0).slice(0, 8);
    throw new Error('Figma can\'t see a font called "' + args.to + '".' + (similar.length ? ' Similar: ' + similar.join(', ') + '.' : ''));
  }
  const texts = await collectText(scope);
  const textIds = new Set(texts.map((t) => t.id));
  const mapping = {};
  const styleUse = {};
  const keepRuns = {};
  const components = new Map();
  const fontVariables = {};
  let matchedLayers = 0;
  let matchedSegments = 0;

  for (let i = 0; i < texts.length; i++) {
    if (i % 500 === 499) await pause();
    const node = texts[i];
    let matched = false;
    for (const seg of segmentsOf(node, ['fontName', 'textStyleId'])) {
      if (seg.fontName.family !== args.from) continue;
      matched = true;
      matchedSegments += 1;
      const fromStyle = seg.fontName.style;
      const entry = (mapping[fromStyle] = mapping[fromStyle] || Object.assign({ from: fromStyle, segments: 0, layers: {}, chars: {} }, mapStyle(fromStyle, toStyles, args.styleMap)));
      entry.segments += 1;
      entry.layers[node.id] = 1;
      for (const ch of Array.from(seg.characters)) {
        if (isBlank(ch)) continue;
        const c = (entry.chars[ch] = entry.chars[ch] || { layers: 0, sample: node.id });
        c.layers += 1;
      }
      if (keep) {
        const runs = keepRunsOf(seg.characters, seg.start, keep);
        if (runs.length) {
          const list = (keepRuns[node.id] = keepRuns[node.id] || []);
          runs.forEach((r) => list.push({ start: r.start, end: r.end, font: seg.fontName }));
        }
      }
      if (seg.textStyleId) styleUse[seg.textStyleId] = (styleUse[seg.textStyleId] || 0) + 1;
    }
    if (matched) {
      matchedLayers += 1;
      if (node.characters.length) {
        for (const seg of node.getStyledTextSegments(['fontName', 'boundVariables'])) {
          if (seg.fontName.family !== args.from || !seg.boundVariables) continue;
          for (const field of FONT_BINDINGS) {
            const alias = seg.boundVariables[field];
            if (alias) (fontVariables[alias.id] = fontVariables[alias.id] || {})[node.id] = 1;
          }
        }
      }
      if (node.id.charAt(0) !== 'I') {
        for (let a = node.parent; a && a.type !== 'PAGE'; a = a.parent) {
          if (a.type === 'COMPONENT') {
            components.set(a.id, a);
            break;
          }
        }
      }
    }
  }

  // What else uses these styles? A style used outside the scope is copied, not edited,
  // so the swap can't reach layers you didn't ask it to change.
  const outsideUse = {};
  const styleIds = Object.keys(styleUse);
  if (styleIds.length && (scope.normal.type !== 'document' || scope.exclude.length)) {
    await figma.loadAllPagesAsync();
    for (const { node } of allOtherText(textIds)) {
      for (const seg of node.getStyledTextSegments(['textStyleId'])) {
        if (seg.textStyleId && styleUse[seg.textStyleId]) outsideUse[seg.textStyleId] = (outsideUse[seg.textStyleId] || 0) + 1;
      }
    }
  }
  const styles = [];
  for (const id of styleIds) {
    const style = await figma.getStyleByIdAsync(id);
    if (!style || style.type !== 'TEXT') continue;
    const onFamily = style.fontName.family === args.from;
    const entry = {
      id,
      name: style.name,
      style,
      remote: Boolean(style.remote),
      segmentsInScope: styleUse[id],
      segmentsOutside: outsideUse[id] || 0,
      fontStyle: style.fontName.style,
    };
    if (!onFamily) entry.action = 'none';
    else {
      const mode = args.styleMode || 'auto';
      let published = false;
      if (!entry.remote && mode === 'auto') {
        try {
          published = (await style.getPublishStatusAsync()) !== 'UNPUBLISHED';
        } catch (err) {
          published = false;
        }
      }
      entry.published = published;
      if (entry.remote || mode === 'clone' || (mode === 'auto' && (entry.segmentsOutside || published))) entry.action = 'clone';
      else entry.action = 'edit';
      entry.toStyle = mapStyle(style.fontName.style, toStyles, args.styleMap).style;
    }
    styles.push(entry);
  }

  // Main components in the scope with instances outside it will change those instances too.
  const componentsOutside = [];
  for (const component of Array.from(components.values()).slice(0, 200)) {
    const instances = await component.getInstancesAsync();
    let outside = 0;
    for (const instance of instances) {
      const hasText = instance.findOne ? instance.findOne((n) => n.type === 'TEXT') : null;
      if (!hasText) continue;
      if (!textIds.has(hasText.id)) outside += 1;
    }
    if (outside) componentsOutside.push({ id: component.id, name: component.name, instancesOutside: outside });
  }

  const variables = [];
  for (const id of Object.keys(fontVariables)) {
    const variable = await figma.variables.getVariableByIdAsync(id);
    variables.push({ name: variable ? variable.name : id, layers: Object.keys(fontVariables[id]).length });
  }

  return { scope, texts, textIds, mapping, styles, toStyles, available, matchedLayers, matchedSegments, keepRuns, componentsOutside, fontVariables: variables };
}

async function fontScan(args) {
  const scan = await scanFonts(args, null);
  return {
    file: figma.root.name,
    scope: scan.scope.normal,
    label: scan.scope.label,
    textLayers: scan.texts.length,
    matchedLayers: scan.matchedLayers,
    matchedSegments: scan.matchedSegments,
    fromAvailable: Boolean(scan.available[args.from]),
    target: { family: args.to, styles: scan.toStyles },
    mapping: Object.keys(scan.mapping).map((k) => {
      const m = scan.mapping[k];
      return { from: m.from, to: m.style, kind: m.kind, note: m.note || null, segments: m.segments, layers: Object.keys(m.layers).length, chars: m.chars };
    }),
    styles: scan.styles.map((s) => ({
      name: s.name,
      remote: s.remote,
      published: Boolean(s.published),
      fontStyle: s.fontStyle,
      toStyle: s.toStyle || null,
      segmentsInScope: s.segmentsInScope,
      segmentsOutside: s.segmentsOutside,
      action: s.action,
    })),
    componentsOutside: scan.componentsOutside,
    fontVariables: scan.fontVariables,
  };
}

async function cloneStyle(source, prefix, family, toStyle, localByName) {
  const name = prefix + source.name;
  const existing = localByName.get(name);
  if (existing && existing.fontName.family === family) return existing;
  const clone = figma.createTextStyle();
  clone.name = name;
  clone.fontName = { family, style: toStyle };
  for (const prop of STYLE_PROPS) {
    try {
      clone[prop] = source[prop];
    } catch (err) {
      // Not every property exists on every file version.
    }
  }
  const bound = source.boundVariables || {};
  for (const field of Object.keys(bound)) {
    if (/^font(Family|Style|Weight)$/.test(field)) continue;
    try {
      clone.setBoundVariable(field, await figma.variables.getVariableByIdAsync(bound[field].id));
    } catch (err) {
      // The copy keeps the plain value.
    }
  }
  localByName.set(name, clone);
  return clone;
}

async function fontSwap(args) {
  if (args.expectedFile && args.expectedFile !== figma.root.name) {
    throw new Error('This swap was previewed on "' + args.expectedFile + '" but the open file is "' + figma.root.name + '".');
  }
  const started = Date.now();
  const keep = new Set(Array.from(args.keep || ''));
  const scan = await scanFonts(args, keep);
  const restoreName = args.restorePoint || 'Before Type Relay: ' + args.from + ' to ' + args.to;
  const version = await figma.saveVersionHistoryAsync(restoreName);
  const before = await outsideFingerprint(scan.scope, scan.textIds);

  // Resolves to false rather than failing: a font that won't load only matters if a layer
  // needs it, and that layer then reports its own error.
  const loads = new Map();
  const loadFont = (font) => {
    const key = font.family + '/' + font.style;
    if (!loads.has(key)) {
      loads.set(key, figma.loadFontAsync(font).then(() => true, () => false));
    }
    return loads.get(key);
  };
  await Promise.all(scan.toStyles.map((style) => loadFont({ family: args.to, style })));
  const sourceLoaded = {};
  for (const k of Object.keys(scan.mapping)) {
    sourceLoaded[k] = await loadFont({ family: args.from, style: k }); // A missing font can be replaced, but not kept.
  }

  const stats = { relinked: 0, hardCoded: 0, emptyLayers: 0, overridesRestored: 0, keptRanges: 0, keptOnlySegments: 0, stylesCloned: 0, stylesEdited: 0, keptNotPossible: 0 };
  const errors = [];
  const prefix = args.stylePrefix === undefined || args.stylePrefix === null ? args.to + '/' : args.stylePrefix;
  const local = await figma.getLocalTextStylesAsync();
  const localByName = new Map(local.map((s) => [s.name, s]));
  const clones = new Map();
  for (const entry of scan.styles) {
    if (entry.action === 'clone') {
      clones.set(entry.id, await cloneStyle(entry.style, prefix, args.to, entry.toStyle, localByName));
      stats.stylesCloned += 1;
    } else if (entry.action === 'edit') {
      entry.style.fontName = { family: args.to, style: entry.toStyle };
      stats.stylesEdited += 1;
    }
  }

  for (let i = 0; i < scan.texts.length; i++) {
    if (i % 200 === 199) await pause();
    const node = scan.texts[i];
    try {
      const segments = segmentsOf(node, SEGMENT_FIELDS);
      if (scan.keepRuns[node.id] || segments.some((seg) => seg.fontName.family === args.from)) {
        // Figma won't write to a layer until every font on it is loaded, not just the one changing.
        const fonts = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName];
        await Promise.all(fonts.map(loadFont));
      }
      for (const seg of segments) {
        if (seg.fontName.family !== args.from) continue;
        const mapped = mapStyle(seg.fontName.style, scan.toStyles, args.styleMap).style;
        const clone = seg.textStyleId ? clones.get(seg.textStyleId) : null;
        if (!seg.characters) {
          if (clone) await node.setTextStyleIdAsync(clone.id);
          else node.fontName = { family: args.to, style: mapped };
          stats.emptyLayers += 1;
          continue;
        }
        // Kept characters are left alone, so they stay linked to the old style.
        const keepHere = sourceLoaded[seg.fontName.style] ? keep : NOTHING;
        const chars = Array.from(seg.characters);
        if (chars.every((c) => keepHere.has(c) || isBlank(c)) && chars.some((c) => keepHere.has(c))) {
          stats.keptOnlySegments += 1;
          continue;
        }
        for (const run of changeRunsOf(seg, keepHere)) {
          if (clone) {
            await node.setRangeTextStyleIdAsync(run.start, run.end, clone.id);
            for (const key of Object.keys(RANGE_SETTERS)) {
              if (!same(seg[key], clone[key])) {
                node[RANGE_SETTERS[key]](run.start, run.end, seg[key]);
                stats.overridesRestored += 1;
              }
            }
            if (clone.fontName.style !== mapped) node.setRangeFontName(run.start, run.end, { family: args.to, style: mapped });
          } else {
            node.setRangeFontName(run.start, run.end, { family: args.to, style: mapped });
          }
        }
        stats[clone ? 'relinked' : 'hardCoded'] += 1;
      }
      // A style edited in place has already moved its text to the new font, so its kept
      // characters have to be put back, which ends their link to the style.
      for (const run of scan.keepRuns[node.id] || []) {
        if (!sourceLoaded[run.font.style]) {
          stats.keptNotPossible += 1;
          continue;
        }
        const current = node.getRangeFontName(run.start, run.end);
        if (current === figma.mixed || current.family !== args.from) {
          // Ending the style link also resets the paragraph settings it supplied.
          const paragraph = PARAGRAPH_SETTINGS.map((name) => node['getRange' + name](run.start, run.end));
          node.setRangeFontName(run.start, run.end, run.font);
          PARAGRAPH_SETTINGS.forEach((name, i) => {
            if (paragraph[i] !== figma.mixed) node['setRange' + name](run.start, run.end, paragraph[i]);
          });
          stats.keptRanges += 1;
        }
      }
    } catch (err) {
      errors.push({ id: node.id, name: node.name, error: String((err && err.message) || err).slice(0, 200) });
    }
  }

  // Anything still on the old font should only be the characters we chose to keep.
  const leftover = [];
  let keptLayers = 0;
  for (const node of scan.texts) {
    let kept = false;
    for (const seg of segmentsOf(node, ['fontName'])) {
      if (seg.fontName.family !== args.from) continue;
      const stray = Array.from(seg.characters).filter((c) => !keep.has(c) && !isBlank(c));
      if (stray.length || !seg.characters) leftover.push({ id: node.id, text: seg.characters.slice(0, 60) });
      else kept = true;
    }
    if (kept) keptLayers += 1;
  }

  const after = await outsideFingerprint(scan.scope, scan.textIds);
  const outside = before
    ? Object.keys(before).map((id) => ({
        page: before[id].page,
        layers: before[id].layers,
        instanceLayers: before[id].instanceLayers,
        changed: !after[id] || before[id].hash !== after[id].hash,
        instancesChanged: !after[id] || before[id].instanceHash !== after[id].instanceHash,
      }))
    : null;
  figma.commitUndo();
  return {
    restorePoint: { name: restoreName, id: version && version.id ? version.id : null },
    textLayers: scan.texts.length,
    matchedLayers: scan.matchedLayers,
    stats,
    keptLayers,
    leftoverCount: leftover.length,
    leftover: leftover.slice(0, SAMPLE_LIMIT),
    errorCount: errors.length,
    errors: errors.slice(0, SAMPLE_LIMIT),
    outside,
    ms: Date.now() - started,
  };
}

async function fontAudit(args) {
  const scope = await resolveScope(args.scope);
  const available = await availableFonts();
  const texts = await collectText(scope);
  const fonts = {};
  let missingLayers = 0;
  for (let i = 0; i < texts.length; i++) {
    if (i % 500 === 499) await pause();
    const node = texts[i];
    if (node.hasMissingFont) missingLayers += 1;
    for (const seg of segmentsOf(node, ['fontName', 'textStyleId'])) {
      const fam = (fonts[seg.fontName.family] = fonts[seg.fontName.family] || { family: seg.fontName.family, styles: {}, layerIds: {}, linked: 0, hardCoded: 0, samples: [] });
      const st = (fam.styles[seg.fontName.style] = fam.styles[seg.fontName.style] || { style: seg.fontName.style, segments: 0, available: (available[seg.fontName.family] || []).indexOf(seg.fontName.style) >= 0 });
      st.segments += 1;
      fam.layerIds[node.id] = 1;
      if (seg.textStyleId) fam.linked += 1;
      else fam.hardCoded += 1;
      if (fam.samples.length < 3 && fam.samples.every((x) => x.id !== node.id)) {
        fam.samples.push({ id: node.id, frame: topLevelOf(node).name, text: node.characters.slice(0, 40) });
      }
    }
  }
  const local = await figma.getLocalTextStylesAsync();
  const list = Object.keys(fonts)
    .map((k) => {
      const f = fonts[k];
      const styles = Object.keys(f.styles).map((s) => f.styles[s]);
      return {
        family: f.family,
        layers: Object.keys(f.layerIds).length,
        segmentsLinkedToStyles: f.linked,
        segmentsHardCoded: f.hardCoded,
        styles,
        missing: styles.filter((s) => !s.available).map((s) => s.style),
        localTextStyles: local.filter((s) => s.fontName.family === f.family).length,
        samples: f.samples,
      };
    })
    .sort((a, b) => b.layers - a.layers);
  return { file: figma.root.name, scope: scope.normal, label: scope.label, textLayers: texts.length, layersWithMissingFont: missingLayers, fonts: list };
}

function clippingOver(box, clip) {
  return Math.round(Math.max(box.x + box.width - (clip.x + clip.width), box.y + box.height - (clip.y + clip.height), clip.x - box.x, clip.y - box.y));
}

async function fontCheck(args) {
  const scope = await resolveScope(args.scope);
  const texts = await collectText(scope);
  const clipped = [];
  const overflow = [];
  let fixedBoxes = 0;
  for (let i = 0; i < texts.length; i++) {
    if (i % 500 === 499) await pause();
    const node = texts[i];
    if (!node.visible) continue;
    const box = node.absoluteBoundingBox;
    if (!box) continue;
    let hidden = false;
    let clipPx = 0;
    for (let a = node.parent; a && a.type !== 'PAGE'; a = a.parent) {
      if (a.visible === false) {
        hidden = true;
        break;
      }
      if (a.clipsContent && a.absoluteBoundingBox) clipPx = Math.max(clipPx, clippingOver(box, a.absoluteBoundingBox));
    }
    if (hidden) continue;
    if (node.textAutoResize === 'NONE' || node.textAutoResize === 'TRUNCATE') fixedBoxes += 1;
    if (clipPx > 1) clipped.push({ id: node.id, px: clipPx, frame: topLevelOf(node).name, text: node.characters.slice(0, 60) });
    else {
      const parent = node.parent.absoluteBoundingBox;
      if (parent) {
        const over = clippingOver(box, parent);
        if (over > 1) overflow.push({ id: node.id, px: over, frame: topLevelOf(node).name, text: node.characters.slice(0, 60) });
      }
    }
  }
  const excluded = new Set(scope.exclude);
  const pages = new Set();
  for (const root of scope.roots) {
    const page = root.type === 'PAGE' ? root : pageOf(root);
    if (page) pages.add(page);
  }
  const frames = [];
  const overlaps = [];
  pages.forEach((page) => {
    const tops = page.children
      .filter((c) => !excluded.has(c.id) && c.absoluteBoundingBox)
      .map((c) => ({ id: c.id, name: c.name, x: c.absoluteBoundingBox.x, y: c.absoluteBoundingBox.y, w: c.absoluteBoundingBox.width, h: c.absoluteBoundingBox.height }));
    tops.forEach((t) => frames.push(t));
    for (let i = 0; i < tops.length; i++) {
      for (let j = i + 1; j < tops.length; j++) {
        const a = tops[i];
        const b = tops[j];
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) overlaps.push({ a: a.id, b: b.id, names: a.name + ' / ' + b.name });
      }
    }
  });
  return { file: figma.root.name, label: scope.label, textLayers: texts.length, clipped, overflow, fixedBoxes, frames, overlaps };
}

var OPS = { run: runScript, export: exportNode, fonts: listFonts, fontScan: fontScan, fontSwap: fontSwap, fontAudit: fontAudit, fontCheck: fontCheck };

figma.ui.onmessage = async function (msg) {
  if (msg.type === 'ready') return sendInfo();
  if (msg.type !== 'command') return;
  var command = msg.command;
  var reply = { type: 'result', commandId: command.id };
  try {
    var op = OPS[command.op];
    if (!op) throw new Error('Unknown operation: ' + command.op);
    reply.result = await op(command.args || {});
    reply.ok = true;
  } catch (err) {
    reply.ok = false;
    reply.error = err && err.message ? err.message : String(err);
  }
  figma.ui.postMessage(reply);
};

figma.on('currentpagechange', sendInfo);
