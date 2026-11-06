import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchMessages, cleanEnhanced, enhanceInput, modes } from '../core/enhance.mjs';

// system.md is re-synced from omp-companion; notest must still swap out every passage that asks for new tests.
test('mode prompts: notest is the full spec up to Done when; notest and fast swap adding tests for light checks', () => {
	const full = modes.full.prompt(), notest = modes.notest.prompt(), fast = modes.fast.prompt();
	const head = p => p.slice(0, p.indexOf('4. **Done when**'));
	assert.ok(full.includes('4. **Done when**') && notest.includes('4. **Done when**'));
	assert.equal(head(notest), head(full));
	assert.match(full, /Add tests for the new behaviour/);
	for (const p of [notest, fast]) {
		assert.doesNotMatch(p, /Add tests for the new behaviour|regression check in Done when|\{\{/);
		assert.match(p, /no new tests unless the draft asks for them/);
		assert.match(p, /no smoke runs/);
	}
});

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
