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

suite('analyzeFile - call sites and compiled functions', () => {
	test('records a call to a named function with the locals visible there', () => {
		const result = analyzeFile('private _a = 1;\nif (x) then { _b = 2; [] call TAG_fnc_foo; };\n_c = 3;');
		assert.strictEqual(result.callSites.length, 1);
		const [call] = result.callSites;
		assert.deepStrictEqual(call.target, { kind: 'function', name: 'tag_fnc_foo' });
		assert.strictEqual(call.label, 'TAG_fnc_foo');
		assert.deepStrictEqual([...call.visibleNames].sort(), ['_a', '_b']);
		assert.strictEqual(call.detached, false);
	});

	test('records a file compiled in place', () => {
		const result = analyzeFile('call compile preprocessFileLineNumbers "scripts\\foo.sqf";');
		assert.deepStrictEqual(result.callSites[0].target, { kind: 'file', path: 'scripts\\foo.sqf' });
	});

	test('does not record inline code as a call', () => {
		const result = analyzeFile('call { _a = 1; };');
		assert.deepStrictEqual(result.callSites, []);
	});

	test('follows a local assigned a code block exactly once', () => {
		const result = analyzeFile('private _f = { _a = 1; private _b = 2; _b = 3; };\ncall _f;');
		assert.deepStrictEqual(result.callSites.map(call => call.target), [{ kind: 'code', block: 0 }]);
		assert.deepStrictEqual(result.codeBlocks[0].writes.map(write => write.variable), ['_a']);
	});

	test('a code block\'s writes include names only declared outside it', () => {
		const result = analyzeFile('private _a = 0;\n_f = { _a = 1; };\ncall _f;');
		assert.deepStrictEqual(result.codeBlocks[0].writes.map(write => write.variable), ['_a']);
	});

	test('follows a local assigned a compiled file', () => {
		const result = analyzeFile('private _f = compile preprocessFileLineNumbers "a.sqf";\ncall _f;');
		assert.deepStrictEqual(result.callSites[0].target, { kind: 'file', path: 'a.sqf' });
	});

	test('does not follow a local assigned more than once', () => {
		const result = analyzeFile('private _f = {};\nif (x) then { _f = { _a = 1; }; };\ncall _f;');
		assert.deepStrictEqual(result.callSites, []);
	});

	test('does not follow a local that is not reachable from the call', () => {
		const result = analyzeFile('private _f = {};\n[] spawn { call _f; };\ncall _g;');
		assert.deepStrictEqual(result.callSites, []);
	});

	test('calls made inside a code block belong to it', () => {
		const result = analyzeFile('private _h = {};\nprivate _m = { call _h; call TAG_fnc_x; };\ncall _m;');
		assert.deepStrictEqual(
			result.callSites.map(call => [call.label, call.codeBlock]),
			[['_h', 1], ['TAG_fnc_x', 1], ['_m', undefined]]
		);
	});

	test('records functions defined with compile', () => {
		const result = analyzeFile(
			'TAG_fnc_a = compile preprocessFileLineNumbers "a.sqf";\n' +
				'TAG_fnc_b = compileFinal preprocessFile "b.sqf";\n' +
				'missionNamespace setVariable ["TAG_fnc_c", compile preprocessFileLineNumbers "c.sqf"];\n' +
				'_local = compile preprocessFileLineNumbers "d.sqf";'
		);
		assert.deepStrictEqual(result.compiledFunctions, [
			{ name: 'tag_fnc_a', path: 'a.sqf' },
			{ name: 'tag_fnc_b', path: 'b.sqf' },
			{ name: 'tag_fnc_c', path: 'c.sqf' }
		]);
	});

	test('records compiled functions with any name and any nesting of compile commands', () => {
		const result = analyzeFile(
			'myFunction = compile (preprocessFileLineNumbers "a.sqf");\n' +
				'Some_Name = compileFinal compile preprocessFileLineNumbers "b.sqf";\n' +
				'x = compileScript ["c.sqf"];\n' +
				'missionNamespace setVariable ["do Stuff", compileFinal (preprocessFile "d.sqf"), true];\n' +
				'_fnc = compileFinal compile preprocessFileLineNumbers "e.sqf";\n' +
				'call _fnc;'
		);
		assert.deepStrictEqual(result.compiledFunctions, [
			{ name: 'myfunction', path: 'a.sqf' },
			{ name: 'some_name', path: 'b.sqf' },
			{ name: 'x', path: 'c.sqf' },
			{ name: 'do stuff', path: 'd.sqf' }
		]);
		assert.deepStrictEqual(result.callSites[0].target, { kind: 'file', path: 'e.sqf' });
	});

	test('assignments in blocks that run elsewhere do not reach the caller', () => {
		const issues = analyze(
			'[] spawn { _a = 1; };\n' +
				'_f = { _b = 1; };\n' +
				'player addEventHandler ["Killed", { _c = 1; }];\n' +
				'if (x) then [{ _d = 1; }, { _e = 1; }];\n' +
				'{ _g = 1; } forEach [1];'
		);
		const reaching = issues.filter(issue => issue.reachesCaller).map(issue => issue.variable);
		assert.deepStrictEqual(reaching, ['_f', '_d', '_e', '_g']);
	});

	test('a call inside a spawned block only sees the block\'s locals', () => {
		const result = analyzeFile('private _outer = 1;\n[] spawn { private _inner = 1; call TAG_fnc_x; };');
		assert.deepStrictEqual([...result.callSites[0].visibleNames], ['_inner']);
		assert.strictEqual(result.callSites[0].detached, true);
	});
});
