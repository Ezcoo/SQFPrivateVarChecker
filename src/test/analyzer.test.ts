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

	test('records functions defined as a global code block', () => {
		const result = analyzeFile(
			'TAG_fnc_a = { _x1 = 1; private _y1 = 2; call TAG_fnc_b; };\n' +
				'TAG_fnc_b = {\n\tparams ["_p"];\n\t_x2 = _p;\n};\n' +
				'call TAG_fnc_a;'
		);
		assert.deepStrictEqual(result.codeFunctions, [
			{ name: 'tag_fnc_a', block: 0 },
			{ name: 'tag_fnc_b', block: 1 }
		]);
		assert.deepStrictEqual(
			result.codeBlocks.map(block => block.writes.map(write => write.variable)),
			[['_x1'], ['_x2']]
		);
		// Defining a function does not run it: nothing in it reaches this file's caller.
		assert.deepStrictEqual(result.issues.filter(issue => issue.reachesCaller), []);
		assert.deepStrictEqual(
			result.callSites.map(call => [call.label, call.codeBlock]),
			[['TAG_fnc_b', 0], ['TAG_fnc_a', undefined]]
		);
	});

	test('records functions defined with compileFinal or missionNamespace setVariable', () => {
		const result = analyzeFile(
			'TAG_fnc_a = compileFinal { _a = 1; };\n' +
				'missionNamespace setVariable ["TAG_fnc_b", { _b = 1; }];\n' +
				'missionNamespace setVariable ["TAG_fnc_c", compileFinal { _c = 1; }, true];\n' +
				// Not global functions: another namespace, an object, a computed name.
				'uiNamespace setVariable ["TAG_fnc_d", { _d = 1; }];\n' +
				'player setVariable ["TAG_fnc_e", { _e = 1; }];\n' +
				'missionNamespace setVariable [_name, { _f = 1; }];'
		);
		assert.deepStrictEqual(
			result.codeFunctions.map(fn => [fn.name, result.codeBlocks[fn.block].writes.map(write => write.variable)]),
			[['tag_fnc_a', ['_a']], ['tag_fnc_b', ['_b']], ['tag_fnc_c', ['_c']]]
		);
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

	test('event handlers that take their code directly run it in a scope of their own', () => {
		const result = analyzeFile(
			'private _v = 1;\n' +
				'"TAG_var" addPublicVariableEventHandler { _v = 2; call TAG_fnc_x; };\n' +
				'onPlayerConnected { _a = 1; };\n' +
				'player onMapSingleClick { _b = 1; };\n' +
				'onTeamSwitch { _c = 1; };\n' +
				'onHCGroupSelectionChanged { _d = 1; };\n' +
				'onGroupIconClick { _e = 1; };'
		);
		assert.deepStrictEqual(
			result.issues.map(issue => [issue.variable, issue.reachesCaller]),
			[['_a', false], ['_b', false], ['_c', false], ['_d', false], ['_e', false]]
		);
		// The script's own `_v` is out of reach of a call made in the handler.
		assert.deepStrictEqual([...result.callSites[0].visibleNames], []);
		assert.strictEqual(result.callSites[0].detached, true);
	});

	test('a call inside a spawned block only sees the block\'s locals', () => {
		const result = analyzeFile('private _outer = 1;\n[] spawn { private _inner = 1; call TAG_fnc_x; };');
		assert.deepStrictEqual([...result.callSites[0].visibleNames], ['_inner']);
		assert.strictEqual(result.callSites[0].detached, true);
	});
});

suite('analyzeFile - flow facts', () => {
	/** `repeats` of every block, in source order. */
	const repeats = (text: string) => analyzeFile(text).flow.scopes.slice(1).map(scope => scope.repeats);

	test('loops and other blocks that may run again repeat', () => {
		assert.deepStrictEqual(repeats('while {a} do {};'), [true, true]);
		assert.deepStrictEqual(repeats('{} forEach [1];\nwaitUntil {a};\n_a = [1] select {true};'), [true, true, true]);
		assert.deepStrictEqual(repeats('for "_i" from 0 to 1 do {};'), [true]);
	});

	test('blocks known to run at most once do not', () => {
		assert.deepStrictEqual(repeats('if (a) then {} else {};\nif (a) exitWith {};'), [false, false, false]);
		assert.deepStrictEqual(repeats('try {} catch {};\ncall {};\nif (a) then [{}, {}];'), [false, false, false, false, false]);
		assert.deepStrictEqual(repeats('switch (a) do { case 1: {}; default {}; };'), [false, false, false]);
	});

	test('a repeating block spans its whole statement', () => {
		const text = 'x = 1;\nwhile {_a < 1} do { call f; };\ny = 2;';
		const body = analyzeFile(text).flow.scopes[2];
		assert.strictEqual(text.slice(body.statementStart, body.statementEnd), 'while {_a < 1} do { call f; }');
	});

	test('assignments and declarations take effect at the end of their statement', () => {
		const text = 'private _a = 1;\n_a = _a + 1;';
		const events = analyzeFile(text).flow.events.map(e => [e.kind, text.slice(e.offset, e.offset + 1)]);
		assert.deepStrictEqual(events, [['declare', ';'], ['read', '_'], ['assign', ';']]);
	});

	test('code compiled from a string written in place is not a call that cannot be followed', () => {
		const calls = (text: string) => analyzeFile(text).flow.events.filter(e => e.kind === 'call').length;
		assert.strictEqual(calls('call compile "hint str _a";'), 0);
		assert.strictEqual(calls('Call Compile Format ["WFBE_PVF_%1 = _pvf; publicVariable \'WFBE_PVF_%1\';", _func];'), 0);
		assert.strictEqual(calls('call compile (format ["TAG_%1 = 1", _x]);'), 0);
		// A placeholder that can start a name of its own could be any local variable.
		assert.strictEqual(calls('call compile format ["%1 = 5", _name];'), 1);
		assert.strictEqual(calls('call compile _code;'), 1);
		assert.strictEqual(calls('call compile format [_template, 1];'), 1);
	});

	test('records reads in strings, calls that cannot be followed, but not inline calls', () => {
		const result = analyzeFile('isNil "_a";\ncall _unknown;\ncall {};\ncall TAG_fnc_x;');
		assert.deepStrictEqual(
			result.flow.events.map(e => (e.kind === 'call' ? 'call' : `${e.kind} ${e.name}`)),
			['read _a', 'call', 'read _unknown', 'call']
		);
	});
});
