import * as assert from 'assert';
import { analyzeFile } from '../analyzer/analyzer';
import { createPathResolver, FileFacts, findScopeLeaks, FunctionSource } from '../scopeLeaks';

/** Builds the facts for a set of `path -> source` files, keyed by `file://` + path. */
function workspace(sources: Record<string, string>): Map<string, FileFacts> {
	const files = new Map<string, FileFacts>();
	for (const [path, text] of Object.entries(sources)) {
		const { issues, callSites, codeBlocks, flow } = analyzeFile(text);
		files.set(`file://${path}`, { path, issues, callSites, codeBlocks, flow });
	}
	return files;
}

function fn(name: string, path: string): FunctionSource {
	return { name: name.toLowerCase(), path, definedIn: '/m/description.ext' };
}

/** `file key -> sorted leaked variable names` for every leaking call. */
function leakingCalls(result: ReturnType<typeof findScopeLeaks>): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [key, calls] of result.calls) {
		out[key] = calls.flatMap(call => [...call.names.keys()]).sort();
	}
	return out;
}

suite('findScopeLeaks', () => {
	test('a callee overwriting a local visible at the call site is a leak', () => {
		const files = workspace({
			'/m/caller.sqf': 'private _count = 0;\n[] call TAG_fnc_callee;',
			'/m/functions/misc/fn_callee.sqf': '_count = 5;\n_unrelated = 1;'
		});
		const result = findScopeLeaks(files, [fn('TAG_fnc_callee', 'functions\\misc\\fn_callee.sqf')]);

		assert.deepStrictEqual(leakingCalls(result), { 'file:///m/caller.sqf': ['_count'] });
		const writes = result.writes.get('file:///m/functions/misc/fn_callee.sqf')!;
		assert.strictEqual(writes.size, 1);
		const [affected] = [...writes.values()];
		assert.strictEqual(affected[0].callerKey, 'file:///m/caller.sqf');
		assert.deepStrictEqual(affected[0].chain, ['TAG_fnc_callee']);
	});

	test('no leak when the callee declares its variable private', () => {
		const files = workspace({
			'/m/caller.sqf': 'private _count = 0;\ncall TAG_fnc_callee;',
			'/m/fn_callee.sqf': 'private _count = 5;'
		});
		const result = findScopeLeaks(files, [fn('TAG_fnc_callee', 'fn_callee.sqf')]);
		assert.deepStrictEqual(leakingCalls(result), {});
	});

	test('no leak when the caller has no such variable at the call site', () => {
		const files = workspace({
			'/m/caller.sqf': 'call TAG_fnc_callee;\nprivate _count = 0;',
			'/m/fn_callee.sqf': '_count = 5;'
		});
		const result = findScopeLeaks(files, [fn('TAG_fnc_callee', 'fn_callee.sqf')]);
		assert.deepStrictEqual(leakingCalls(result), {});
	});

	test('a variable assigned after the call only leaks into later calls', () => {
		const files = workspace({
			'/m/caller.sqf': 'call TAG_fnc_callee;\n_count = 0;\ncall TAG_fnc_callee;',
			'/m/fn_callee.sqf': '_count = 5;'
		});
		const result = findScopeLeaks(files, [fn('TAG_fnc_callee', 'fn_callee.sqf')]);

		const [leak, ...rest] = result.calls.get('file:///m/caller.sqf')!;
		assert.strictEqual(rest.length, 0);
		assert.deepStrictEqual([...leak.names.keys()], ['_count']);
		assert.strictEqual(leak.callSite.start, 'call TAG_fnc_callee;\n_count = 0;\n'.length);
	});

	test('no leak when the variable is assigned after the call inside a loop body', () => {
		const files = workspace({
			'/m/caller.sqf': 'while {true} do {\n\tcall TAG_fnc_callee;\n\tprivate _count = 0;\n};',
			'/m/fn_callee.sqf': '_count = 5;'
		});
		const result = findScopeLeaks(files, [fn('TAG_fnc_callee', 'fn_callee.sqf')]);
		assert.deepStrictEqual(leakingCalls(result), {});
	});

	test('follows the chain any number of calls deep', () => {
		const files = workspace({
			'/m/a.sqf': 'private _result = 0;\ncall TAG_fnc_b;',
			'/m/b.sqf': 'private _other = 0;\ncall TAG_fnc_c;',
			'/m/c.sqf': 'call TAG_fnc_d;',
			'/m/d.sqf': '_result = 42;'
		});
		const result = findScopeLeaks(files, [
			fn('TAG_fnc_b', 'b.sqf'),
			fn('TAG_fnc_c', 'c.sqf'),
			fn('TAG_fnc_d', 'd.sqf')
		]);

		assert.deepStrictEqual(leakingCalls(result), { 'file:///m/a.sqf': ['_result'] });
		const [affected] = [...result.writes.get('file:///m/d.sqf')!.values()];
		assert.deepStrictEqual(affected[0].chain, ['TAG_fnc_b', 'TAG_fnc_c', 'TAG_fnc_d']);
	});

	test('a leak stops at the first frame that has the variable', () => {
		const files = workspace({
			'/m/a.sqf': 'private _x1 = 0;\ncall TAG_fnc_b;',
			'/m/b.sqf': 'private _x1 = 0;\ncall TAG_fnc_c;',
			'/m/c.sqf': '_x1 = 1;'
		});
		const result = findScopeLeaks(files, [fn('TAG_fnc_b', 'b.sqf'), fn('TAG_fnc_c', 'c.sqf')]);
		assert.deepStrictEqual(leakingCalls(result), { 'file:///m/b.sqf': ['_x1'] });
	});

	test('follows call compile preprocessFileLineNumbers "file.sqf"', () => {
		const files = workspace({
			'/m/init.sqf': 'private _unit = player;\ncall compile preprocessFileLineNumbers "scripts\\setup.sqf";',
			'/m/scripts/setup.sqf': '_unit = objNull;'
		});
		assert.deepStrictEqual(leakingCalls(findScopeLeaks(files, [])), { 'file:///m/init.sqf': ['_unit'] });
	});

	test('survives recursion', () => {
		const files = workspace({
			'/m/a.sqf': 'private _n = 0;\ncall TAG_fnc_a;\n_n2 = 1;'
		});
		const result = findScopeLeaks(files, [fn('TAG_fnc_a', 'a.sqf')]);
		assert.deepStrictEqual(leakingCalls(result), {});
	});

	test('writes inside spawned code do not reach the caller', () => {
		const files = workspace({
			'/m/caller.sqf': 'private _count = 0;\ncall TAG_fnc_callee;',
			'/m/fn_callee.sqf': '[] spawn { _count = 5; };'
		});
		assert.deepStrictEqual(leakingCalls(findScopeLeaks(files, [fn('TAG_fnc_callee', 'fn_callee.sqf')])), {});
	});
});

