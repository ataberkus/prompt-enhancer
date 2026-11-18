// Antigravity IDE (VS Code-compatible) front end: Alt+E rewrites the selected draft (or an InputBox draft for the
// Agent sidebar) with the enhancer, Alt+Shift+N with notest, Alt+Shift+E with fast, Alt+Shift+M with max; pressing
// the shortcut again restores the original draft or cancels a running enhance.
import {
	appendMissingImages, draftImages as coreDraftImages, engines, findAntigravityBin, modes, runEnhance,
} from '../core/enhance.mjs';

export const ENV = {
	antigravity: 'PROMPT_ENHANCER_ANTIGRAVITY',
	engine: 'PROMPT_ENHANCER_ENGINE',
	model: 'PROMPT_ENHANCER_MODEL',
	effort: 'PROMPT_ENHANCER_EFFORT',
	claude: 'PROMPT_ENHANCER_CLAUDE',
	omp: 'PROMPT_ENHANCER_OMP',
	token: 'PROMPT_ENHANCER_OAUTH_TOKEN',
};

export const COMMANDS = {
	full: 'promptEnhancer.enhance',
	notest: 'promptEnhancer.enhanceNotest',
	fast: 'promptEnhancer.enhanceFast',
	max: 'promptEnhancer.enhanceMax',
	cancel: 'promptEnhancer.cancel',
};

export const MODES = Object.fromEntries(
	Object.entries(modes).map(([id, { key, command, verb, what, title }]) => [id, { key, command, verb, what, title, commandId: COMMANDS[id] }]),
);

const KEY_LABEL = {
	'alt+e': 'Alt+E',
	'alt+shift+n': 'Alt+Shift+N',
	'alt+shift+e': 'Alt+Shift+E',
	'alt+shift+m': 'Alt+Shift+M',
};

export function resolveConfig(vscode, env = process.env) {
	const cfg = vscode.workspace?.getConfiguration?.('promptEnhancer');
	const get = (k, fallback = '') => String(cfg?.get?.(k, fallback) ?? fallback).trim();
	const rawEngine = (env[ENV.engine] || get('engine', 'antigravity')).toLowerCase();
	if (!engines[rawEngine]) throw new Error(`Unknown enhance engine: "${rawEngine}". Expected one of: ${Object.keys(engines).join(', ')}.`);
	const binEnv = rawEngine === 'claude' ? env[ENV.claude] : rawEngine === 'omp' ? env[ENV.omp] : env[ENV.antigravity];
	const configuredBin = binEnv || get('binary', '');
	const bin = configuredBin || (rawEngine === 'antigravity' ? findAntigravityBin(env) : undefined);
	const model = env[ENV.model] || get('model', '') || undefined;
	const thinking = env[ENV.effort] || get('effort', '') || undefined;
	const childEnv = rawEngine === 'claude' && env[ENV.token] ? { CLAUDE_CODE_OAUTH_TOKEN: env[ENV.token] } : {};
	return { engine: rawEngine, bin, model, thinking, env: childEnv };
}

export function formatError(e, { engine = 'antigravity', bin } = {}, env = process.env) {
	if (e?.name === 'AbortError') return 'Enhance cancelled.';
	const binVar = engine === 'claude' ? ENV.claude : engine === 'omp' ? ENV.omp : ENV.antigravity;
	const binName = engine === 'claude' ? 'claude' : engine === 'omp' ? 'omp' : 'agy';
	let msg = /^spawn .+ ENOENT$/.test(e?.message) ? `${binName} not found. Set ${binVar} or promptEnhancer.binary to the ${binName} executable.` : (e?.message || String(e));
	if (e?.api?.status === 401 || e?.api?.status === 403) {
		const why = `(HTTP ${e.api.status}${e.api.code ? ` ${e.api.code}` : ''})`;
		if (engine === 'claude') {
			msg += env[ENV.token]
				? ` The API refused ${ENV.token} ${why}. Make a new token with \`claude setup-token\`.`
				: ` The API refused the sign-in of \`${bin || 'claude'}\` ${why}. Run \`claude setup-token\` and set ${ENV.token}, or run \`claude auth login\`.`;
		} else {
			msg += ` The API refused the sign-in of \`${bin || 'agy'}\` ${why}. Run \`agy\` in a terminal to sign in again.`;
		}
	}
	return `Enhance failed: ${msg}`;
}

function workspaceCwd(vscode, editor) {
	const uri = editor?.document?.uri;
	const folder = uri && vscode.workspace?.getWorkspaceFolder?.(uri);
	return folder?.uri?.fsPath || vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
}

function endPositionFor(start, text) {
	const lines = String(text).split(/\r?\n/);
	return lines.length === 1
		? { line: start.line, character: start.character + lines[0].length }
		: { line: start.line + lines.length - 1, character: lines.at(-1).length };
}

let activeDeactivate = null;

