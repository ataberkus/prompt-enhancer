// Antigravity CLI front end: a PreInvocation hook (hooks.json). A prompt starting with `::e` (`::en` for no-test,
// `::ef` for fast, `::em` for max), or `/enhance <draft>` (`/enhance-notest`, `/enhance-fast`, `/enhance-max`), never
// reaches the model; a separate locked-down `agy -p` (or `claude -p` / `omp -p` via PROMPT_ENHANCER_ENGINE) run rewrites
// the draft, terminates the turn with the enhanced prompt rendered inline, and copies it to the clipboard.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
	MARKERS, antigravityTranscriptMessages, antigravityTranscriptModel, appendMissingImages, copyToClipboard,
	draftImages as coreDraftImages, engines, findAntigravityBin, parseDraft, parseSlashCommand, runEnhance,
} from '../core/enhance.mjs';

export { MARKERS, copyToClipboard, parseDraft };
export const transcriptMessages = antigravityTranscriptMessages;
export const transcriptModel = antigravityTranscriptModel;

export const ENV = {
	antigravity: 'PROMPT_ENHANCER_ANTIGRAVITY',
	engine: 'PROMPT_ENHANCER_ENGINE',
	model: 'PROMPT_ENHANCER_MODEL',
	effort: 'PROMPT_ENHANCER_EFFORT',
	claude: 'PROMPT_ENHANCER_CLAUDE',
	omp: 'PROMPT_ENHANCER_OMP',
	token: 'PROMPT_ENHANCER_OAUTH_TOKEN',
};

export function resolveEngine(env = process.env) {
	const raw = String(env[ENV.engine] || 'antigravity').trim().toLowerCase();
	if (engines[raw]) return raw;
	throw new Error(`Unknown ${ENV.engine}: "${raw}". Expected one of: ${Object.keys(engines).join(', ')}.`);
}

export function resolveBin(engine, env = process.env) {
	if (engine === 'antigravity') return findAntigravityBin(env);
	if (engine === 'claude') return env[ENV.claude] || undefined;
	if (engine === 'omp') return env[ENV.omp] || undefined;
	return undefined;
}

export function enhanceEnv(engine, env = process.env) {
	return engine === 'claude' && env[ENV.token] ? { CLAUDE_CODE_OAUTH_TOKEN: env[ENV.token] } : {};
}

// The enhance request in an Antigravity PreInvocation payload, or null for normal prompts.
export function hookRequest(input) {
	const text = input?.lastUserInput ?? input?.prompt;
	return parseDraft(text) || parseSlashCommand(text);
}

export const draftImages = (draft, cwd) => coreDraftImages(draft, cwd, { hostName: 'Antigravity CLI', examplePrefix: '::e' });

// Terminates the turn before the model runs. Success renders inline user_markdown (hidden from the model); failures and
// reminders emit an errorMessage step.
export function block(message, { isError = false } = {}) {
	return isError
		? { injectSteps: [{ errorMessage: { userMessage: message } }], terminationBehavior: 'terminate' }
		: { injectSteps: [{ systemMessage: { systemMessage: '', metadata: { user_markdown: message } } }], terminationBehavior: 'terminate' };
}

export function enhancedOutput(text, images = []) {
	return block(appendMissingImages(text, images), { isError: false });
}

export const emptyOutput = () => block(
	'Write a prompt after ::e (::en: no new tests or smoke runs, ::ef: fast, ::em: max, the best-in-class feature set) or /enhance (/enhance-notest, /enhance-fast, /enhance-max) first, e.g. `::e fix the login redirect`.',
	{ isError: true },
);

export function failedOutput(e, draft = '', env = process.env) {
	const suffix = draft ? `\n\nOriginal draft:\n${draft}` : '';
	if (e?.name === 'AbortError') return block(`Enhance cancelled.${suffix}`, { isError: true });
	const eng = String(env[ENV.engine] || 'antigravity').trim().toLowerCase();
	const binVar = eng === 'claude' ? ENV.claude : eng === 'omp' ? ENV.omp : ENV.antigravity;
	const binName = eng === 'claude' ? 'claude' : eng === 'omp' ? 'omp' : 'agy';
	let msg = /^spawn .+ ENOENT$/.test(e?.message) ? `${binName} not found. Set ${binVar} to the ${binName} executable.` : (e?.message || String(e));
	if (e?.api?.status === 401 || e?.api?.status === 403) {
		const why = `(HTTP ${e.api.status}${e.api.code ? ` ${e.api.code}` : ''})`;
		if (eng === 'claude') {
			msg += env[ENV.token]
				? `\n\nThe API refused ${ENV.token} ${why}. Make a new one with \`claude setup-token\`, signing in to the account and organization this session uses.`
				: `\n\nThe API refused the sign-in of \`${env[ENV.claude] || 'claude'}\` ${why}. Run \`claude setup-token\` and set ${ENV.token}, or sign in with \`claude auth login\`.`;
		} else {
			msg += `\n\nThe API refused the sign-in of \`${resolveBin('antigravity', env)}\` ${why}. Run \`agy\` interactively to sign in again, or check your Antigravity account permissions.`;
		}
	}
	return block(`Enhance failed: ${msg}${suffix}`, { isError: true });
}

export async function main() {
	let input;
	try {
		let raw = '';
		for await (const chunk of process.stdin) raw += chunk;
		input = JSON.parse(raw);
	} catch {
		process.stdout.write('{}');
		return;
	}
	const req = hookRequest(input);
	if (!req) {
		process.stdout.write('{}');
		return;
	}
	const { mode, draft } = req;

	let out;
	if (!draft) out = emptyOutput();
	else {
		const ctl = new AbortController();
		for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => ctl.abort());
		let messages = [], model;
		try {
			const jsonl = input.transcriptPath ? readFileSync(input.transcriptPath, 'utf8') : '';
			messages = transcriptMessages(jsonl);
			model = transcriptModel(jsonl);
		} catch {}
		if (!model && typeof input.modelName === 'string' && input.modelName && input.modelName !== 'auto') model = input.modelName;
		try {
			const engine = resolveEngine();
			const cwd = input.cwd || input.workspacePaths?.[0] || process.cwd();
			const images = draftImages(draft, cwd);
			const enhanced = await runEnhance({
				draft, messages, images, cwd, engine, mode,
				bin: resolveBin(engine),
				env: enhanceEnv(engine),
				model: process.env[ENV.model] || (engine === 'antigravity' ? model : undefined),
				thinking: process.env[ENV.effort] || undefined,
				signal: ctl.signal,
			});
			const body = appendMissingImages(enhanced, images);
			const copied = copyToClipboard(body);
			out = block(copied ? `Copied to the clipboard: paste it into the prompt box (Ctrl+V), edit it if you like, and send.\n\n${body}` : body, { isError: false });
		} catch (e) {
			out = failedOutput(e, draft);
		}
	}
	process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