suite('findScopeLeaks - local code', () => {
	test('a local code block overwriting a variable where it is called is a leak', () => {
		const files = workspace({
			'/m/a.sqf': 'private _fnc = { _count = 5; };\nprivate _count = 0;\ncall _fnc;'
		});
		const result = findScopeLeaks(files, []);
		assert.deepStrictEqual(leakingCalls(result), { 'file:///m/a.sqf': ['_count'] });
		// The write is also a missing-private issue, so it gets the scope leak diagnostic.
		const [affected] = [...result.writes.get('file:///m/a.sqf')!.values()];
		assert.deepStrictEqual(affected[0].chain, ['_fnc']);
	});

	test('also when the variable is declared before the block, so the write is not a missing-private issue', () => {
		const files = workspace({
			'/m/a.sqf': 'private _count = 0;\nprivate _fnc = { _count = 5; };\ncall _fnc;'
		});
		assert.deepStrictEqual(leakingCalls(findScopeLeaks(files, [])), { 'file:///m/a.sqf': ['_count'] });
	});

	test('no leak when the block declares its variable private', () => {
		const files = workspace({
			'/m/a.sqf': 'private _count = 0;\nprivate _fnc = { private _count = 5; };\ncall _fnc;'
		});
		assert.deepStrictEqual(leakingCalls(findScopeLeaks(files, [])), {});
	});

	test('follows a local holding a compiled file', () => {
		const files = workspace({
			'/m/a.sqf': 'private _fnc = compile preprocessFileLineNumbers "b.sqf";\nprivate _unit = 1;\ncall _fnc;',
			'/m/b.sqf': '_unit = 2;'
		});
		assert.deepStrictEqual(leakingCalls(findScopeLeaks(files, [])), { 'file:///m/a.sqf': ['_unit'] });
	});

	test('follows code blocks calling each other and global functions', () => {
		const files = workspace({
			'/m/a.sqf':
				'private _helper = { call TAG_fnc_b; };\n' +
				'private _main = { call _helper; };\n' +
				'private _result = 0;\n' +
				'call _main;',
			'/m/b.sqf': '_result = 1;'
		});
		const result = findScopeLeaks(files, [fn('TAG_fnc_b', 'b.sqf')]);
		assert.deepStrictEqual(leakingCalls(result), { 'file:///m/a.sqf': ['_result'] });
		const [affected] = [...result.writes.get('file:///m/b.sqf')!.values()];
		assert.deepStrictEqual(affected[0].chain, ['_main', '_helper', 'TAG_fnc_b']);
	});

	test('a code block called at the top of a file leaks on into that file\'s caller', () => {
		const files = workspace({
			'/m/a.sqf': 'private _count = 0;\ncall TAG_fnc_b;',
			'/m/b.sqf': 'private _fnc = { _count = 1; };\ncall _fnc;'
		});
		const result = findScopeLeaks(files, [fn('TAG_fnc_b', 'b.sqf')]);
		assert.deepStrictEqual(leakingCalls(result), { 'file:///m/a.sqf': ['_count'] });
		const [affected] = [...result.writes.get('file:///m/b.sqf')!.values()];
		assert.deepStrictEqual(affected[0].chain, ['TAG_fnc_b', '_fnc']);
	});
});

