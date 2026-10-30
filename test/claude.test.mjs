import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { draftImages, emptyOutput, enhancedOutput, failedOutput, parseDraft, transcriptMessages, transcriptModel } from '../claude/index.mjs';
import { decide, refuse } from '../core/claude-guard.mjs';
import { claudeArgs, claudeInput, engines } from '../core/enhance.mjs';

test('transcriptMessages keeps only user and assistant chat text from a Claude Code transcript', () => {
	const jsonl = [
		{ type: 'user', message: { role: 'user', content: 'fix the sync bug' } },
		{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } },
		{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
		{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'file body' }] } },
		{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Options:' }, { type: 'text', text: '1. pause' }] } },
		{ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: '[Image: source: x.png]' }] } },
		{ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary of earlier chat' } },
		{ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } },
		{ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
		{ type: 'system', subtype: 'local_command', content: '<local-command-stdout>ok</local-command-stdout>' },
		{ type: 'user', message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'pick 1' }] } },
	].map(e => JSON.stringify(e)).join('\n') + '\n{not json';
	assert.deepEqual(transcriptMessages(jsonl), [
		{ role: 'user', text: 'fix the sync bug' },
		{ role: 'assistant', text: 'Options:\n1. pause' },
		{ role: 'user', text: 'pick 1' },
	]);
});

test('parseDraft takes the text after a leading ::e and ignores other prompts', () => {
	assert.equal(parseDraft('::e fix the\nlogin bug '), 'fix the\nlogin bug');
	assert.equal(parseDraft('  ::e\n\nmultiline'), 'multiline');
	assert.equal(parseDraft('::e'), '');
	assert.equal(parseDraft('::e   \n'), '');
	assert.equal(parseDraft('::eat this'), null);
	assert.equal(parseDraft('please ::e this'), null);
	assert.equal(parseDraft(undefined), null);
});

test('hook outputs always block; only a success hides the draft', () => {
	assert.deepEqual(enhancedOutput('# Request\nx'), {
		decision: 'block', reason: '# Request\nx', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
	});
	const cancelled = failedOutput(Object.assign(new Error('Enhance cancelled.'), { name: 'AbortError' }));
	assert.equal(cancelled.decision, 'block');
	assert.equal(cancelled.reason, 'Enhance cancelled.');
	assert.equal(cancelled.hookSpecificOutput.suppressOriginalPrompt, false);
	const failed = failedOutput(new Error('Enhance timed out.'));
	assert.equal(failed.reason, 'Enhance failed: Enhance timed out.');
	assert.equal(failed.hookSpecificOutput.suppressOriginalPrompt, false);
	assert.equal(failedOutput(new Error('spawn claude ENOENT')).reason, 'Enhance failed: claude not found. Set PROMPT_ENHANCER_CLAUDE to the claude executable.');
	assert.match(emptyOutput().reason, /^Write a prompt after ::e first/);
	assert.equal(emptyOutput().decision, 'block');
});

test('transcriptModel is the last real assistant model of the main session', () => {
	const jsonl = [
		{ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [] } },
		{ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [] } },
		{ type: 'assistant', isSidechain: true, message: { role: 'assistant', model: 'claude-haiku-4-5', content: [] } },
		{ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [] } },
	].map(e => JSON.stringify(e)).join('\n');
	assert.equal(transcriptModel(jsonl), 'claude-opus-5-5');
	assert.equal(transcriptModel(''), undefined);
});

