// Claude Code front end: a UserPromptSubmit hook (hooks/hooks.json). A prompt starting with `::e` never reaches Claude;
// a separate locked-down `claude -p` run rewrites the rest, and the hook blocks the submit with the enhanced prompt as its
// message, to copy and send. Needs only Claude Code and node; no omp.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { contentText, runEnhance } from '../core/enhance.mjs';

export const MARKER = '::e';
export const ENV = { claude: 'PROMPT_ENHANCER_CLAUDE', model: 'PROMPT_ENHANCER_MODEL', effort: 'PROMPT_ENHANCER_EFFORT' };

// The draft after the marker ('' when nothing follows it), or null when the prompt is not an enhance request.
export function parseDraft(prompt) {
	const m = String(prompt ?? '').match(/^\s*::e(?:\s+([\s\S]*))?$/);
	return m ? (m[1] ?? '').trim() : null;
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

export const enhancedOutput = text => block(text, false);
export const emptyOutput = () => block(`Write a prompt after ${MARKER} first, e.g. \`${MARKER} fix the login redirect\`.`, true);
export function failedOutput(e) {
	if (e?.name === 'AbortError') return block('Enhance cancelled.', true);
	// spawn without a shell finds claude.exe but not an npm claude.cmd shim on Windows, and reports only `spawn claude ENOENT`.
	const msg = /^spawn .+ ENOENT$/.test(e?.message) ? `claude not found. Set ${ENV.claude} to the claude executable.` : e?.message;
	return block(`Enhance failed: ${msg}`, true);
}

export async function main() {
	let input;
	try {
		let raw = '';
		for await (const chunk of process.stdin) raw += chunk;
		input = JSON.parse(raw);
	} catch { return; } // not a hook payload: let the prompt through untouched
	const draft = parseDraft(input?.prompt);
	if (draft === null) return;

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
			out = enhancedOutput(await runEnhance({
				draft, messages, cwd: input.cwd || process.cwd(), engine: 'claude', bin: process.env[ENV.claude] || undefined,
				model: process.env[ENV.model] || model, thinking: process.env[ENV.effort] || undefined, signal: ctl.signal,
			}));
		} catch (e) {
			out = failedOutput(e);
		}
	}
	// Exit 2 blocks on every Claude Code version, even one that rejects the JSON; stderr is then the message shown.
	process.stdout.write(JSON.stringify(out));
	process.stderr.write(out.reason);
	process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
