import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipIcons, draftAttachments, keepAttachments } from '../omp/index.mjs';

test('enhance keeps composer attachments: chips go to the enhancer as markers and come back, dropped ones are appended', () => {
	const icons = chipIcons({ symbol: k => ({ 'chip.image': '🖼', 'chip.video': '🎞' })[k] });
	const { text, refs } = draftAttachments('🖼 #1 image was this, 🖼 #12 too, see 🎞 #2 and [Image #3, 10x20]', icons);
	assert.equal(text, '[Image #1] image was this, [Image #12] too, see [Video #2] and [Image #3, 10x20]');

	assert.equal(keepAttachments('Match [Image #1] and [Image #12].', refs),
		'Match 🖼 #1 and 🖼 #12.\n\n🎞 #2 [Image #3, 10x20]');
	// A marker the model wrote with dims still counts; an unknown index stays as written.
	assert.equal(keepAttachments('[Image #1, 5x5] [Image #3] [Video #2] 🖼 #12 [Image #9]', refs),
		'[Image #1, 5x5] [Image #3, 10x20] 🎞 #2 🖼 #12 [Image #9]');
	assert.equal(keepAttachments('plain', draftAttachments('no attachments', icons).refs), 'plain');
});
