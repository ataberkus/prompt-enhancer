import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	antigravityArgs, antigravityInput, engines, findAntigravityBin, modes, stepLabel,
} from '../core/enhance.mjs';
import { decide, refuse } from '../core/antigravity-guard.mjs';
import {
	draftImages, emptyOutput, enhancedOutput, failedOutput, hookRequest, resolveEngine, transcriptMessages, transcriptModel,
} from '../antigravity-cli/index.mjs';
import { COMMANDS, MODES, activateWith, formatError, resolveConfig } from '../antigravity/index.mjs';
import { packVsix } from '../antigravity/pack-vsix.mjs';

test('antigravity engine args, input and event parsing', t => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-enhancer-agy-'));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const img = path.join(cwd, 'shot.png');
	fs.writeFileSync(img, 'PNG');

	const args = antigravityArgs({ model: 'gemini-4-neon-medium', thinking: 'high', mode: 'max' });
	assert.deepEqual(args, [
		'--input-format', 'stream-json', '--output-format', 'stream-json',
		'--disable-slash-commands', '--print-timeout', '240s',
		'--model', 'gemini-4-neon-medium', '--effort', 'high', '-p', '',
	]);

	const line = antigravityInput('<draft>\nadd auth\n</draft>', [{ label: 'shot.png', file: img }], 'fast');
	const parsed = JSON.parse(line);
	assert.equal(parsed.event, 'user');
	assert.equal(parsed.message.role, 'user');
	assert.ok(parsed.message.content.includes('<instructions>\n'));
	assert.ok(parsed.message.content.includes('no smoke runs'));
	assert.ok(parsed.message.content.includes(`<images>\nshot.png: image 1 (${img})\n</images>`));

	const seen = [];
	const on = {
		step: (n, a) => seen.push(['step', n, a.AbsolutePath ?? a.Query]),
		answer: txt => seen.push(['answer', txt]),
		error: (m, api) => seen.push(['error', m, api]),
	};
	const ev = engines.antigravity.event;
	ev({ event: 'step_update', step_update: { state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: 'core/enhance.mjs' } } } }, on);
	ev({ event: 'step_update', step_update: { state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: 'core/enhance.mjs' } } } }, on);
	ev({ event: 'result', result: { status: 'SUCCESS', response: '# Request\nok' } }, on);
	ev({ event: 'result', result: { status: 'ERROR', error: 'HTTP 401 UNAUTHENTICATED: sign in required' } }, on);
	assert.deepEqual(seen, [
		['step', 'view_file', 'core/enhance.mjs'],
		['answer', '# Request\nok'],
		['error', 'HTTP 401 UNAUTHENTICATED: sign in required', { status: 401, code: 'UNAUTHENTICATED' }],
	]);
});

test('stepLabel formats Antigravity tool names and parameters', () => {
	const root = process.cwd();
	assert.equal(stepLabel('view_file', { AbsolutePath: path.join(root, 'core', 'enhance.mjs') }, root), 'reading core/enhance.mjs');
	assert.equal(stepLabel('read_file', { Path: path.join(root, 'README.md') }, root), 'reading README.md');
	assert.equal(stepLabel('grep_search', { Query: 'runEnhance' }, root), 'searching "runEnhance"');
	assert.equal(stepLabel('find_by_name', { Pattern: '*.mjs' }, root), 'listing *.mjs');
});

test('findAntigravityBin prefers override, execPath agy, ~/.gemini/bin/agy, then PATH', () => {
	assert.equal(findAntigravityBin({ PROMPT_ENHANCER_ANTIGRAVITY: '/custom/agy' }), '/custom/agy');
	assert.equal(findAntigravityBin({}, { execPath: '/opt/agy', exists: () => false }), '/opt/agy');
	assert.equal(findAntigravityBin({}, { execPath: '/usr/bin/node', homeDir: '/home/u', platform: 'linux', exists: p => p === path.join('/home/u', '.gemini', 'bin', 'agy') }), path.join('/home/u', '.gemini', 'bin', 'agy'));
	assert.equal(findAntigravityBin({}, { execPath: 'C:\\node\\node.exe', homeDir: 'C:\\Users\\u', platform: 'win32', exists: p => p === path.join('C:\\Users\\u', '.gemini', 'bin', 'agy.exe') }), path.join('C:\\Users\\u', '.gemini', 'bin', 'agy.exe'));
	assert.equal(findAntigravityBin({}, { execPath: '/usr/bin/node', exists: () => false }), 'agy');
});