/** `variable name -> whether its overwritten value may be read afterwards`, over every leaking call. */
function liveness(result: ReturnType<typeof findScopeLeaks>): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	for (const calls of result.calls.values()) {
		for (const call of calls) {
			for (const [name, origins] of call.names) {
				out[name] = origins.some(origin => origin.state === 'live');
			}
		}
	}
	return out;
}

/** Liveness of `_count` when `caller` calls TAG_fnc_callee, which assigns `_count` without private. */
function countLiveness(caller: string, callee = '_count = 5;', extra: Record<string, string> = {}): boolean | undefined {
	const files = workspace({ '/m/caller.sqf': caller, '/m/fn_callee.sqf': callee, ...extra });
	const functions = [fn('TAG_fnc_callee', 'fn_callee.sqf')].concat(
		Object.keys(extra).map(path => fn(`TAG_fnc_${path.slice(path.lastIndexOf('_') + 1, -4)}`, path.slice(3)))
	);
	return liveness(findScopeLeaks(files, functions))._count;
}

suite('findScopeLeaks - is the overwritten value read afterwards', () => {
	test('not when nothing uses the variable after the call', () => {
		assert.strictEqual(countLiveness('private _count = 0;\ncall TAG_fnc_callee;'), false);
	});

	test('when it is read after the call', () => {
		assert.strictEqual(countLiveness('private _count = 0;\ncall TAG_fnc_callee;\nhint str _count;'), true);
	});

	test('when it is read inside a later block that may run', () => {
		assert.strictEqual(countLiveness('private _count = 0;\ncall TAG_fnc_callee;\nif (a) then { hint str _count; };'), true);
	});

	test('when it is mentioned in a string', () => {
		assert.strictEqual(countLiveness('private _count = 0;\ncall TAG_fnc_callee;\nif (isNil "_count") then {};'), true);
		assert.strictEqual(countLiveness('private _count = 0;\ncall TAG_fnc_callee;\ncall compile "hint str _count";'), true);
	});

	test('not when it is overwritten before being read', () => {
		assert.strictEqual(countLiveness('private _count = 0;\ncall TAG_fnc_callee;\n_count = 1;\nhint str _count;'), false);
		assert.strictEqual(countLiveness('private _count = 0;\n_count = [] call TAG_fnc_callee;\nhint str _count;'), false);
	});

	test('when the overwriting assignment reads it first', () => {
		assert.strictEqual(countLiveness('private _count = 0;\ncall TAG_fnc_callee;\n_count = _count + 1;'), true);
	});

	test('when it is overwritten only conditionally', () => {
		assert.strictEqual(
			countLiveness('private _count = 0;\ncall TAG_fnc_callee;\nif (a) then { _count = 1; };\nhint str _count;'),
			true
		);
	});

	test('not after the scope holding it ends', () => {
		assert.strictEqual(
			countLiveness('if (a) then {\n\tprivate _count = 0;\n\tcall TAG_fnc_callee;\n};\nhint str _count;'),
			false
		);
	});

	test('not when only a new private variable of the same name is read', () => {
		assert.strictEqual(
			countLiveness('private _count = 0;\ncall TAG_fnc_callee;\nif (a) then { private _count = 1; hint str _count; };'),
			false
		);
		assert.strictEqual(countLiveness('private _count = 0;\ncall TAG_fnc_callee;\nfor "_count" from 1 to 2 do { hint str _count; };'), false);
	});

	test('when it is read earlier in an enclosing loop', () => {
		assert.strictEqual(countLiveness('private _count = 0;\nwhile {_count < 10} do { call TAG_fnc_callee; };'), true);
		assert.strictEqual(countLiveness('private _count = 0;\n{ hint str _count; call TAG_fnc_callee; } forEach [1, 2];'), true);
	});

	test('not in a block that runs once, or when the loop does not read it', () => {
		assert.strictEqual(countLiveness('private _count = 0;\nif (a) then { hint str _count; call TAG_fnc_callee; };'), false);
		assert.strictEqual(countLiveness('private _count = 0;\nfor "_i" from 1 to 3 do { call TAG_fnc_callee; };'), false);
	});

	test('when the callee itself reads it and runs again in a loop', () => {
		assert.strictEqual(
			countLiveness('private _count = 0;\nfor "_i" from 1 to 3 do { call TAG_fnc_callee; };', '_count = _count + 1;'),
			true
		);
	});

	test('when a later call reads it from this scope', () => {
		const caller = 'private _count = 0;\ncall TAG_fnc_callee;\ncall TAG_fnc_reader;';
		assert.strictEqual(countLiveness(caller, '_count = 5;', { '/m/fn_reader.sqf': 'hint str _count;' }), true);
		assert.strictEqual(
			countLiveness(caller, '_count = 5;', { '/m/fn_reader.sqf': 'params ["_count"];\nhint str _count;' }),
			false
		);
		assert.strictEqual(
			countLiveness(caller, '_count = 5;', { '/m/fn_reader.sqf': 'call TAG_fnc_deeper;', '/m/fn_deeper.sqf': 'hint str _count;' }),
			true
		);
	});

	test('when a later call runs a local code block that reads it', () => {
		assert.strictEqual(
			countLiveness('private _show = { hint str _count; };\nprivate _count = 0;\ncall TAG_fnc_callee;\ncall _show;'),
			true
		);
	});

	test('when a later call cannot be followed', () => {
		assert.strictEqual(countLiveness('params ["_code"];\nprivate _count = 0;\ncall TAG_fnc_callee;\ncall _code;'), true);
	});

	test('when the variable is not private itself, so it may be its own caller\'s', () => {
		assert.strictEqual(countLiveness('_count = 0;\ncall TAG_fnc_callee;'), true);
	});

	test('when a function in between on the call chain reads it after the call', () => {
		const leak = (b: string) =>
			liveness(
				findScopeLeaks(
					workspace({ '/m/a.sqf': 'private _r = 0;\ncall TAG_fnc_b;', '/m/b.sqf': b, '/m/d.sqf': '_r = 42;' }),
					[fn('TAG_fnc_b', 'b.sqf'), fn('TAG_fnc_d', 'd.sqf')]
				)
			)._r;
		assert.strictEqual(leak('call TAG_fnc_d;'), false);
		assert.strictEqual(leak('call TAG_fnc_d;\nhint str _r;'), true);
	});

	test('not for a write that a function in between overwrites before anyone reads it', () => {
		const files = workspace({
			'/m/a.sqf': 'private _r = 0;\ncall TAG_fnc_b;\nhint str _r;',
			'/m/b.sqf': 'call TAG_fnc_d;\n_r = 1;',
			'/m/d.sqf': '_r = 42;'
		});
		const result = findScopeLeaks(files, [fn('TAG_fnc_b', 'b.sqf'), fn('TAG_fnc_d', 'd.sqf')]);
		const liveAt = (key: string) => [...result.writes.get(key)!.values()][0][0].live;
		assert.strictEqual(liveAt('file:///m/d.sqf'), false);
		assert.strictEqual(liveAt('file:///m/b.sqf'), true);
	});

	test('marks each affected caller at the assignment', () => {
		const files = workspace({
			'/m/used.sqf': 'private _count = 0;\ncall TAG_fnc_callee;\nhint str _count;',
			'/m/unused.sqf': 'private _count = 0;\ncall TAG_fnc_callee;',
			'/m/fn_callee.sqf': '_count = 5;'
		});
		const result = findScopeLeaks(files, [fn('TAG_fnc_callee', 'fn_callee.sqf')]);
		const [affected] = [...result.writes.get('file:///m/fn_callee.sqf')!.values()];
		assert.deepStrictEqual(
			affected.map(a => [a.callerKey, a.live]).sort(),
			[['file:///m/unused.sqf', false], ['file:///m/used.sqf', true]]
		);
	});
});

suite('createPathResolver', () => {
	const files = new Map([
		['a', { path: '/ws/mission/functions/misc/fn_foo.sqf' }],
		['b', { path: '/ws/other/functions/misc/fn_foo.sqf' }],
		['c', { path: '/ws/addons/main/functions/fnc_bar.sqf' }]
	]);
	const resolve = createPathResolver(files);

	test('matches case- and separator-insensitively, preferring the nearest file', () => {
		assert.strictEqual(resolve('Functions\\Misc\\fn_foo.sqf', '/ws/mission/description.ext'), 'a');
		assert.strictEqual(resolve('functions\\misc\\fn_foo.sqf', '/ws/other/init.sqf'), 'b');
	});

	test('drops an addon prefix that is not part of the workspace layout', () => {
		assert.strictEqual(resolve('\\x\\tag\\addons\\main\\functions\\fnc_bar.sqf', '/ws/x.sqf'), 'c');
	});

	test('does not match on the file name alone', () => {
		assert.strictEqual(resolve('elsewhere\\fnc_bar.sqf', '/ws/x.sqf'), undefined);
	});
});
