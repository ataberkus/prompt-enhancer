// Prompt enhancer core: one read-only, locked-down agent run (`omp -p` or `claude -p`) that rewrites a draft into a
// repo-grounded spec. Host-agnostic: omp/index.mjs and claude/index.mjs are front ends; others can call runEnhance the same way.
// system.md, overlay.yml and guard.mjs come from omp-companion (companion/server.mjs ENHANCE_*); keep them in sync.
// system-fast.md and light-checks.md are this repo's own (`fast` and `notest` modes). claude-guard.mjs is guard.mjs's rules
// for Claude Code's tools; keep the two in step.
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
	systemFast: path.join(here, 'system-fast.md'),
	lightChecks: path.join(here, 'light-checks.md'),
	overlay: path.join(here, 'overlay.yml'),
	guard: path.join(here, 'guard.mjs'),
	claudeGuard: path.join(here, 'claude-guard.mjs'),
};

// A checkout with core.autocrlf has CRLF prompt files; the swaps below match LF.
const text = file => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
// Replaces the literal passage `from` once. A passage that is gone (say, system.md re-synced with new wording) fails the
// enhance instead of sending a prompt that still asks for tests.
function swap(prompt, from, to) {
	const i = prompt.indexOf(from);
	if (i === -1) throw new Error(`Prompt passage not found: "${from.trim().slice(0, 60)}…"; update the mode swaps in core/enhance.mjs.`);
	return prompt.slice(0, i) + to + prompt.slice(i + from.length);
}
const lightChecks = () => text(files.lightChecks).trimEnd();
// system.md's Done when checks (they add tests) and its bug-fix regression check, which `notest` replaces.
const FULL_CHECKS = [
	'   - the repository\'s own checks pass: a test, build, typecheck or lint command you saw in its scripts, test files or docs. Add tests for the new behaviour where the repo already has a test setup; if it has none, the check is its build or a short script, and the agent does not set up a test framework;',
	'   - the check runs in a few minutes without a person (never a manual browser, device or network-tab check). Tell the agent to run it before it finishes.',
].join('\n');
const FULL_REGRESSION = ', and include a regression check in Done when.';

// Per mode: the system prompt text and the lookup limit.
// `full`: the complete spec; its Done when adds tests (system.md, 12 lookups).
// `notest`: the same spec and Inferred requirements, with the checks swapped for light-checks.md: the repo's existing
// automated checks only, no new tests, no smoke runs (12 lookups).
// `fast`: a lean prompt with the same light checks (system-fast.md, 6 lookups).
export const modes = {
	full: { lookups: 12, prompt: () => text(files.system) },
	notest: {
		lookups: 12,
		prompt: () => swap(swap(text(files.system), FULL_CHECKS, lightChecks()), FULL_REGRESSION, '; Done when adds no new regression test unless the draft asks for one.'),
	},
	fast: { lookups: 6, prompt: () => swap(text(files.systemFast), '{{light-checks}}', lightChecks()) },
};
// guard.mjs runs inside the omp child, so it gets its lookup limit through the environment.
export const LOOKUP_LIMIT_ENV = 'PROMPT_ENHANCER_LOOKUP_LIMIT';

// The draft never goes in argv (stdin only): no quoting hazards and no Windows 32K command-line limit.
// --system-prompt replaces OMP's coding-agent prompt (omp takes a value with a newline as the text, not a file path); the
// overlay turns off every discovery provider and non-lookup tool; the guard (-e loads even under --no-extensions) confines
// read/grep/glob to the repository and the mode's lookup limit. Images go as `@file` arguments, which omp attaches as
// image blocks after the stdin text, in argv order.
export function ompArgs({ model, thinking, images = [], mode = 'full' } = {}) {
	return ['-p', '--mode', 'json', '--no-session', '--no-title', '--no-skills', '--no-extensions', '--no-rules', '--no-lsp',
		'--tools=read,grep,glob', '--approval-mode=always-ask', '--max-time=240', `--config=${files.overlay}`, '-e', files.guard,
		...(model ? [`--model=${model}`] : []), ...(thinking ? [`--thinking=${thinking}`] : []), `--system-prompt=${modes[mode].prompt()}`,
		...images.map(({ file }) => `@${path.resolve(file)}`)];
}