test('antigravity guard allows repository lookups only and enforces lookup limits', t => {
	const root = fs.realpathSync.native(process.cwd());
	assert.equal(refuse('view_file', { AbsolutePath: path.join(root, 'core', 'enhance.mjs') }, root), '');
	assert.equal(refuse('read_file', { Path: 'README.md' }, root), '');
	assert.equal(refuse('grep_search', { SearchPath: 'core', Query: 'modes' }, root), '');
	assert.equal(refuse('find_by_name', { SearchDirectory: '.', Pattern: '*.mjs' }, root), '');
	assert.equal(refuse('view_file', { AbsolutePath: '.env.example' }, root), '');
	assert.match(refuse('run_command', { CommandLine: 'ls' }, root), /run_command is not available/);
	assert.match(refuse('write_to_file', { TargetFile: 'a.txt' }, root), /write_to_file is not available/);
	assert.match(refuse('call_mcp_tool', { ServerName: 'x' }, root), /call_mcp_tool is not available/);
	assert.match(refuse('view_file', { AbsolutePath: '.env' }, root), /\.env files/);
	assert.match(refuse('view_file', { AbsolutePath: 'config/.env.local' }, root), /\.env files/);
	assert.match(refuse('view_file', { AbsolutePath: '../other/README.md' }, root), /only paths inside/);
	assert.match(refuse('view_file', { AbsolutePath: '~/.ssh/id_rsa' }, root), /only paths inside/);
	assert.match(refuse('view_file', { AbsolutePath: 'https://example.com' }, root), /only paths inside/);

	for (const [limit, args] of [[12, []], [6, [6]]]) {
		const counter = path.join(os.tmpdir(), `prompt-enhancer-agy-guard-${process.pid}-${limit}.lookups`);
		t.after(() => fs.rmSync(counter, { force: true }));
		const call = () => decide({ toolCall: { name: 'find_by_name', args: { SearchDirectory: '.', Pattern: '*' } }, cwd: process.cwd() }, counter, ...args);
		for (let i = 0; i < limit; i++) assert.equal(call().decision, 'allow');
		const over = call();
		assert.equal(over.decision, 'deny');
		assert.equal(over.reason, 'Enhance guard: the lookup limit is used up; write the prompt with what you found.');
	}
});

