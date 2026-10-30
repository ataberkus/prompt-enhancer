// Prompt enhancer core: one read-only, locked-down agent run (`omp -p` or `claude -p`) that rewrites a draft into a
// repo-grounded spec. Host-agnostic: omp/index.mjs and claude/index.mjs are front ends; others can call runEnhance the same way.
// system.md, overlay.yml and guard.mjs come from omp-companion (companion/server.mjs ENHANCE_*); keep them in sync.
// claude-guard.mjs is guard.mjs's rules for Claude Code's tools; keep the two in step.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const files = {
	system: path.join(here, 'system.md'),
	overlay: path.join(here, 'overlay.yml'),
	guard: path.join(here, 'guard.mjs'),
	claudeGuard: path.join(here, 'claude-guard.mjs'),
};

// The draft never goes in argv (stdin only): no quoting hazards and no Windows 32K command-line limit.
// --system-prompt replaces OMP's coding-agent prompt; the overlay turns off every discovery provider and non-lookup tool;
// the guard (-e loads even under --no-extensions) confines read/grep/glob to the repository and 12 lookups.
export function ompArgs({ model, thinking } = {}) {
	return ['-p', '--mode', 'json', '--no-session', '--no-title', '--no-skills', '--no-extensions', '--no-rules', '--no-lsp',
		'--tools=read,grep,glob', '--approval-mode=always-ask', '--max-time=240', `--config=${files.overlay}`, '-e', files.guard,
		...(model ? [`--model=${model}`] : []), ...(thinking ? [`--thinking=${thinking}`] : []), `--system-prompt=${files.system}`];
}

// --setting-sources '' loads no settings files, so no user hooks, plugins or MCP config; --strict-mcp-config drops the
// rest of MCP. Only Read/Grep/Glob exist, and claude-guard.mjs (a PreToolUse hook from --settings, which still loads)
// allows or denies each call, counting lookups in `lookups`. dontAsk denies anything the guard leaves undecided.
export function claudeArgs({ model, thinking, lookups, images = [] } = {}) {
	const q = p => `"${p.replace(/\\/g, '/')}"`; // forward slashes and double quotes work in both Git Bash and PowerShell
	const settings = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node ${q(files.claudeGuard)} ${q(lookups)}`, timeout: 30 }] }] } };
	return ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config',
		'--disable-slash-commands', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--settings', JSON.stringify(settings),
		...(images.length ? ['--input-format', 'stream-json'] : []),
		...(model ? ['--model', model] : []), ...(thinking ? ['--effort', thinking] : []), '--system-prompt', readFileSync(files.system, 'utf8')];
}

const MEDIA = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
// Images ride in one stream-json user message (text stdin cannot carry them), each after its label: the path as the draft wrote it.
// images: [{ label, file }].
export function claudeInput(text, images = []) {
	if (!images.length) return text;
	const content = images.flatMap(({ label, file }) => {
		const media = MEDIA[path.extname(file).slice(1).toLowerCase()];
		if (!media) throw new Error(`Not a supported image (png, jpg, gif, webp): ${file}`);
		return [{ type: 'text', text: label }, { type: 'image', source: { type: 'base64', media_type: media, data: readFileSync(file).toString('base64') } }];
	});
	return JSON.stringify({ type: 'user', message: { role: 'user', content: [...content, { type: 'text', text }] } }) + '\n';
}

// Per engine: the default binary, its argv, and how one JSON output line reports a lookup, the answer or a failure.
export const engines = {
	omp: {
		bin: 'omp', args: ompArgs,
		event(f, on) {
			if (f.type === 'tool_execution_start') on.step(f.toolName, f.args);
			else if (f.type === 'message_end' && f.message?.role === 'assistant') on.answer(contentText(f.message.content));
		},
	},
	claude: {
		bin: 'claude', args: claudeArgs, input: claudeInput,
		event(f, on) {
			if (f.type === 'assistant') for (const c of f.message?.content || []) { if (c?.type === 'tool_use') on.step(c.name, c.input); }
			else if (f.type === 'result') f.is_error || f.subtype !== 'success' ? on.error(String(f.result || f.subtype)) : on.answer(String(f.result ?? ''));
		},
	},
};

export function contentText(content) {
	if (typeof content === 'string') return content;
	return Array.isArray(content) ? content.filter(c => c?.type === 'text').map(c => c.text).join('\n') : '';
}

// omp session branch entries → [{role, text}] for enhanceInput; tool results, custom messages and summaries are not the chat.
export function branchMessages(entries) {
	const out = [];
	for (const e of entries || []) {
		const role = e?.type === 'message' ? e.message?.role : null;
		if (role !== 'user' && role !== 'assistant') continue;
		const text = contentText(e.message.content).trim();
		if (text) out.push({ role, text });
	}
	return out;
}

// The last 6 turns, each run of assistant messages reduced to its last (the reply the user saw). Clips keep both ends: the
// start holds the ask or context, the end of a reply its options and question; the latest reply gets the most room.
// Tag lookalikes inside messages are defused so quoted text cannot close <conversation> or open a <draft>.
export function enhanceInput(draft, messages) {
	const chat = messages.filter(m => m.role === 'user' || m.role === 'assistant');
	const tail = chat.filter((m, i) => m.role === 'user' || chat[i + 1]?.role !== 'assistant').slice(-6);
	const latest = tail.findLastIndex(m => m.role === 'assistant');
	const clip = (t, n) => (t.length > n ? `${t.slice(0, n / 2)}\n[…]\n${t.slice(-n / 2)}` : t);
	const defuse = t => t.replace(/<(\/?)(conversation|draft)>/gi, '‹$1$2›');
	const lines = tail.map((m, i) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${defuse(clip(String(m.text || ''), i === latest ? 6000 : 1500))}`);
	return (lines.length ? `<conversation>\n${lines.join('\n')}\n</conversation>\n` : '') + `<draft>\n${defuse(String(draft))}\n</draft>`;
}

