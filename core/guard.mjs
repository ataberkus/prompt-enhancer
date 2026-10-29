import * as fs from 'node:fs';
import * as path from 'node:path';
const LIMIT = 12, ALLOWED = new Set(['read', 'grep', 'glob']);
const OUTSIDE = 'Enhance guard: only paths inside this repository can be looked up; keep the reference as the user wrote it.';
const SECRET = /^\.env(?:\.(?!example$|sample$|template$|dist$)[^\\/]*)?$/i;
function real(p) {
 let cur = p; const rest = [];
 for (;;) { try { return path.join(fs.realpathSync.native(cur), ...rest); } catch { const up = path.dirname(cur); if (up === cur) return p; rest.unshift(path.basename(cur)); cur = up; } }
}
function inside(root, p) { const rel = path.relative(root, p); return rel === '' || rel.split(/[\\/]/)[0] !== '..' && !path.isAbsolute(rel); }
function refuse(tool, input, root) {
 if (!ALLOWED.has(tool)) return 'Enhance guard: ' + tool + ' is not available here.';
 if (tool === 'grep' && input.gitignore === false) return 'Enhance guard: ignored files are not searched.';
 const raw = [input.path, input.paths].flat().filter(p => typeof p === 'string');
 for (let t of raw.flatMap(p => p.split(';')).map(s => s.trim()).filter(Boolean)) {
  if (/^[a-z][a-z0-9+.-]+:/i.test(t) || t.startsWith('~')) return OUTSIDE;
  if (tool === 'read') t = t.replace(/(?::(?:raw|img|conflicts|-?\d[\d,+-]*))+$/, '');
  if (t.split(/[\\/]/).includes('..')) return OUTSIDE;
  if (SECRET.test(path.basename(t))) return 'Enhance guard: .env files are not looked up.';
  if (!inside(root, real(path.resolve(root, t.replace(/[*?[{].*$/, '') || '.')))) return OUTSIDE;
 }
 return '';
}
export default function (pi) {
 let calls = 0;
 pi.on('tool_call', async (event, ctx) => {
  if (++calls > LIMIT) return { block: true, reason: 'Enhance guard: the lookup limit is used up; write the prompt with what you found.' };
  const why = refuse(event.toolName, event.input || {}, real(ctx?.cwd || process.cwd()));
  return why ? { block: true, reason: why } : undefined;
 });
}
