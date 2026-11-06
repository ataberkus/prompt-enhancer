// Claude Code front end: a UserPromptSubmit and a UserPromptExpansion hook (hooks/hooks.json). A prompt starting with `::e`
// (`::en` for the no-test mode, `::ef` for the fast mode), or `/enhance <draft>` (`/enhance-notest`, `/enhance-fast`), never
// reaches Claude; a separate locked-down `claude -p` run rewrites the draft, and the hook blocks the submit with the enhanced
// prompt as its message, also copied to the clipboard. Needs only Claude Code and node; no omp.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { contentText, runEnhance } from '../core/enhance.mjs';

// Prompt markers and their modes (core/enhance.mjs `modes`); the slash commands are /enhance, /enhance-notest, /enhance-fast.
export const MARKERS = { '::e': 'full', '::en': 'notest', '::ef': 'fast' };
export const ENV = { claude: 'PROMPT_ENHANCER_CLAUDE', model: 'PROMPT_ENHANCER_MODEL', effort: 'PROMPT_ENHANCER_EFFORT', token: 'PROMPT_ENHANCER_OAUTH_TOKEN' };

// Claude Code withholds the session's sign-in (CLAUDE_CODE_OAUTH_TOKEN) from hooks, so `claude -p` signs in with the login
// stored for that claude, which may be another account or organization than the session's (the desktop app's sessions run on its own).
// PROMPT_ENHANCER_OAUTH_TOKEN (from `claude setup-token`) goes to the child as its sign-in.
export function enhanceEnv(env = process.env) {
	return env[ENV.token] ? { CLAUDE_CODE_OAUTH_TOKEN: env[ENV.token] } : {};
}

// → { mode, draft } with the draft after the marker ('' when nothing follows it), or null when the prompt is not an enhance request.
export function parseDraft(prompt) {
	const m = String(prompt ?? '').match(/^\s*(::e[nf]?)(?:\s+([\s\S]*))?$/);
	return m ? { mode: MARKERS[m[1]], draft: (m[2] ?? '').trim() } : null;
}

// The enhance request in a hook payload, or null. `/enhance[-notest|-fast] <draft>` arrives as UserPromptExpansion (hooks.json
// matches only those commands, as `prompt-enhancer:enhance…`); `::e`, `::en` or `::ef <draft>` as UserPromptSubmit.
export function hookRequest(input) {
	if (input?.hook_event_name !== 'UserPromptExpansion') return parseDraft(input?.prompt);
	const m = String(input.command_name ?? '').match(/enhance-(notest|fast)$/);
	return { mode: m ? m[1] : 'full', draft: String(input.command_args ?? '').trim() };
}

// Images are file paths written in the draft (`shot.png`, `@shots/a.jpg`, `"C:\My shots\a.webp"`), relative to the session's
// folder or absolute; a path to no file is left as text (it may name a file to create). Returns [{ label, file }] in draft
// order. Hooks get only the prompt text, so a pasted image (`[Image #N]`) cannot reach the enhancer: that throws.
export function draftImages(draft, cwd) {
	const text = String(draft);
	if (/\[Image #\d+\]/.test(text)) throw new Error('Claude Code does not pass pasted images to plugins. Save the image and write its path in your prompt instead, e.g. `::e match this layout C:\\shots\\header.png`.');
	const out = [], seen = new Set();
	for (const m of text.matchAll(/"([^"\n]+)"|'([^'\n]+)'|(\S+)/g)) {
		const label = (m[1] ?? m[2] ?? m[3].replace(/[),.;:!?]+$/, '')).replace(/^@/, '');
		if (!/\.(png|jpe?g|gif|webp)$/i.test(label)) continue;
		const file = path.resolve(cwd, label);
		let isFile = false;
		try { isFile = statSync(file).isFile(); } catch {}
		if (isFile && !seen.has(file)) { seen.add(file); out.push({ label, file }); }
	}
	return out;
}

// Claude Code injects these as user messages; like omp's custom messages they are not the chat.
const HARNESS = /^<(command-|local-command-|task-notification|system-reminder)/;

// Claude Code transcript (JSONL) → [{role, text}] for enhanceInput. Tool results arrive as user entries and thinking/tool_use
// as assistant blocks; contentText keeps only text blocks, so those drop out. Meta, sidechain and compaction entries are skipped.
export function transcriptMessages(jsonl) {
	const out = [];
	for (const line of String(jsonl || '').split('\n')) {
		let e;
		try { e = JSON.parse(line); } catch { continue; }
		const role = e?.message?.role;
		if ((role !== 'user' && role !== 'assistant') || e.type !== role || e.isMeta || e.isSidechain || e.isCompactSummary) continue;
		const text = contentText(e.message.content).trim();
		if (text && !HARNESS.test(text)) out.push({ role, text });
	}
	return out;
}

