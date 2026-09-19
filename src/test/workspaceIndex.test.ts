import * as assert from 'assert';
import { WorkspaceVariableIndex } from '../workspaceIndex';

suite('WorkspaceVariableIndex', () => {
	test('a name used in only one file is not flagged as used elsewhere', () => {
		const index = new WorkspaceVariableIndex();
		index.update('file:///a.sqf', new Set(['_idx']));
		assert.strictEqual(index.isUsedElsewhere('_idx', 'file:///a.sqf'), false);
	});

	test('a name reused by another file is flagged from both sides', () => {
		const index = new WorkspaceVariableIndex();
		index.update('file:///a.sqf', new Set(['_idx']));
		index.update('file:///b.sqf', new Set(['_idx']));

		assert.strictEqual(index.isUsedElsewhere('_idx', 'file:///a.sqf'), true);
		assert.strictEqual(index.isUsedElsewhere('_idx', 'file:///b.sqf'), true);
		assert.deepStrictEqual(index.otherFiles('_idx', 'file:///a.sqf'), ['file:///b.sqf']);
	});

	test('reusing the same name twice within one file does not count as "elsewhere"', () => {
		const index = new WorkspaceVariableIndex();
		index.update('file:///a.sqf', new Set(['_idx']));
		assert.strictEqual(index.isUsedElsewhere('_idx', 'file:///a.sqf'), false);
	});

	test('a later update replaces what was previously known about a file', () => {
		const index = new WorkspaceVariableIndex();
		index.update('file:///a.sqf', new Set(['_idx']));
		index.update('file:///b.sqf', new Set(['_idx']));
		// a.sqf no longer declares _idx at all.
		index.update('file:///a.sqf', new Set(['_other']));

		assert.strictEqual(index.isUsedElsewhere('_idx', 'file:///b.sqf'), false);
		assert.strictEqual(index.isUsedElsewhere('_other', 'file:///a.sqf'), false);
	});

	test('remove() forgets a file entirely', () => {
		const index = new WorkspaceVariableIndex();
		index.update('file:///a.sqf', new Set(['_idx']));
		index.update('file:///b.sqf', new Set(['_idx']));
		index.remove('file:///b.sqf');

		assert.strictEqual(index.isUsedElsewhere('_idx', 'file:///a.sqf'), false);
	});

	test('update() reports which names changed cross-file membership', () => {
		const index = new WorkspaceVariableIndex();
		index.update('file:///a.sqf', new Set(['_idx', '_stable']));
		const changed = index.update('file:///b.sqf', new Set(['_idx']));
		assert.deepStrictEqual([...changed], ['_idx']);
	});

	test('clear() forgets every file', () => {
		const index = new WorkspaceVariableIndex();
		index.update('file:///a.sqf', new Set(['_idx']));
		index.update('file:///b.sqf', new Set(['_idx']));
		index.clear();

		assert.strictEqual(index.isUsedElsewhere('_idx', 'file:///a.sqf'), false);
		assert.strictEqual(index.isUsedElsewhere('_idx', 'file:///b.sqf'), false);
	});
});
