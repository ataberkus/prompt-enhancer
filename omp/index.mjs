// omp extension: alt+e rewrites the composer draft with the enhancer, alt+shift+n with its no-test mode, alt+shift+e with
// its fast mode; the same key again restores the draft (or cancels a run). `/enhance`, `/enhance-notest` and
// `/enhance-fast <prompt>` do the same for hosts whose composer the extension cannot read.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEDIA, branchMessages, runEnhance } from '../core/enhance.mjs';

const STATUS = 'prompt-enhancer';
// Per enhance mode (core/enhance.mjs `modes`): its composer key, command and status wording.
export const MODES = {
	full: { key: 'alt+e', command: 'enhance', verb: 'Enhancing', what: 'a repo-grounded spec' },
	notest: { key: 'alt+shift+n', command: 'enhance-notest', verb: 'Enhancing (no tests)', what: 'a repo-grounded spec without new tests or smoke runs' },
	fast: { key: 'alt+shift+e', command: 'enhance-fast', verb: 'Fast-enhancing', what: 'a lean prompt (existing checks only, no new tests or smoke runs)' },
};
const COMMAND = new RegExp(`^/(${Object.values(MODES).map(M => M.command).join('|')})(?:\\s|$)`);
// The omp binary running this extension, whatever its file name: Tern's managed omp runs as `omp(.exe)` in its own data
// folder and keeps versioned copies (`18.18.0.exe`) and the binary an update replaced (`.omp.exe.old-…`), which sessions
// started before the update still run. `omp` on PATH only when omp runs from source under bun or node.
const OMP = /^(bun|node)(\.exe)?$/i.test(path.basename(process.execPath)) ? 'omp' : process.execPath;

// The composer shows attachments as chips (`<icon> #N`, icon from the theme) that expand to `[Image #N, WxH]` on submit,
// and omp drops every attachment whose chip or marker the sent text lacks. The enhancer sees `[Image #N]` markers; the
// result gets each draft chip back, and any reference it left out is appended. `[Image #N]` / `[Video #N]` is entry N-1
// of the message's images (a video is attached as its preview image).
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

