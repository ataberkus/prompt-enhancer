// omp extension: alt+e rewrites the composer draft with the enhancer, alt+shift+n with its no-test mode, alt+shift+e with
// its fast mode; the same key again restores the draft (or cancels a run). `/enhance`, `/enhance-notest` and
// `/enhance-fast <prompt>` do the same for hosts whose composer the extension cannot read.
import path from 'node:path';
import { branchMessages, runEnhance } from '../core/enhance.mjs';

const STATUS = 'prompt-enhancer';
// Per enhance mode (core/enhance.mjs `modes`): its composer key, command and status wording.
export const MODES = {
	full: { key: 'alt+e', command: 'enhance', verb: 'Enhancing', what: 'a repo-grounded spec' },
	notest: { key: 'alt+shift+n', command: 'enhance-notest', verb: 'Enhancing (no tests)', what: 'a repo-grounded spec without new tests or smoke runs' },
	fast: { key: 'alt+shift+e', command: 'enhance-fast', verb: 'Fast-enhancing', what: 'a lean prompt (existing checks only, no new tests or smoke runs)' },
};
// The omp binary running this extension (Tern ships its own); `omp` on PATH when omp runs from source under bun.
const OMP = /^omp(\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : 'omp';

// The composer shows attachments as chips (`<icon> #N`, icon from the theme) that expand to `[Image #N, WxH]` on submit,
// and omp drops every attachment whose chip or marker the sent text lacks. The enhancer sees `[Image #N]` markers; the
// result gets each draft chip back, and any reference it left out is appended.
const MARKER = /\[(Image|Video) #([1-9]\d*)(?:,[^\]\n]*)?\]/g;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const chipRe = icon => new RegExp(`${esc(icon)} #([1-9]\\d*)(?!\\d)`, 'gu');
export const chipIcons = theme => Object.fromEntries([['Image', 'chip.image'], ['Video', 'chip.video']]
	.map(([kind, key]) => [kind, theme?.symbol?.(key)]).filter(([, icon]) => icon));

// → { text: the draft with chips as markers, refs: Map of `Image #N` → the draft's own token for it }
export function draftAttachments(draft, icons) {
	const refs = new Map();
	let text = draft;
	for (const [kind, icon] of Object.entries(icons)) {
		for (const m of draft.matchAll(chipRe(icon))) refs.set(`${kind} #${m[1]}`, m[0]);
		text = text.replace(chipRe(icon), `[${kind} #$1]`);
	}
	for (const m of draft.matchAll(MARKER)) refs.set(`${m[1]} #${m[2]}`, m[0]);
	return { text, refs };
}

export function keepAttachments(text, refs) {
	const out = text.replace(/\[(Image|Video) #([1-9]\d*)\]/g, (m, kind, n) => refs.get(`${kind} #${n}`) ?? m);
	const missing = [...refs].filter(([key, token]) => !new RegExp(`${esc(token)}(?!\\d)|\\[${key}[,\\]]`, 'u').test(out));
	return missing.length ? `${out}\n\n${missing.map(([, token]) => token).join(' ')}` : out;
}

export default function promptEnhancer(pi) {
	pi.setLabel('Prompt Enhancer');
	let job = null, last = null; // job: AbortController of the running enhance; last: { draft, text } of the latest result

	// An `enhance` model role in omp's config wins; otherwise the session's model at its thinking level.
	const pick = ctx => {
		if (ctx.models?.resolve('@enhance')) return { model: '@enhance', thinking: null, label: '@enhance' };
		const m = ctx.model;
		return m ? { model: `${m.provider}/${m.id}`, thinking: pi.getThinkingLevel() ?? null, label: m.id } : { model: null, thinking: null, label: 'omp default' };
	};

	async function enhance(ctx, draft, mode) {
		const M = MODES[mode];
		if (!draft.trim()) return ctx.ui.notify(`Write a prompt first, then press ${M.key} (or run /${M.command} <prompt>).`, 'warning');
		const ctl = new AbortController(), p = pick(ctx);
		job = ctl;
		ctx.ui.setStatus(STATUS, `✨ ${M.verb} with ${p.label}… (${M.key} cancels)`);
		try {
			const att = draftAttachments(draft, chipIcons(ctx.ui.theme));
			const text = keepAttachments(await runEnhance({
				draft: att.text, messages: branchMessages(ctx.sessionManager.getBranch()), cwd: ctx.cwd, bin: OMP, mode, model: p.model, thinking: p.thinking,
				signal: ctl.signal, onStep: s => ctx.ui.setStatus(STATUS, `✨ ${M.verb}: ${s}`),
			}), att.refs);
			// Never drop words typed while the enhancer ran.
			const now = ctx.ui.getEditorText();
			if (now.trim() && now !== draft && !(await ctx.ui.confirm('Replace your prompt?', 'You changed the prompt while it was being enhanced. Replace it with the enhanced version?'))) return;
			ctx.ui.setEditorText(text);
			last = { draft, text };
			ctx.ui.notify(`Prompt enhanced. Press ${M.key} to restore your draft.`, 'info');
		} catch (e) {
			ctx.ui.notify(e.name === 'AbortError' ? 'Enhance cancelled.' : `Enhance failed: ${e.message}`, e.name === 'AbortError' ? 'info' : 'error');
		} finally {
			if (job === ctl) job = null;
			ctx.ui.setStatus(STATUS, undefined);
		}
	}
	// Detached on purpose so input stays live; enhance() catches its own errors, the catch covers a throwing UI call.
	const start = (ctx, draft, mode) => void enhance(ctx, draft, mode).catch(() => {});

	for (const [mode, M] of Object.entries(MODES)) {
		pi.registerShortcut(M.key, {
			description: `Enhance the prompt in the composer into ${M.what} (again: restore it, or cancel a running enhance)`,
			handler: ctx => {
				if (job) return job.abort();
				if (!ctx.hasUI || !ctx.ui.supportsEditor) return ctx.ui.notify(`This omp host has no editable composer; use /${M.command} <prompt>.`, 'warning');
				const text = ctx.ui.getEditorText();
				if (last && text === last.text) {
					ctx.ui.setEditorText(last.draft);
					last = null;
					return ctx.ui.notify('Restored your draft.', 'info');
				}
				start(ctx, text, mode);
			},
		});

		pi.registerCommand(M.command, {
			description: `Enhance a prompt into ${M.what}: /${M.command} <prompt> (or ${M.key} on the composer)`,
			handler: async (args, ctx) => {
				if (job) return ctx.ui.notify(`An enhance is already running; ${M.key} cancels it.`, 'warning');
				start(ctx, args.trim() ? args : ctx.ui.getEditorText(), mode);
			},
		});
	}

	pi.on('session_shutdown', () => job?.abort());
}
