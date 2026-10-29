// omp extension: alt+e rewrites the composer draft with the enhancer; alt+e again restores the draft (or cancels a run).
// `/enhance <prompt>` does the same for hosts whose composer the extension cannot read.
import path from 'node:path';
import { branchMessages, runEnhance } from '../core/enhance.mjs';

const KEY = 'alt+e', STATUS = 'prompt-enhancer';
// The omp binary running this extension (Tern ships its own); `omp` on PATH when omp runs from source under bun.
const OMP = /^omp(\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : 'omp';

export default function promptEnhancer(pi) {
	pi.setLabel('Prompt Enhancer');
	let job = null, last = null; // job: AbortController of the running enhance; last: { draft, text } of the latest result

	// An `enhance` model role in omp's config wins; otherwise the session's model at its thinking level.
	const pick = ctx => {
		if (ctx.models?.resolve('@enhance')) return { model: '@enhance', thinking: null, label: '@enhance' };
		const m = ctx.model;
		return m ? { model: `${m.provider}/${m.id}`, thinking: pi.getThinkingLevel() ?? null, label: m.id } : { model: null, thinking: null, label: 'omp default' };
	};

	async function enhance(ctx, draft) {
		if (!draft.trim()) return ctx.ui.notify(`Write a prompt first, then press ${KEY} (or run /enhance <prompt>).`, 'warning');
		const ctl = new AbortController(), p = pick(ctx);
		job = ctl;
		ctx.ui.setStatus(STATUS, `✨ Enhancing with ${p.label}… (${KEY} cancels)`);
		try {
			const text = await runEnhance({
				draft, messages: branchMessages(ctx.sessionManager.getBranch()), cwd: ctx.cwd, bin: OMP, model: p.model, thinking: p.thinking,
				signal: ctl.signal, onStep: s => ctx.ui.setStatus(STATUS, `✨ Enhancing: ${s}`),
			});
			// Never drop words typed while the enhancer ran.
			const now = ctx.ui.getEditorText();
			if (now.trim() && now !== draft && !(await ctx.ui.confirm('Replace your prompt?', 'You changed the prompt while it was being enhanced. Replace it with the enhanced version?'))) return;
			ctx.ui.setEditorText(text);
			last = { draft, text };
			ctx.ui.notify(`Prompt enhanced. Press ${KEY} to restore your draft.`, 'info');
		} catch (e) {
			ctx.ui.notify(e.name === 'AbortError' ? 'Enhance cancelled.' : `Enhance failed: ${e.message}`, e.name === 'AbortError' ? 'info' : 'error');
		} finally {
			if (job === ctl) job = null;
			ctx.ui.setStatus(STATUS, undefined);
		}
	}
	// Detached on purpose so input stays live; enhance() catches its own errors, the catch covers a throwing UI call.
	const start = (ctx, draft) => void enhance(ctx, draft).catch(() => {});

	pi.registerShortcut(KEY, {
		description: 'Enhance the prompt in the composer (again: restore it, or cancel a running enhance)',
		handler: ctx => {
			if (job) return job.abort();
			if (!ctx.hasUI || !ctx.ui.supportsEditor) return ctx.ui.notify('This omp host has no editable composer; use /enhance <prompt>.', 'warning');
			const text = ctx.ui.getEditorText();
			if (last && text === last.text) {
				ctx.ui.setEditorText(last.draft);
				last = null;
				return ctx.ui.notify('Restored your draft.', 'info');
			}
			start(ctx, text);
		},
	});

	pi.registerCommand('enhance', {
		description: `Enhance a prompt into a repo-grounded spec: /enhance <prompt> (or ${KEY} on the composer)`,
		handler: async (args, ctx) => {
			if (job) return ctx.ui.notify(`An enhance is already running; ${KEY} cancels it.`, 'warning');
			start(ctx, args.trim() ? args : ctx.ui.getEditorText());
		},
	});

	pi.on('session_shutdown', () => job?.abort());
}