export function activateWith(context, vscode, { enhance = runEnhance, env = process.env } = {}) {
	let job = null;
	// last: { kind: 'editor', uri, range, draft, text } | { kind: 'clipboard', draft, text }
	let last = null;

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment?.Left ?? 1, 100);
	status.command = COMMANDS.cancel;
	status.tooltip = 'Click to cancel the running prompt enhancement';
	context?.subscriptions?.push?.(status);

	const showStatus = text => {
		status.text = text;
		status.show();
	};
	const hideStatus = () => status.hide();

	const cancelRunning = () => {
		if (!job) return false;
		job.abort();
		return true;
	};

	async function tryRestore(editor) {
		if (!last) return false;
		if (last.kind === 'editor' && editor && editor.document.uri.toString() === last.uri) {
			const current = editor.document.getText(last.range);
			if (current === last.text) {
				const draft = last.draft;
				const ok = await editor.edit(eb => eb.replace(last.range, draft));
				if (ok) {
					last = null;
					vscode.window.showInformationMessage('Restored your draft.');
					return true;
				}
			}
		}
		if (last.kind === 'clipboard' && (!editor || editor.selection.isEmpty)) {
			const clip = await vscode.env.clipboard.readText();
			if (clip === last.text) {
				await vscode.env.clipboard.writeText(last.draft);
				last = null;
				vscode.window.showInformationMessage('Restored your draft to the clipboard.');
				return true;
			}
		}
		return false;
	}

	async function runMode(mode) {
		if (cancelRunning()) return;
		const M = MODES[mode];
		const keyHint = KEY_LABEL[M.key] || M.key;
		const editor = vscode.window.activeTextEditor;

		if (last && await tryRestore(editor)) return;

		const hasSelection = Boolean(editor && !editor.selection.isEmpty);
		let draft, targetRange = null;
		if (hasSelection) {
			targetRange = editor.selection;
			draft = editor.document.getText(targetRange);
		} else {
			draft = await vscode.window.showInputBox({
				title: `Prompt Enhancer: ${M.title}`,
				prompt: `Enter your prompt draft (${M.what}). Result is copied to the clipboard for Antigravity Agent chat.`,
				placeHolder: 'e.g. add rate limiting to the upload endpoint',
				ignoreFocusOut: true,
			});
			if (draft === undefined) return;
		}

		if (!String(draft).trim()) {
			vscode.window.showWarningMessage(`Write or select a prompt first, then press ${keyHint}.`);
			return;
		}

		let cfg;
		try {
			cfg = resolveConfig(vscode, env);
		} catch (e) {
			vscode.window.showErrorMessage(`Enhance failed: ${e.message}`);
			return;
		}

		const cwd = workspaceCwd(vscode, editor);
		let images = [];
		try {
			images = coreDraftImages(draft, cwd, { hostName: 'Antigravity IDE', examplePrefix: '' });
		} catch (e) {
			vscode.window.showWarningMessage(e.message);
			return;
		}

		const ctl = new AbortController();
		job = ctl;
		const modelLabel = cfg.model || cfg.engine;
		showStatus(`✨ ${M.verb} with ${modelLabel}… (${keyHint} cancels)`);

		try {
			const enhanced = appendMissingImages(await enhance({
				draft, messages: [], images, cwd,
				engine: cfg.engine, mode, bin: cfg.bin, env: cfg.env,
				model: cfg.model, thinking: cfg.thinking,
				signal: ctl.signal,
				onStep: s => showStatus(`✨ ${M.verb}: ${s}`),
			}), images);

			if (hasSelection && editor && targetRange) {
				const now = editor.document.getText(targetRange);
				if (now !== draft) {
					const pick = await vscode.window.showWarningMessage(
						'You changed the prompt while it was being enhanced. Replace it with the enhanced version?',
						{ modal: true },
						'Replace',
					);
					if (pick !== 'Replace') return;
				}
				const ok = await editor.edit(eb => eb.replace(targetRange, enhanced));
				if (ok) {
					const end = endPositionFor(targetRange.start, enhanced);
					const newRange = vscode.Range && vscode.Position
						? new vscode.Range(targetRange.start, new vscode.Position(end.line, end.character))
						: { start: targetRange.start, end };
					last = { kind: 'editor', uri: editor.document.uri.toString(), range: newRange, draft, text: enhanced };
					await vscode.env.clipboard.writeText(enhanced);
					vscode.window.showInformationMessage(`Prompt enhanced (and copied to clipboard). Press ${keyHint} to restore your draft.`);
					return;
				}
			}

			await vscode.env.clipboard.writeText(enhanced);
			last = { kind: 'clipboard', draft, text: enhanced };
			const action = await vscode.window.showInformationMessage(
				`Prompt enhanced and copied to the clipboard. Paste into the Agent chat (Ctrl+V), or press ${keyHint} to restore your draft.`,
				'Open Result',
				'Restore Draft',
			);
			if (action === 'Open Result') {
				const doc = await vscode.workspace.openTextDocument({ content: enhanced, language: 'markdown' });
				await vscode.window.showTextDocument(doc, { preview: false });
			} else if (action === 'Restore Draft') {
				await vscode.env.clipboard.writeText(draft);
				last = null;
				vscode.window.showInformationMessage('Restored your draft to the clipboard.');
			}
		} catch (e) {
			if (e?.name === 'AbortError') {
				vscode.window.showInformationMessage('Enhance cancelled.');
			} else {
				const action = await vscode.window.showErrorMessage(formatError(e, cfg, env), 'Copy Original Draft');
				if (action === 'Copy Original Draft') await vscode.env.clipboard.writeText(draft);
			}
		} finally {
			if (job === ctl) job = null;
			hideStatus();
		}
	}

	for (const [mode, M] of Object.entries(MODES)) {
		const disp = vscode.commands.registerCommand(M.commandId, () => runMode(mode));
		context?.subscriptions?.push?.(disp);
	}
	const cancelDisp = vscode.commands.registerCommand(COMMANDS.cancel, () => {
		if (!cancelRunning()) vscode.window.showInformationMessage('No enhance is currently running.');
	});
	context?.subscriptions?.push?.(cancelDisp);

	activeDeactivate = () => {
		cancelRunning();
		status.dispose?.();
	};
	return { cancelRunning, runMode };
}

export function deactivate() {
	activeDeactivate?.();
	activeDeactivate = null;
}