// omp's tools are read/grep/glob with `path`; Claude Code's are Read/Grep/Glob with `file_path`.
export function stepLabel(toolName, args, cwd) {
	const a = args || {}, tool = String(toolName || '').toLowerCase(), file = a.path ?? a.file_path;
	let s;
	if (tool === 'read') s = 'reading ' + (file ? path.relative(cwd, path.resolve(cwd, String(file))).replace(/\\/g, '/') || '.' : 'a file');
	else if (tool === 'grep') s = `searching "${a.pattern ?? ''}"`;
	else if (tool === 'glob') s = 'listing ' + (a.pattern ?? 'files');
	else s = String(toolName || 'working');
	return s.length > 80 ? s.slice(0, 79) + '…' : s;
}

// Unwraps a prompt the model fenced as a whole (```markdown … ```), not one that merely starts with a code block.
export function cleanEnhanced(text) {
	const t = String(text || '').trim(), lines = t.split('\n'), open = lines[0].match(/^(`{3,}|~{3,})\s*([^`]*)$/);
	if (!open) return t;
	const closes = l => new RegExp(`^\\${open[1][0]}{${open[1].length},}\\s*$`).test(l.trim());
	const end = lines.findIndex((l, i) => i > 0 && closes(l));
	const wraps = end === -1 || end === lines.length - 1 || (/^(markdown|md)$/i.test(open[2].trim()) && closes(lines.at(-1)));
	return wraps ? lines.slice(1, end === -1 ? undefined : -1).join('\n').trim() : t;
}

// Resolves with the enhanced prompt; rejects with an Error (name 'AbortError' when `signal` aborted it).
// `engine` is a key of `engines`; `bin` overrides its binary.
export function runEnhance({ draft, messages = [], images = [], cwd, engine = 'omp', bin, model, thinking, signal, onStep = () => {} }) {
	return new Promise((resolve, reject) => {
		const eng = engines[engine];
		if (!eng) throw new Error(`Unknown enhance engine: ${engine}`);
		if (images.length && !eng.input) throw new Error(`The ${engine} engine takes no images.`);
		const stdin = eng.input ? eng.input(enhanceInput(draft, messages), images) : enhanceInput(draft, messages);
		const lookups = path.join(os.tmpdir(), `prompt-enhancer-${randomUUID()}.lookups`);
		const child = spawn(bin || eng.bin, eng.args({ model, thinking, lookups, images }), {
			cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
		});
		let stderr = '', answer = '', failure = '', timedOut = false, done = false;
		const kill = () => child.kill();
		const timer = setTimeout(() => { timedOut = true; kill(); }, 270_000);
		signal?.addEventListener('abort', kill, { once: true });
		if (signal?.aborted) kill();
		child.stdin.on('error', () => {});
		child.stdin.end(stdin, 'utf8');
		child.stderr.on('data', b => { stderr = (stderr + b).slice(-8000); });
		const on = { step: (name, args) => onStep(stepLabel(name, args, cwd)), answer: t => { answer = t; }, error: m => { failure = m; } };
		createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
			let f;
			try { f = JSON.parse(line); } catch { return; }
			eng.event(f, on);
		});
		const finish = (code, err) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', kill);
			rmSync(lookups, { force: true });
			const out = cleanEnhanced(answer);
			if (signal?.aborted) reject(Object.assign(new Error('Enhance cancelled.'), { name: 'AbortError' }));
			else if (timedOut) reject(new Error('Enhance timed out.'));
			else if (code === 0 && !err && !failure && out) resolve(out);
			else if (code === 0 && !err && !failure) reject(new Error('The enhancer returned no text.'));
			// OMP prints the error first and a "Run `omp …`" hint after it; skip warnings (e.g. MCP connect failures).
			else reject(new Error(err?.message || failure || stderr.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map(l => l.trim()).find(l => l && !/^warning:/i.test(l)) || `${engine} exited (${code}).`));
		};
		child.on('error', e => finish(null, e));
		child.on('close', code => finish(code));
	});
}
