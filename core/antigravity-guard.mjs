// PreToolUse hook for the `agy -p` engine: the Antigravity counterpart of guard.mjs and claude-guard.mjs, same rules.
// Read, grep and glob lookups only, inside the repository, no .env files, at most `limit` lookups (12 by default).
// argv[2] (or PROMPT_ENHANCER_GUARD_COUNTER) is the file that counts this run's lookups; argv[3] (or
// PROMPT_ENHANCER_LOOKUP_LIMIT) is the limit. When neither is set (a normal user session), outputs `{}` and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED = new Set(['view_file', 'read_file', 'grep_search', 'find_by_name', 'read', 'grep', 'glob']);
const GLOB_TOOLS = new Set(['find_by_name', 'glob']);
const OUTSIDE = 'Enhance guard: only paths inside this repository can be looked up; keep the reference as the user wrote it.';
const SECRET = /^\.env(?:\.(?!example$|sample$|template$|dist$)[^\\/]*)?$/i;

function real(p) {
	let cur = p; const rest = [];
	for (;;) { try { return path.join(fs.realpathSync.native(cur), ...rest); } catch { const up = path.dirname(cur); if (up === cur) return p; rest.unshift(path.basename(cur)); cur = up; } }
}
function inside(root, p) { const rel = path.relative(root, p); return rel === '' || rel.split(/[\\/]/)[0] !== '..' && !path.isAbsolute(rel); }

// Why a lookup is refused, or '' when it may run. `root` is the repository's real path.
export function refuse(tool, input, root) {
	const name = String(tool || '').toLowerCase();
	if (!ALLOWED.has(name)) return `Enhance guard: ${tool || 'unknown'} is not available here.`;
	const a = input || {};
	const raw = [
		a.AbsolutePath, a.Path, a.SearchPath, a.SearchDirectory, a.Directory,
		a.file_path, a.path,
		GLOB_TOOLS.has(name) ? (a.Pattern ?? a.pattern) : null,
	].filter(p => typeof p === 'string' && p.trim());
	for (const t of raw.map(p => p.trim())) {
		if (/^[a-z][a-z0-9+.-]+:/i.test(t) || t.startsWith('~')) return OUTSIDE;
		if (t.split(/[\\/]/).includes('..')) return OUTSIDE;
		if (SECRET.test(path.basename(t))) return 'Enhance guard: .env files are not looked up.';
		if (!inside(root, real(path.resolve(root, t.replace(/[*?[{].*$/, '') || '.')))) return OUTSIDE;
	}
	return '';
}

// Counts the call in `counter` (one byte per lookup) and returns the Antigravity PreToolUse decision.
export function decide(hookInput, counter, limit = 12) {
	let why;
	try {
		fs.appendFileSync(counter, '.');
		const toolCall = hookInput?.toolCall || {};
		const name = toolCall.name ?? hookInput?.tool_name;
		const args = toolCall.args ?? hookInput?.tool_input ?? {};
		why = fs.statSync(counter).size > limit ? 'Enhance guard: the lookup limit is used up; write the prompt with what you found.'
			: refuse(name, args, real(path.resolve(hookInput?.cwd || process.cwd())));
	} catch (e) {
		why = `Enhance guard: ${e.message}`;
	}
	return { decision: why ? 'deny' : 'allow', reason: why || 'Enhance guard: lookup allowed.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
	const counter = process.argv[2] || process.env.PROMPT_ENHANCER_GUARD_COUNTER;
	const limit = Number(process.argv[3] || process.env.PROMPT_ENHANCER_LOOKUP_LIMIT) || undefined;
	if (!counter) {
		process.stdout.write('{}');
	} else {
		let raw = '';
		for await (const chunk of process.stdin) raw += chunk;
		let input = null;
		try { input = JSON.parse(raw); } catch {}
		process.stdout.write(JSON.stringify(input ? decide(input, counter, limit) : { decision: 'deny', reason: 'Enhance guard: unreadable hook input.' }));
	}
}