test('claude engine events: tool_use is a step, result is the answer or the failure', () => {
	const seen = [];
	const on = { step: (n, a) => seen.push(['step', n, a.file_path]), answer: t => seen.push(['answer', t]), error: m => seen.push(['error', m]) };
	const ev = engines.claude.event;
	ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.js' } }] } }, on);
	ev({ type: 'result', subtype: 'success', is_error: false, result: '# Request' }, on);
	ev({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low' }, on);
	ev({ type: 'result', subtype: 'error_max_turns', is_error: true }, on);
	assert.deepEqual(seen, [['step', 'Read', 'a.js'], ['answer', '# Request'], ['error', 'Credit balance is too low'], ['error', 'error_max_turns']]);
});

test('draft images: existing image paths in the draft ride in one stream-json message', t => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-enhancer-img-'));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	fs.mkdirSync(path.join(cwd, 'my shots'));
	fs.writeFileSync(path.join(cwd, 'a.PNG'), 'PNG');
	fs.writeFileSync(path.join(cwd, 'my shots', 'b.jpeg'), 'JPG');
	const abs = path.join(cwd, 'my shots', 'b.jpeg');
	const images = draftImages(`match @a.PNG, then "my shots/b.jpeg" (also "${abs}"); add logo.png and see a.PNG`, cwd);
	assert.deepEqual(images, [{ label: 'a.PNG', file: path.join(cwd, 'a.PNG') }, { label: 'my shots/b.jpeg', file: abs }]);
	assert.deepEqual(draftImages('no images here', cwd), []);
	assert.throws(() => draftImages('like this [Image #1]', cwd), /does not pass pasted images/);

	assert.equal(claudeInput('<draft>x</draft>'), '<draft>x</draft>');
	const msg = JSON.parse(claudeInput('<draft>x</draft>', images));
	assert.deepEqual(msg.message.content.map(c => c.type === 'image' ? [c.source.media_type, Buffer.from(c.source.data, 'base64').toString()] : c.text),
		['a.PNG', ['image/png', 'PNG'], 'my shots/b.jpeg', ['image/jpeg', 'JPG'], '<draft>x</draft>']);
	assert.ok(claudeArgs({ lookups: 'L', images }).join(' ').includes('--input-format stream-json'));
	assert.ok(!claudeArgs({ lookups: 'L' }).includes('--input-format'));
	assert.equal(enhancedOutput('# Request\nsee `a.PNG`', images).reason, `# Request\nsee \`a.PNG\`\n\nImage: ${abs}`);
	assert.equal(enhancedOutput('# Request', []).reason, '# Request');
});

test('claude guard allows repository lookups only', () => {
	const root = fs.realpathSync.native(process.cwd());
	assert.equal(refuse('Read', { file_path: path.join(root, 'core', 'enhance.mjs') }, root), '');
	assert.equal(refuse('Grep', { pattern: 'x', path: 'core' }, root), '');
	assert.equal(refuse('Glob', { pattern: '**/*.mjs' }, root), '');
	assert.equal(refuse('Read', { file_path: '.env.example' }, root), '');
	assert.match(refuse('Bash', { command: 'ls' }, root), /Bash is not available/);
	assert.match(refuse('Read', { file_path: '.env' }, root), /\.env files/);
	assert.match(refuse('Read', { file_path: 'config/.env.local' }, root), /\.env files/);
	assert.match(refuse('Read', { file_path: '../other/README.md' }, root), /only paths inside/);
	assert.match(refuse('Read', { file_path: path.dirname(root) }, root), /only paths inside/);
	assert.match(refuse('Glob', { pattern: '../**/*.md' }, root), /only paths inside/);
	assert.match(refuse('Glob', { pattern: `${path.dirname(root).replace(/\\/g, '/')}/**` }, root), /only paths inside/);
	assert.match(refuse('Read', { file_path: '~/.ssh/id_rsa' }, root), /only paths inside/);
	assert.match(refuse('Read', { file_path: 'https://example.com' }, root), /only paths inside/);
});

test('claude guard denies every lookup after the 12th', t => {
	const counter = path.join(os.tmpdir(), `prompt-enhancer-test-${process.pid}.lookups`);
	t.after(() => fs.rmSync(counter, { force: true }));
	const call = () => decide({ tool_name: 'Glob', tool_input: { pattern: '*' }, cwd: process.cwd() }, counter).hookSpecificOutput;
	for (let i = 0; i < 12; i++) assert.equal(call().permissionDecision, 'allow');
	assert.deepEqual([call().permissionDecision, call().permissionDecisionReason], ['deny', 'Enhance guard: the lookup limit is used up; write the prompt with what you found.']);
});