const EXT = Object.fromEntries(Object.entries(MEDIA).map(([ext, mime]) => [mime, ext]));
// The images the enhancer can see: each `[Image #N]` of `text` in draft order, entry N-1 of `attached` (omp ImageContent,
// `{ data: base64, mimeType }`) written to `dir`. Videos stay markers. → { images: [{ label, file }], skipped: ['Image #N'] }
export function enhancerImages(text, attached, dir) {
	const images = [], skipped = [], seen = new Set();
	for (const m of text.matchAll(/\[Image #([1-9]\d*)[,\]]/g)) {
		if (seen.has(m[1])) continue;
		seen.add(m[1]);
		const img = attached[m[1] - 1], ext = EXT[img?.mimeType];
		if (!ext || !img.data) { skipped.push(`Image #${m[1]}`); continue; }
		const file = path.join(dir, `image-${m[1]}.${ext}`);
		writeFileSync(file, Buffer.from(img.data, 'base64'));
		images.push({ label: `[Image #${m[1]}]`, file });
	}
	return { images, skipped };
}

// True when `text` references one of `count` images (a marker omp would attach entry N-1 for).
export const refersToImages = (text, count) => [...text.matchAll(MARKER)].some(m => Number(m[2]) <= count);

export default function promptEnhancer(pi) {
	pi.setLabel('Prompt Enhancer');
	// job: AbortController of the running enhance; last: { draft, text } of the latest result; submitted: the images sent
	// with an enhance command, which omp passes only to `input` handlers; held: those images, to re-attach to the enhanced prompt.
	let job = null, last = null, submitted = null, held = null;

	// An `enhance` model role in omp's config wins; otherwise the session's model at its thinking level. `vision` is
	// undefined when the model's inputs are unknown.
	const vision = m => (m?.input ? m.input.includes('image') : undefined);
	const pick = ctx => {
		const role = ctx.models?.resolve('@enhance');
		if (role) return { model: '@enhance', thinking: null, label: '@enhance', vision: vision(role) };
		const m = ctx.model;
		return m ? { model: `${m.provider}/${m.id}`, thinking: pi.getThinkingLevel() ?? null, label: m.id, vision: vision(m) } : { model: null, thinking: null, label: 'omp default' };
	};

	// `attached`: the message's images when the draft came with an enhance command; undefined for the composer, whose images
	// omp does not expose to extensions (they stay in the composer, so the enhanced text keeps them).
	async function enhance(ctx, draft, mode, attached) {
		const M = MODES[mode];
		if (!draft.trim()) return ctx.ui.notify(`Write a prompt first, then press ${M.key} (or run /${M.command} <prompt>).`, 'warning');
		const ctl = new AbortController(), p = pick(ctx);
		job = ctl;
		ctx.ui.setStatus(STATUS, `✨ ${M.verb} with ${p.label}… (${M.key} cancels)`);
		let dir;
		try {
			const att = draftAttachments(draft, chipIcons(ctx.ui.theme));
			let images = [];
			if ([...att.refs.keys()].some(k => k.startsWith('Image '))) {
				let warning;
				if (!attached) warning = `omp does not give extensions the composer's images, so the enhancer sees only their markers; the images stay attached. To let it see them, send /${M.command} <prompt> with the images attached.`;
				else if (p.vision === false) warning = `${p.label} takes no images, so the enhancer sees only their markers; the images stay attached.`;
				else {
					dir = mkdtempSync(path.join(os.tmpdir(), 'prompt-enhancer-'));
					const r = enhancerImages(att.text, attached, dir);
					images = r.images;
					if (r.skipped.length) warning = `The enhancer sees only the marker of ${r.skipped.join(', ')} (no png, jpg, gif or webp image to forward); it stays attached.`;
				}
				if (warning) ctx.ui.notify(warning, 'warning');
			}
			const text = keepAttachments(await runEnhance({
				draft: att.text, messages: branchMessages(ctx.sessionManager.getBranch()), images, cwd: ctx.cwd, bin: OMP, mode, model: p.model, thinking: p.thinking,
				signal: ctl.signal, onStep: s => ctx.ui.setStatus(STATUS, `✨ ${M.verb}: ${s}`),
			}), att.refs);
			// Never drop words typed while the enhancer ran.
			const now = ctx.ui.getEditorText();
			if (now.trim() && now !== draft && !(await ctx.ui.confirm('Replace your prompt?', 'You changed the prompt while it was being enhanced. Replace it with the enhanced version?'))) return;
			ctx.ui.setEditorText(text);
			last = { draft, text };
			// The command's submit took its images out of the composer; the next send gets them back.
			held = attached?.length ? attached : null;
			ctx.ui.notify(`Prompt enhanced. Press ${M.key} to restore your draft.${held ? ' Its images are attached again when you send it.' : ''}`, 'info');
		} catch (e) {
			ctx.ui.notify(e.name === 'AbortError' ? 'Enhance cancelled.' : `Enhance failed: ${e.message}`, e.name === 'AbortError' ? 'info' : 'error');
		} finally {
			if (dir) rmSync(dir, { recursive: true, force: true });
			if (job === ctl) job = null;
			ctx.ui.setStatus(STATUS, undefined);
		}
	}
	// Detached on purpose so input stays live; enhance() catches its own errors, the catch covers a throwing UI call.
	const start = (ctx, draft, mode, attached) => void enhance(ctx, draft, mode, attached).catch(() => {});

	// Runs on every send, before omp dispatches a command. An enhance command's images are kept for its handler; the first
	// other send takes the held images when it still references them and carries none of its own.
	pi.on('input', event => {
		if (COMMAND.test(event.text.trimStart())) {
			submitted = event.images?.length ? event.images : null;
			return;
		}
		const images = held;
		held = null;
		if (images && !event.images?.length && refersToImages(event.text, images.length)) return { images };
	});

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
				const attached = submitted ?? undefined;
				submitted = null;
				if (job) return ctx.ui.notify(`An enhance is already running; ${M.key} cancels it.`, 'warning');
				start(ctx, args.trim() ? args : ctx.ui.getEditorText(), mode, args.trim() ? attached ?? [] : undefined);
			},
		});
	}

	// Tern ends an agent block by closing its terminal; omp then quits (exit 129), which need not end the session first, and
	// the hidden `omp -p` child has no terminal to lose on Windows. `exit` covers every way omp ends.
	const cancel = () => job?.abort();
	process.on('exit', cancel);
	pi.on('session_shutdown', () => {
		process.off('exit', cancel);
		cancel();
	});
}
