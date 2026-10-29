// Prompt enhancer core: one read-only `omp -p` run that rewrites a draft into a repo-grounded spec.
// Host-agnostic: the omp extension (omp/index.mjs) is one front end; other agents can call runEnhance the same way.
// system.md, overlay.yml and guard.mjs come from omp-companion (companion/server.mjs ENHANCE_*); keep them in sync.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const files = {
	system: path.join(here, 'system.md'),
	overlay: path.join(here, 'overlay.yml'),
	guard: path.join(here, 'guard.mjs'),
};

// The draft never goes in argv (stdin only): no quoting hazards and no Windows 32K command-line limit.
// --system-prompt replaces OMP's coding-agent prompt; the overlay turns off every discovery provider and non-lookup tool;
// the guard (-e loads even under --no-extensions) confines read/grep/glob to the repository and 12 lookups.
export function enhanceArgs({ model, thinking } = {}) {
	return ['-p', '--mode', 'json', '--no-session', '--no-title', '--no-skills', '--no-extensions', '--no-rules', '--no-lsp',
		'--tools=read,grep,glob', '--approval-mode=always-ask', '--max-time=240', `--config=${files.overlay}`, '-e', files.guard,
		...(model ? [`--model=${model}`] : []), ...(thinking ? [`--thinking=${thinking}`] : []), `--system-prompt=${files.system}`];
}

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

export function stepLabel(toolName, args, cwd) {
	const a = args || {};
	let s;
	if (toolName === 'read') s = 'reading ' + (a.path ? path.relative(cwd, path.resolve(cwd, String(a.path))).replace(/\\/g, '/') || '.' : 'a file');
	else if (toolName === 'grep') s = `searching "${a.pattern ?? ''}"`;
	else if (toolName === 'glob') s = 'listing ' + (a.pattern ?? 'files');
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
export function runEnhance({ draft, messages = [], cwd, omp = 'omp', model, thinking, signal, onStep = () => {} }) {
	return new Promise((resolve, reject) => {
		const child = spawn(omp, enhanceArgs({ model, thinking }), {
			cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
		});
		let stderr = '', answer = '', timedOut = false, done = false;
		const kill = () => child.kill();
		const timer = setTimeout(() => { timedOut = true; kill(); }, 270_000);
		signal?.addEventListener('abort', kill, { once: true });
		if (signal?.aborted) kill();
		child.stdin.on('error', () => {});
		child.stdin.end(enhanceInput(draft, messages), 'utf8');
		child.stderr.on('data', b => { stderr = (stderr + b).slice(-8000); });
		createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
			let f;
			try { f = JSON.parse(line); } catch { return; }
			if (f.type === 'tool_execution_start') onStep(stepLabel(f.toolName, f.args, cwd));
			else if (f.type === 'message_end' && f.message?.role === 'assistant') answer = contentText(f.message.content);
		});
		const finish = (code, err) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', kill);
			const out = cleanEnhanced(answer);
			if (signal?.aborted) reject(Object.assign(new Error('Enhance cancelled.'), { name: 'AbortError' }));
			else if (timedOut) reject(new Error('Enhance timed out.'));
			else if (code === 0 && !err && out) resolve(out);
			else if (code === 0 && !err) reject(new Error('The enhancer returned no text.'));
			// OMP prints the error first and a "Run `omp …`" hint after it; skip warnings (e.g. MCP connect failures).
			else reject(new Error(err?.message || stderr.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map(l => l.trim()).find(l => l && !/^warning:/i.test(l)) || `omp exited (${code}).`));
		};
		child.on('error', e => finish(null, e));
		child.on('close', code => finish(code));
	});
}
