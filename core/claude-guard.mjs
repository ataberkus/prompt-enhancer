// PreToolUse hook for the `claude -p` engine: the Claude Code counterpart of guard.mjs, same rules. Read, Grep and Glob
// only, inside the repository, no .env files, at most 12 lookups. argv[2] is the file that counts this run's lookups.
// Every call gets an explicit allow or deny, and anything unexpected denies.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LIMIT = 12, ALLOWED = new Set(['Read', 'Grep', 'Glob']);
const OUTSIDE = 'Enhance guard: only paths inside this repository can be looked up; keep the reference as the user wrote it.';
const SECRET = /^\.env(?:\.(?!example$|sample$|template$|dist$)[^\\/]*)?$/i;

function real(p) {
	let cur = p; const rest = [];
	for (;;) { try { return path.join(fs.realpathSync.native(cur), ...rest); } catch { const up = path.dirname(cur); if (up === cur) return p; rest.unshift(path.basename(cur)); cur = up; } }
}
function inside(root, p) { const rel = path.relative(root, p); return rel === '' || rel.split(/[\\/]/)[0] !== '..' && !path.isAbsolute(rel); }

// Why a lookup is refused, or '' when it may run. `root` is the repository's real path.
export function refuse(tool, input, root) {
	if (!ALLOWED.has(tool)) return `Enhance guard: ${tool} is not available here.`;
	const raw = [input.file_path, input.path, tool === 'Glob' ? input.pattern : null].filter(p => typeof p === 'string' && p.trim());
	for (const t of raw.map(p => p.trim())) {
		if (/^[a-z][a-z0-9+.-]+:/i.test(t) || t.startsWith('~')) return OUTSIDE;
		if (t.split(/[\\/]/).includes('..')) return OUTSIDE;
		if (SECRET.test(path.basename(t))) return 'Enhance guard: .env files are not looked up.';
		if (!inside(root, real(path.resolve(root, t.replace(/[*?[{].*$/, '') || '.')))) return OUTSIDE;
	}
	return '';
}

// Counts the call in `counter` (one byte per lookup) and returns the PreToolUse decision.
export function decide(hookInput, counter) {
	let why;
	try {
		fs.appendFileSync(counter, '.');
		why = fs.statSync(counter).size > LIMIT ? 'Enhance guard: the lookup limit is used up; write the prompt with what you found.'
			: refuse(hookInput.tool_name, hookInput.tool_input || {}, real(path.resolve(hookInput.cwd || process.cwd())));
	} catch (e) {
		why = `Enhance guard: ${e.message}`;
	}
	return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: why ? 'deny' : 'allow', permissionDecisionReason: why || 'Enhance guard: lookup allowed.' } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
	let raw = '';
	for await (const chunk of process.stdin) raw += chunk;
	let input = null;
	try { input = JSON.parse(raw); } catch {}
	process.stdout.write(JSON.stringify(input ? decide(input, process.argv[2]) : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Enhance guard: unreadable hook input.' } }));
}