test('antigravity-cli hookRequest, transcript parsing and outputs', t => {
	assert.deepEqual(hookRequest({ lastUserInput: '::e fix login' }), { mode: 'full', draft: 'fix login' });
	assert.deepEqual(hookRequest({ lastUserInput: '::en fix login' }), { mode: 'notest', draft: 'fix login' });
	assert.deepEqual(hookRequest({ lastUserInput: '::ef fix login' }), { mode: 'fast', draft: 'fix login' });
	assert.deepEqual(hookRequest({ lastUserInput: '::em music player' }), { mode: 'max', draft: 'music player' });
	assert.deepEqual(hookRequest({ lastUserInput: '/enhance fix login' }), { mode: 'full', draft: 'fix login' });
	assert.deepEqual(hookRequest({ lastUserInput: '/enhance-notest fix login' }), { mode: 'notest', draft: 'fix login' });
	assert.deepEqual(hookRequest({ lastUserInput: '/enhance-fast fix login' }), { mode: 'fast', draft: 'fix login' });
	assert.deepEqual(hookRequest({ lastUserInput: '/prompt-enhancer:enhance-max music player' }), { mode: 'max', draft: 'music player' });
	assert.deepEqual(hookRequest({ lastUserInput: '/enhance' }), { mode: 'full', draft: '' });
	assert.equal(hookRequest({ lastUserInput: 'normal prompt' }), null);

	const jsonl = [
		{ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\nfix the sync bug\n</USER_REQUEST>' },
		{ type: 'PLANNER_RESPONSE', source: 'MODEL', model: 'auto', content: '' },
		{ type: 'GENERIC', source: 'MODEL', content: 'tool output' },
		{ type: 'PLANNER_RESPONSE', source: 'MODEL', model: 'gemini-4-neon-medium', content: 'Options:\n1. pause' },
		{ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'pick 1' },
	].map(e => JSON.stringify(e)).join('\n') + '\n{not json';
	assert.deepEqual(transcriptMessages(jsonl), [
		{ role: 'user', text: 'fix the sync bug' },
		{ role: 'assistant', text: 'Options:\n1. pause' },
		{ role: 'user', text: 'pick 1' },
	]);
	assert.equal(transcriptModel(jsonl), 'gemini-4-neon-medium');

	const ok = enhancedOutput('# Request\nx');
	assert.equal(ok.terminationBehavior, 'terminate');
	assert.equal(ok.injectSteps[0].systemMessage.systemMessage, '');
	assert.equal(ok.injectSteps[0].systemMessage.metadata.user_markdown, '# Request\nx');

	assert.equal(emptyOutput().terminationBehavior, 'terminate');
	assert.ok(emptyOutput().injectSteps[0].errorMessage.userMessage.includes('::e'));

	const cancelled = failedOutput(Object.assign(new Error('Enhance cancelled.'), { name: 'AbortError' }), 'my draft');
	assert.equal(cancelled.terminationBehavior, 'terminate');
	assert.match(cancelled.injectSteps[0].errorMessage.userMessage, /Enhance cancelled\./);
	assert.match(cancelled.injectSteps[0].errorMessage.userMessage, /my draft/);

	const enoent = failedOutput(new Error('spawn agy ENOENT'), 'my draft', {});
	assert.match(enoent.injectSteps[0].errorMessage.userMessage, /PROMPT_ENHANCER_ANTIGRAVITY/);

	const authErr = failedOutput(Object.assign(new Error('Unauthorized'), { api: { status: 401, code: 'UNAUTHENTICATED' } }), 'my draft', {});
	assert.match(authErr.injectSteps[0].errorMessage.userMessage, /HTTP 401 UNAUTHENTICATED/);
	assert.match(authErr.injectSteps[0].errorMessage.userMessage, /Original draft:\nmy draft/);

	assert.equal(resolveEngine({}), 'antigravity');
	assert.equal(resolveEngine({ PROMPT_ENHANCER_ENGINE: 'claude' }), 'claude');
	assert.equal(resolveEngine({ PROMPT_ENHANCER_ENGINE: 'omp' }), 'omp');
	assert.throws(() => resolveEngine({ PROMPT_ENHANCER_ENGINE: 'unknown' }), /Unknown PROMPT_ENHANCER_ENGINE/);

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-enhancer-agy-img-'));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	assert.throws(() => draftImages('check [Image #1]', cwd), /Antigravity CLI does not pass pasted images/);
});

test('antigravity IDE extension: selection replace, restore, cancel, modified guard and InputBox fallback', async () => {
	assert.deepEqual(Object.keys(MODES), Object.keys(modes));

	const registered = new Map();
	const infos = [], warns = [], errors = [], statusUpdates = [];
	let clipboardText = '';
	let editorText = 'add dark mode';
	let selectionEmpty = false;
	let inputBoxValue;
	let warnPick;

	const vscode = {
		StatusBarAlignment: { Left: 1 },
		commands: {
			registerCommand: (id, fn) => { registered.set(id, fn); return { dispose() {} }; },
		},
		env: {
			clipboard: {
				readText: async () => clipboardText,
				writeText: async txt => { clipboardText = txt; },
			},
		},
		workspace: {
			workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
			getConfiguration: () => ({ get: (k, d) => d }),
			openTextDocument: async opts => opts,
		},
		window: {
			activeTextEditor: {
				document: { uri: { toString: () => 'file:///draft.md' }, getText: () => editorText },
				get selection() { return { isEmpty: selectionEmpty, start: { line: 0, character: 0 }, end: { line: 0, character: editorText.length } }; },
				edit: async fn => { fn({ replace: (_r, txt) => { editorText = txt; } }); return true; },
			},
			createStatusBarItem: () => ({
				text: '', command: '', tooltip: '',
				show() { statusUpdates.push(this.text); },
				hide() { statusUpdates.push('HIDDEN'); },
				dispose() {},
			}),
			showInputBox: async () => inputBoxValue,
			showInformationMessage: async msg => { infos.push(msg); },
			showWarningMessage: async msg => { warns.push(msg); return warnPick; },
			showErrorMessage: async msg => { errors.push(msg); },
			showTextDocument: async () => {},
		},
	};

	const cfg = resolveConfig(vscode, { PROMPT_ENHANCER_ENGINE: 'antigravity', PROMPT_ENHANCER_MODEL: 'gemini-4-neon-medium' });
	assert.equal(cfg.engine, 'antigravity');
	assert.equal(cfg.model, 'gemini-4-neon-medium');
	assert.match(formatError(Object.assign(new Error('Forbidden'), { api: { status: 403 } }), cfg, {}), /HTTP 403/);

	let enhanceFn = async ({ onStep }) => {
		onStep('reading core/enhance.mjs');
		return '# Request\nAdd dark mode';
	};
	activateWith({ subscriptions: [] }, vscode, { enhance: opts => enhanceFn(opts), env: {} });

	// 1. Enhance editor selection
	await registered.get(COMMANDS.full)();
	assert.equal(editorText, '# Request\nAdd dark mode');
	assert.equal(clipboardText, '# Request\nAdd dark mode');
	assert.ok(statusUpdates.some(s => s.includes('✨ Enhancing: reading core/enhance.mjs')));
	assert.equal(statusUpdates.at(-1), 'HIDDEN');

	// 2. Pressing shortcut again restores the original draft
	await registered.get(COMMANDS.full)();
	assert.equal(editorText, 'add dark mode');
	assert.equal(infos.at(-1), 'Restored your draft.');

	// 3. Pressing shortcut while running cancels with AbortError
	let aborted = false, started;
	const ready = new Promise(r => { started = r; });
	enhanceFn = ({ signal }) => new Promise((_res, rej) => {
		started();
		signal.addEventListener('abort', () => {
			aborted = true;
			rej(Object.assign(new Error('Enhance cancelled.'), { name: 'AbortError' }));
		});
	});
	const running = registered.get(COMMANDS.max)();
	await ready;
	await registered.get(COMMANDS.max)();
	await running;
	assert.equal(aborted, true);
	assert.equal(infos.at(-1), 'Enhance cancelled.');

	// 4. Modified-while-running asks before overwriting
	warnPick = undefined;
	enhanceFn = async () => {
		editorText = 'user changed it';
		return '# Request\nStale';
	};
	await registered.get(COMMANDS.fast)();
	assert.equal(editorText, 'user changed it');
	assert.ok(warns.some(w => w.includes('changed the prompt while it was being enhanced')));

	// 5. No editor selection -> InputBox + clipboard fallback + restore
	selectionEmpty = true;
	inputBoxValue = 'build a music player';
	enhanceFn = async () => '# Request\nMusic player spec';
	await registered.get(COMMANDS.max)();
	assert.equal(clipboardText, '# Request\nMusic player spec');
	await registered.get(COMMANDS.max)();
	assert.equal(clipboardText, 'build a music player');
	assert.equal(infos.at(-1), 'Restored your draft to the clipboard.');

	// 6. Error handling surfaces Enhance failed
	inputBoxValue = 'broken';
	enhanceFn = async () => { throw new Error('The enhancer returned no text.'); };
	await registered.get(COMMANDS.full)();
	assert.equal(errors.at(-1), 'Enhance failed: The enhancer returned no text.');
});

test('packVsix creates a valid ZIP archive containing manifest, extension and core files', t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-enhancer-vsix-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const out = packVsix(path.join(dir, 'test.vsix'));
	const buf = fs.readFileSync(out);
	assert.equal(buf.subarray(0, 4).toString('hex'), '504b0304');

	// Read central directory entry names from EOCD.
	const eocdOffset = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	assert.ok(eocdOffset >= 0);
	const totalEntries = buf.readUInt16LE(eocdOffset + 10);
	let cursor = buf.readUInt32LE(eocdOffset + 16);
	const names = [];
	for (let i = 0; i < totalEntries; i++) {
		assert.equal(buf.readUInt32LE(cursor), 0x02014b50);
		const nameLen = buf.readUInt16LE(cursor + 28);
		const extraLen = buf.readUInt16LE(cursor + 30);
		const commentLen = buf.readUInt16LE(cursor + 32);
		names.push(buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8'));
		cursor += 46 + nameLen + extraLen + commentLen;
	}
	for (const expected of [
		'[Content_Types].xml',
		'extension.vsixmanifest',
		'extension/package.json',
		'extension/antigravity/extension.cjs',
		'extension/antigravity/index.mjs',
		'extension/core/enhance.mjs',
	]) {
		assert.ok(names.includes(expected), `missing ${expected}`);
	}
});