// The session's current model: the last real assistant entry's (`<synthetic>` marks Claude Code's own error replies).
export function transcriptModel(jsonl) {
	let model;
	for (const line of String(jsonl || '').split('\n')) {
		let e;
		try { e = JSON.parse(line); } catch { continue; }
		const m = e?.type === 'assistant' && !e.isSidechain ? e.message?.model : null;
		if (typeof m === 'string' && m && m !== '<synthetic>') model = m;
	}
	return model;
}

// Every outcome blocks the submit. The draft stays in the block message unless it was replaced by the enhanced prompt.
const block = (reason, keepDraft) => ({ decision: 'block', reason, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: !keepDraft } });

// The prompt you send must still name each image for Claude to read it, so a path the enhancer left out is added at the end.
export function enhancedOutput(text, images = []) {
	const missing = images.filter(i => !text.includes(i.label) && !text.includes(i.file));
	return block(missing.length ? `${text}\n\n${missing.map(i => `Image: ${i.file}`).join('\n')}` : text, false);
}
export const emptyOutput = () => block('Write a prompt after ::e (::en: no new tests or smoke runs, ::ef: fast) or /enhance (/enhance-notest, /enhance-fast) first, e.g. `::e fix the login redirect`.', true);
export function failedOutput(e, env = process.env) {
	if (e?.name === 'AbortError') return block('Enhance cancelled.', true);
	// spawn without a shell finds claude.exe but not an npm claude.cmd shim on Windows, and reports only `spawn claude ENOENT`.
	let msg = /^spawn .+ ENOENT$/.test(e?.message) ? `claude not found. Set ${ENV.claude} to the claude executable.` : e?.message;
	// Claude Code words a refused sign-in as a billing problem (e.g. 403 oauth_not_allowed_for_organization), so say whose it was.
	if (e?.api?.status === 401 || e?.api?.status === 403) {
		const why = `(HTTP ${e.api.status}${e.api.code ? ` ${e.api.code}` : ''})`;
		msg += env[ENV.token]
			? `\n\nThe API refused ${ENV.token} ${why}. Make a new one with \`claude setup-token\`, signing in to the account and organization this session uses.`
			: `\n\nThe API refused the sign-in of \`${env[ENV.claude] || 'claude'}\` ${why}. Hooks don't get this session's sign-in, so the enhancer uses that claude's own login, which may be another account or organization. Run \`claude setup-token\`, sign in to the account and organization this session uses, and set ${ENV.token} to the token (e.g. in the \`env\` of ~/.claude/settings.json); or sign that claude in to the same organization with \`claude auth login\`.`;
	}
	return block(`Enhance failed: ${msg}`, true);
}

// A hook can't put text back in the prompt box, so the enhanced prompt goes to the clipboard, to paste with Ctrl+V.
const CLIPBOARD = { win32: [['clip']], darwin: [['pbcopy']], linux: [['wl-copy'], ['xclip', '-selection', 'clipboard']] };
export function copyToClipboard(text) {
	// clip.exe takes UTF-16LE (a BOM would be pasted too); anything else it reads in the console code page. pbcopy needs a UTF-8 locale.
	const input = process.platform === 'win32' ? Buffer.from(text, 'utf16le') : text;
	const opts = { input, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, timeout: 5000, env: { ...process.env, LC_CTYPE: 'UTF-8' } };
	return (CLIPBOARD[process.platform] || []).some(([cmd, ...args]) => spawnSync(cmd, args, opts).status === 0);
}

export async function main() {
	let input;
	try {
		let raw = '';
		for await (const chunk of process.stdin) raw += chunk;
		input = JSON.parse(raw);
	} catch { return; } // not a hook payload: let the prompt through untouched
	const req = hookRequest(input);
	if (!req) return;
	const { mode, draft } = req;

	let out;
	if (!draft) out = emptyOutput();
	else {
		const ctl = new AbortController();
		for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => ctl.abort());
		let messages = [], model;
		try {
			const jsonl = input.transcript_path ? readFileSync(input.transcript_path, 'utf8') : '';
			messages = transcriptMessages(jsonl);
			model = transcriptModel(jsonl);
		} catch {}
		try {
			const cwd = input.cwd || process.cwd(), images = draftImages(draft, cwd);
			out = enhancedOutput(await runEnhance({
				draft, messages, images, cwd, engine: 'claude', mode, bin: process.env[ENV.claude] || undefined, env: enhanceEnv(),
				model: process.env[ENV.model] || model, thinking: process.env[ENV.effort] || undefined, signal: ctl.signal,
			}), images);
			if (copyToClipboard(out.reason)) out.reason = `Copied to the clipboard: paste it into the prompt box (Ctrl+V), edit it if you like, and send.\n\n${out.reason}`;
		} catch (e) {
			out = failedOutput(e);
		}
	}
	if (input.hook_event_name === 'UserPromptExpansion') out.hookSpecificOutput.hookEventName = 'UserPromptExpansion';
	// Exit 2 blocks on every Claude Code version, even one that rejects the JSON; stderr is then the message shown.
	process.stdout.write(JSON.stringify(out));
	process.stderr.write(out.reason);
	process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
