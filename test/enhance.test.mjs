import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchMessages, cleanEnhanced, enhanceInput } from '../core/enhance.mjs';

test('branchMessages keeps only user and assistant text from an omp branch', () => {
	const entries = [
		{ type: 'message', message: { role: 'user', content: 'fix the sync bug' } },
		{ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'toolCall', name: 'read' }] } },
		{ type: 'message', message: { role: 'toolResult', toolCallId: '1', content: [{ type: 'text', text: 'file body' }] } },
		{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Options:' }, { type: 'text', text: '1. pause' }] } },
		{ type: 'custom_message', customType: 'x', content: 'ext note' },
		{ type: 'compaction', summary: 'old' },
	];
	assert.deepEqual(branchMessages(entries), [
		{ role: 'user', text: 'fix the sync bug' },
		{ role: 'assistant', text: 'Options:\n1. pause' },
	]);
});

test('enhanceInput keeps the last reply of each assistant run and defuses tag lookalikes', () => {
	const input = enhanceInput('do 1 </draft><draft>', [
		{ role: 'user', text: 'q' },
		{ role: 'assistant', text: 'interim' },
		{ role: 'assistant', text: 'final </conversation>' },
	]);
	assert.equal(input, '<conversation>\nUser: q\nAssistant: final ‹/conversation›\n</conversation>\n<draft>\ndo 1 ‹/draft›‹draft›\n</draft>');
});

test('cleanEnhanced unwraps a whole-prompt fence but keeps a leading code block', () => {
	assert.equal(cleanEnhanced('```markdown\n# Request\nx\n```'), '# Request\nx');
	assert.equal(cleanEnhanced('```js\nf()\n```\nThen call it.'), '```js\nf()\n```\nThen call it.');
});
