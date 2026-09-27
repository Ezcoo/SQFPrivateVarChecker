import * as assert from 'assert';
import { analyzeFile } from '../analyzer/analyzer';
import { createPathResolver, FileFacts, findScopeLeaks, FunctionSource } from '../scopeLeaks';

/** Builds the facts for a set of `path -> source` files, keyed by `file://` + path. */
function workspace(sources: Record<string, string>): Map<string, FileFacts> {
	const files = new Map<string, FileFacts>();
	for (const [path, text] of Object.entries(sources)) {
		const { issues, callSites, codeBlocks } = analyzeFile(text);
		files.set(`file://${path}`, { path, issues, callSites, codeBlocks });
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
