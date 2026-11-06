// Asks macOS which characters a font really contains. Figma's plugin API can't tell you,
// and Figma silently falls back to another font for anything missing.
// Uses osascript and AppKit, both built into macOS, so there's nothing to install.

import { execFile } from 'node:child_process';

const SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  const requests = JSON.parse(argv[0]);
  const manager = $.NSFontManager.sharedFontManager;
  const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return JSON.stringify(requests.map((r) => {
    const members = manager.availableMembersOfFontFamily(r.family);
    if (members.isNil()) return { found: false };
    const list = ObjC.deepUnwrap(members);
    const hit = list.find((m) => clean(m[1]) === clean(r.style));
    const font = $.NSFont.fontWithNameSize((hit || list[0])[0], 12);
    if (font.isNil()) return { found: false };
    const set = font.coveredCharacterSet;
    return { found: true, exactStyle: Boolean(hit), missing: r.codes.filter((c) => !set.longCharacterIsMember(c)) };
  }));
}`;

// requests: [{ family, style, codes: [code points] }]
// Returns one { found, exactStyle, missing } per request, or null where the check can't run.
export function checkCoverage(requests) {
  if (process.platform !== 'darwin' || !requests.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', SCRIPT, JSON.stringify(requests)],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      },
    );
  });
}
