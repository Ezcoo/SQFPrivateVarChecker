import * as assert from 'assert';
import { analyze, analyzeFile } from '../analyzer/analyzer';
import { tokenize } from '../analyzer/tokenizer';

function names(source: string): string[] {
	return analyze(source).map(issue => issue.variable);
}

suite('tokenizer', () => {
	test('drops line and block comments', () => {
		const tokens = tokenize('// _a = 1;\n/* _b = 2; */ _c = 3;');
		assert.deepStrictEqual(tokens.map(t => t.value), ['_c', '=', '3', ';']);
	});

	test('keeps doubled quotes inside strings', () => {
		const tokens = tokenize('_a = "say ""hi""";');
		assert.strictEqual(tokens[2].type, 'string');
		assert.strictEqual(tokens[2].value, 'say "hi"');
	});

	test('does not split == into two assignments', () => {
		const tokens = tokenize('if (_a == 1) then {};');
		assert.ok(tokens.some(t => t.value === '=='));
		assert.ok(!tokens.some(t => t.value === '='));
	});

	test('skips preprocessor lines including continuations', () => {
		const tokens = tokenize('#define FOO(_x) \\\n    _x = 1\n_b = 2;');
		assert.deepStrictEqual(tokens.map(t => t.value), ['_b', '=', '2', ';']);
	});
});

suite('analyzer', () => {
	test('reports an undeclared local assignment', () => {
		assert.deepStrictEqual(names('_unit = player;'), ['_unit']);
	});

	test('accepts private _x', () => {
		assert.deepStrictEqual(names('private _unit = player;'), []);
	});

	test('accepts private ["_a", "_b"]', () => {
		assert.deepStrictEqual(names('private ["_a", "_b"];\n_a = 1;\n_b = 2;'), []);
	});

	test('accepts params, including defaults', () => {
		assert.deepStrictEqual(names('params ["_unit", ["_count", 0]];\n_unit = player;\n_count = 3;'), []);
	});

	test('accepts for loop counters', () => {
		assert.deepStrictEqual(names('for "_i" from 0 to 10 do { _i = _i + 1; };'), []);
	});

	test('ignores magic variables', () => {
		assert.deepStrictEqual(names('{ _x = _x + 1; } forEach [1,2];\n_this = 1;'), []);
	});

	test('is case insensitive like the engine', () => {
		assert.deepStrictEqual(names('PRIVATE _Unit = player;\n_unit = objNull;'), []);
	});

	test('sees outer declarations from an inner scope', () => {
		assert.deepStrictEqual(names('private _unit = player;\nif (true) then { _unit = objNull; };'), []);
	});

	test('does not leak inner declarations to the outer scope', () => {
		assert.deepStrictEqual(names('if (true) then { private _unit = player; };\n_unit = objNull;'), ['_unit']);
	});

	test('ignores comparisons and reads', () => {
		assert.deepStrictEqual(names('if (_unit == player) then { hint str _unit; };'), []);
	});

	test('ignores locals mentioned inside strings', () => {
		assert.deepStrictEqual(names('hint "_unit = player";'), []);
	});

	test('reports each variable once per scope', () => {
		assert.deepStrictEqual(names('_unit = player;\n_unit = objNull;'), ['_unit']);
	});

	test('reports the position of the variable itself', () => {
		const source = 'private _a = 1;\n_b = 2;';
		const issues = analyze(source);
		assert.strictEqual(issues.length, 1);
		assert.strictEqual(source.slice(issues[0].start, issues[0].end), '_b');
	});

	test('honours treatParamsAsPrivate = false', () => {
		const issues = analyze('params ["_unit"];\n_unit = player;', { treatParamsAsPrivate: false });
		assert.deepStrictEqual(issues.map(i => i.variable), ['_unit']);
	});

	test('honours extra magic variables', () => {
		const issues = analyze('_fnc_custom = {};', { magicVariables: ['_fnc_custom'] });
		assert.deepStrictEqual(issues, []);
	});

	test('every issue from analyze() is a plain missing-private issue', () => {
		// analyze() only ever looks at one file, so it cannot know about duplicate
		// names in other files -- that is decided one layer up, from analyzeFile().
		const issues = analyze('if (a) then { _idx = 1; };\nif (b) then { _idx = 2; };');
		assert.ok(issues.every(issue => issue.kind === 'missing-private'));
	});
});

suite('analyzeFile - private/non-private name sets', () => {
	test('collects declared-private names regardless of form', () => {
		const result = analyzeFile(
			'private _a = 1;\nparams ["_b"];\nfor "_c" from 0 to 1 do {};'
		);
		assert.deepStrictEqual([...result.privateNames].sort(), ['_a', '_b', '_c']);
		assert.deepStrictEqual([...result.nonPrivateNames], []);
	});

	test('collects missing-private names', () => {
		const result = analyzeFile('_bad = 1;');
		assert.deepStrictEqual([...result.nonPrivateNames], ['_bad']);
		assert.deepStrictEqual([...result.privateNames], []);
	});

	test('a name can be both private and non-private in the same file', () => {
		// Two unrelated scopes: one declares it private, the other forgets to.
		// Whether that is worth flagging is a cross-file decision, not analyzeFile's.
		const result = analyzeFile('if (a) then { private _idx = 1; };\nif (b) then { _idx = 2; };');
		assert.ok(result.privateNames.has('_idx'));
		assert.ok(result.nonPrivateNames.has('_idx'));
	});

	test('name sets are lowercased', () => {
		const result = analyzeFile('private _A = 1;\n_B = 2;');
		assert.ok(result.privateNames.has('_a'));
		assert.ok(result.nonPrivateNames.has('_b'));
	});
});