// --setting-sources '' loads no settings files, so no user hooks, plugins or MCP config; --strict-mcp-config drops the
// rest of MCP. Only Read/Grep/Glob exist, and claude-guard.mjs (a PreToolUse hook from --settings, which still loads)
// allows or denies each call, counting lookups in `lookups` against the mode's limit. dontAsk denies anything the guard leaves undecided.
export function claudeArgs({ model, thinking, lookups, images = [], mode = 'full' } = {}) {
	const q = p => `"${p.replace(/\\/g, '/')}"`; // forward slashes and double quotes work in both Git Bash and PowerShell
	const { prompt, lookups: limit } = modes[mode];
	const settings = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node ${q(files.claudeGuard)} ${q(lookups)} ${limit}`, timeout: 30 }] }] } };
	return ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config',
		'--disable-slash-commands', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--settings', JSON.stringify(settings),
		...(images.length ? ['--input-format', 'stream-json'] : []),
		...(model ? ['--model', model] : []), ...(thinking ? ['--effort', thinking] : []), '--system-prompt', prompt()];
}

export const MEDIA = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
function imageMedia(file) {
	const media = MEDIA[path.extname(file).slice(1).toLowerCase()];
	if (!media) throw new Error(`Not a supported image (png, jpg, gif, webp): ${file}`);
	return media;
}
// Images ride in one stream-json user message (text stdin cannot carry them), each after its label: the path as the draft wrote it.
// images: [{ label, file }].
export function claudeInput(text, images = []) {
	if (!images.length) return text;
	const content = images.flatMap(({ label, file }) => [{ type: 'text', text: label },
		{ type: 'image', source: { type: 'base64', media_type: imageMedia(file), data: readFileSync(file).toString('base64') } }]);
	return JSON.stringify({ type: 'user', message: { role: 'user', content: [...content, { type: 'text', text }] } }) + '\n';
}

// omp cannot interleave text and images in its prompt: the `@file` images (ompArgs) follow the stdin text, each announced by
// a `<file name="…">` line in the same order. The list ties each label (`[Image #N]`) to its place in that order.
export function ompInput(text, images = []) {
	if (!images.length) return text;
	for (const { file } of images) imageMedia(file);
	const list = images.map(({ label, file }, i) => `${label}: attached image ${i + 1} (${path.resolve(file)})`);
	return `${text}\n<images>\n${list.join('\n')}\n</images>`;
}

// Per engine: the default binary, its argv, and how one JSON output line reports a lookup, the answer or a failure.
export const engines = {
	omp: {
		bin: 'omp', args: ompArgs, input: ompInput,
		event(f, on) {
			if (f.type === 'tool_execution_start') on.step(f.toolName, f.args);
			else if (f.type === 'message_end' && f.message?.role === 'assistant') on.answer(contentText(f.message.content));
		},
	},
	claude: {
		bin: 'claude', args: claudeArgs, input: claudeInput,
		event(f, on) {
			if (f.type === 'assistant') for (const c of f.message?.content || []) { if (c?.type === 'tool_use') on.step(c.name, c.input); }
			// A refused request (401/403: wrong account, organization or token) carries its HTTP status and error code.
			else if (f.type === 'result') f.is_error || f.subtype !== 'success' ? on.error(String(f.result || f.subtype), f.api_error_status ? { status: f.api_error_status, code: f.api_error_code } : undefined) : on.answer(String(f.result ?? ''));
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

// Resolves with the enhanced prompt; rejects with an Error (name 'AbortError' when `signal` aborted it; `api` = { status, code }
// when the API refused the run). `engine` is a key of `engines`, `mode` a key of `modes`; `bin` overrides its binary; `env` is
// added to the child's environment.
export function runEnhance({ draft, messages = [], images = [], cwd, engine = 'omp', mode = 'full', bin, env, model, thinking, signal, onStep = () => {} }) {
	return new Promise((resolve, reject) => {
		const eng = engines[engine];
		if (!eng) throw new Error(`Unknown enhance engine: ${engine}`);
		if (!modes[mode]) throw new Error(`Unknown enhance mode: ${mode}`);
		if (images.length && !eng.input) throw new Error(`The ${engine} engine takes no images.`);
		const stdin = eng.input ? eng.input(enhanceInput(draft, messages), images) : enhanceInput(draft, messages);
		const lookups = path.join(os.tmpdir(), `prompt-enhancer-${randomUUID()}.lookups`);
		const child = spawn(bin || eng.bin, eng.args({ model, thinking, lookups, images, mode }), {
			cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
			env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0', [LOOKUP_LIMIT_ENV]: String(modes[mode].lookups) },
		});
		let stderr = '', answer = '', failure = '', api, timedOut = false, done = false;
		const kill = () => child.kill();
		const timer = setTimeout(() => { timedOut = true; kill(); }, 270_000);
		signal?.addEventListener('abort', kill, { once: true });
		if (signal?.aborted) kill();
		child.stdin.on('error', () => {});
		child.stdin.end(stdin, 'utf8');
		child.stderr.on('data', b => { stderr = (stderr + b).slice(-8000); });
		const on = { step: (name, args) => onStep(stepLabel(name, args, cwd)), answer: t => { answer = t; }, error: (m, a) => { failure = m; api = a; } };
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
			else reject(Object.assign(new Error(err?.message || failure || stderr.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map(l => l.trim()).find(l => l && !/^warning:/i.test(l)) || `${engine} exited (${code}).`), !err && failure && api ? { api } : {}));
		};
		child.on('error', e => finish(null, e));
		child.on('close', code => finish(code));
	});
}
