import * as assert from 'assert';
import { analyzeFile } from '../analyzer/analyzer';
import { MissionRoots } from '../missions';
import { createPathResolver, FileFacts, findScopeLeaks, FunctionSource } from '../scopeLeaks';

/** Builds the facts for a set of `path -> source` files, keyed by `file://` + path. */
function workspace(sources: Record<string, string>): Map<string, FileFacts> {
	const files = new Map<string, FileFacts>();
	for (const [path, text] of Object.entries(sources)) {
		const { issues, callSites, codeBlocks, codeFunctions, flow } = analyzeFile(text);
		files.set(`file://${path}`, { path, issues, callSites, codeBlocks, codeFunctions, flow });
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

/**
 * Liveness of `_count` when `caller` (itself TAG_fnc_caller) calls TAG_fnc_callee, which assigns
 * `_count` without private. Each `extra` file `/m/fn_name.sqf` is TAG_fnc_name.
 */
function countLiveness(caller: string, callee = '_count = 5;', extra: Record<string, string> = {}): boolean | undefined {
	const files = workspace({ '/m/caller.sqf': caller, '/m/fn_callee.sqf': callee, ...extra });
	const functions = [fn('TAG_fnc_callee', 'fn_callee.sqf'), fn('TAG_fnc_caller', 'caller.sqf')].concat(
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

	test('not when a later call only compiles code written in place that does not mention it', () => {
		const caller = 'private _count = 0;\ncall TAG_fnc_callee;\ncall TAG_fnc_send;';
		const send = (code: string) => countLiveness(caller, '_count = 5;', { '/m/fn_send.sqf': code });
		assert.strictEqual(send('private _pvf = _this;\nCall Compile Format ["TAG_PVF_%1 = _pvf;", _pvf select 1];'), false);
		assert.strictEqual(send('call compile "hint str _count";'), true);
		assert.strictEqual(send('call compile format ["hint str %1", _name];'), true);
	});

	test('when a later call cannot be followed', () => {
		assert.strictEqual(countLiveness('params ["_code"];\nprivate _count = 0;\ncall TAG_fnc_callee;\ncall _code;'), true);
	});

	test('when the variable is not private itself, only if a caller of this file reads it', () => {
		const caller = '_count = 0;\ncall TAG_fnc_callee;';
		// Nobody calls the caller: its variables go with it.
		assert.strictEqual(countLiveness(caller), false);
		assert.strictEqual(
			countLiveness(caller, '_count = 5;', { '/m/fn_top.sqf': 'private _count = 1;\ncall TAG_fnc_caller;\nhint str _count;' }),
			true
		);
		assert.strictEqual(
			countLiveness(caller, '_count = 5;', { '/m/fn_top.sqf': 'private _count = 1;\ncall TAG_fnc_caller;' }),
			false
		);
		// Any number of calls up, through callers that do not have the variable either.
		assert.strictEqual(
			countLiveness(caller, '_count = 5;', {
				'/m/fn_middle.sqf': 'call TAG_fnc_caller;',
				'/m/fn_top.sqf': 'private _count = 1;\ncall TAG_fnc_middle;\nhint str _count;'
			}),
			true
		);
	});

	test('not when the file is only run by event handlers', () => {
		// Server_BuildingHandleDamages.sqf in a real mission: `_ammo` is left out of its
		// private list, but the file only ever runs as a handleDamage event handler.
		const files = workspace({
			'/m/init.sqf':
				'_site addEventHandler ["handleDamage", {[_this select 0, _this select 2, _this select 3] call BuildingHandleDamages}];',
			'/m/Server_BuildingHandleDamages.sqf':
				'private ["_building", "_dammages"];\n' +
				'_building = _this select 0;\n_dammages = _this select 1;\n_ammo = _this select 3;\n' +
				'_dammages = [_building, _dammages, _ammo] call HandleBuildingDamage;\n_dammages',
			'/m/Server_HandleBuildingDamage.sqf': 'private ["_building"];\n_ammo = _this select 2;\nswitch (_ammo) do {};'
		});
		const functions = [
			fn('BuildingHandleDamages', 'Server_BuildingHandleDamages.sqf'),
			fn('HandleBuildingDamage', 'Server_HandleBuildingDamage.sqf')
		];
		assert.deepStrictEqual(liveness(findScopeLeaks(files, functions)), { _ammo: false });
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

suite('findScopeLeaks - functions defined as code blocks', () => {
	test('a call to a function defined as TAG_fnc_foo = {...} runs its body', () => {
		const files = workspace({
			'/m/functions.sqf': 'TAG_fnc_other = { hint "x"; };\nTAG_fnc_count = {\n\t_count = 5;\n};',
			'/m/caller.sqf': 'private _count = 0;\ncall TAG_fnc_count;\nhint str _count;'
		});
		const result = findScopeLeaks(files, []);
		assert.deepStrictEqual(leakingCalls(result), { 'file:///m/caller.sqf': ['_count'] });
		assert.deepStrictEqual(liveness(result), { _count: true });
		const [affected] = [...result.writes.get('file:///m/functions.sqf')!.values()];
		assert.deepStrictEqual(affected[0].chain, ['TAG_fnc_count']);
	});

	test('functions in the same file calling each other', () => {
		const files = workspace({
			'/m/functions.sqf':
				'TAG_fnc_inner = { _result = 1; };\n' +
				'TAG_fnc_outer = { private _result = 0; call TAG_fnc_inner; _result };\n' +
				'TAG_fnc_safe = { private _unrelated = 0; call TAG_fnc_inner; };'
		});
		const result = findScopeLeaks(files, []);
		assert.deepStrictEqual(leakingCalls(result), { 'file:///m/functions.sqf': ['_result'] });
		assert.deepStrictEqual(liveness(result), { _result: true });
	});

	test('a later call to such a function can read the overwritten value', () => {
		const caller = 'private _count = 0;\ncall TAG_fnc_callee;\ncall TAG_fnc_show;';
		assert.strictEqual(countLiveness(caller, '_count = 5;', { '/m/show.sqf': 'TAG_fnc_show = { hint str _count; };' }), true);
		assert.strictEqual(
			countLiveness(caller, '_count = 5;', { '/m/show.sqf': 'TAG_fnc_show = { params ["_count"]; hint str _count; };' }),
			false
		);
	});

	test('a file that only defines functions does not leak by being run', () => {
		const files = workspace({
			'/m/init.sqf': 'private _count = 0;\ncall compile preprocessFileLineNumbers "functions.sqf";',
			'/m/functions.sqf': 'TAG_fnc_count = { _count = 5; };'
		});
		assert.deepStrictEqual(leakingCalls(findScopeLeaks(files, [])), {});
	});
});

suite('findScopeLeaks - several missions in one workspace', () => {
	// The same mission for two maps, and code shared by both.
	const files = () =>
		workspace({
			'/ws/chernarus/init.sqf': 'private _count = 0;\ncall TAG_fnc_count;\nhint str _count;',
			'/ws/chernarus/functions.sqf': 'TAG_fnc_count = { _count = 1; };',
			'/ws/lingor/init.sqf': 'private _count = 0;\ncall TAG_fnc_count;\ncall TAG_fnc_shared;\nhint str _count;',
			'/ws/lingor/functions.sqf': 'TAG_fnc_count = { private _count = 1; };',
			'/ws/shared/fn_shared.sqf': '_count = 2;'
		});
	const missions = new MissionRoots();
	missions.add('/ws/chernarus/mission.sqm');
	missions.add('/ws/lingor/mission.sqm');
	const functions = [fn('TAG_fnc_shared', 'shared\\fn_shared.sqf')];

	test('a call only runs functions of its own mission, or shared ones', () => {
		const result = findScopeLeaks(files(), functions, (a, b) => missions.related(a, b));
		assert.deepStrictEqual(leakingCalls(result), {
			'file:///ws/chernarus/init.sqf': ['_count'],
			'file:///ws/lingor/init.sqf': ['_count']
		});
		// Lingor's leak comes from the shared function, not from chernarus' TAG_fnc_count.
		const [lingor] = result.calls.get('file:///ws/lingor/init.sqf')!;
		assert.deepStrictEqual(lingor.names.get('_count')!.map(origin => origin.fileKey), ['file:///ws/shared/fn_shared.sqf']);
	});

	test('without missions, same-named functions of both are followed', () => {
		const result = findScopeLeaks(files(), functions);
		const lingor = result.calls.get('file:///ws/lingor/init.sqf')!;
		assert.deepStrictEqual(
			lingor.flatMap(call => call.names.get('_count')!.map(origin => origin.fileKey)).sort(),
			['file:///ws/chernarus/functions.sqf', 'file:///ws/shared/fn_shared.sqf']
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

suite('findScopeLeaks - harmless and deliberate leaks', () => {
	/** The kind of the leak of `name` from `/m/fn_callee.sqf` into `/m/caller.sqf`. */
	function kindOf(caller: string, callee: string, name: string, extra: Record<string, string> = {}) {
		const files = workspace({ '/m/caller.sqf': caller, '/m/fn_callee.sqf': callee, ...extra });
		const functions = [fn('TAG_fnc_callee', 'fn_callee.sqf'), ...Object.keys(extra).map(path => fn(`TAG_fnc_${path.slice(3, -4)}`, path.slice(3)))];
		const result = findScopeLeaks(files, functions);
		const [affected] = [...result.writes.get('file:///m/fn_callee.sqf')!.values()];
		const origin = result.calls.get('file:///m/caller.sqf')![0].names.get(name)![0];
		assert.strictEqual(origin.kind, affected[0].kind);
		return affected[0].kind;
	}

	test('same value: the callee only assigns what the call passes in for it', () => {
		const caller = 'private _id = 1;\n[_id, 5] call TAG_fnc_callee;\nhint str _id;';
		assert.strictEqual(kindOf(caller, '_id = _this select 0;\nhint str _id;', '_id'), 'same-value');
		assert.strictEqual(kindOf(caller, '_id = (_this # 0);\nhint str _id;', '_id'), 'same-value');
		assert.strictEqual(
			kindOf('private _id = 1;\n_id call TAG_fnc_callee;\nhint str _id;', '_id = _this;\nhint str _id;', '_id'),
			'same-value'
		);
	});

	test('not the same value when passed elsewhere, changed, or assigned again', () => {
		const read = '\nhint str _id;';
		assert.strictEqual(kindOf('private _id = 1;\n[5, _id] call TAG_fnc_callee;' + read, '_id = _this select 0;' + read, '_id'), undefined);
		assert.strictEqual(kindOf('private _id = 1;\n[_id] call TAG_fnc_callee;' + read, '_id = round (_this select 0);' + read, '_id'), undefined);
		assert.strictEqual(
			kindOf('private _id = 1;\n[_id] call TAG_fnc_callee;' + read, '_id = _this select 0;\n_id = _id + 1;' + read, '_id'),
			undefined
		);
	});

	test('intentional: the caller does not use its value before the call, and the callee never reads it back', () => {
		const caller = 'private _done = false;\ncall TAG_fnc_callee;\nif (_done) then { hint "done"; };';
		assert.strictEqual(kindOf(caller, 'if (x) then { _done = true; };', '_done'), 'intentional');
		// Code before the value is set does not count.
		assert.strictEqual(kindOf('hint str _done;\n' + caller, '_done = true;', '_done'), 'intentional');
	});

	test('not intentional when the caller uses its value before the call', () => {
		const caller = 'private _done = false;\nhint str _done;\ncall TAG_fnc_callee;\nhint str _done;';
		assert.strictEqual(kindOf(caller, '_done = true;', '_done'), undefined);
		// Also through a call in between that reads it, or cannot be followed.
		const between = (call: string) => `private _done = false;\n${call}\ncall TAG_fnc_callee;\nhint str _done;`;
		assert.strictEqual(kindOf(between('call TAG_fnc_show;'), '_done = true;', '_done', { '/m/show.sqf': 'hint str _done;' }), undefined);
		assert.strictEqual(kindOf(between('call TAG_fnc_show;'), '_done = true;', '_done', { '/m/show.sqf': 'hint "x";' }), 'intentional');
		assert.strictEqual(kindOf('params ["_code"];\n' + between('call _code;'), '_done = true;', '_done'), undefined);
	});

	test('not intentional when the callee reads back what it assigns', () => {
		const caller = 'private _done = false;\ncall TAG_fnc_callee;\nhint str _done;';
		assert.strictEqual(kindOf(caller, '_done = true;\nhint str _done;', '_done'), undefined);
		// In a loop, a read before the assignment comes after it on the next round.
		assert.strictEqual(kindOf(caller, 'while {x} do {\n\tif (_done) exitWith {};\n\t_done = true;\n};', '_done'), undefined);
		// Or by a function it calls afterwards.
		assert.strictEqual(
			kindOf(caller, '_done = true;\ncall TAG_fnc_show;', '_done', { '/m/show.sqf': 'hint str _done;' }),
			undefined
		);
	});

	test('only a leak straight from the called function is classified', () => {
		const files = workspace({
			'/m/a.sqf': 'private _done = false;\ncall TAG_fnc_b;\nhint str _done;',
			'/m/b.sqf': 'call TAG_fnc_d;',
			'/m/d.sqf': '_done = true;'
		});
		const result = findScopeLeaks(files, [fn('TAG_fnc_b', 'b.sqf'), fn('TAG_fnc_d', 'd.sqf')]);
		const [affected] = [...result.writes.get('file:///m/d.sqf')!.values()];
		assert.strictEqual(affected[0].kind, undefined);
	});

	test('a shared comment in the callee is no leak at all', () => {
		const files = workspace({
			'/m/caller.sqf': 'private _count = 0;\ncall TAG_fnc_callee;\nhint str _count;',
			'/m/fn_callee.sqf': '// sqf-private: shared _count\n_count = _count + 1;'
		});
		assert.deepStrictEqual(leakingCalls(findScopeLeaks(files, [fn('TAG_fnc_callee', 'fn_callee.sqf')])), {});
	});
});

suite('findScopeLeaks - branches that never both run', () => {
	const call = 'call TAG_fnc_callee;';

	test('not when it is only read in the other branch of an if', () => {
		assert.strictEqual(countLiveness(`private _count = 0;\nif (a) then { ${call} } else { hint str _count; };`), false);
		assert.strictEqual(countLiveness(`private _count = 0;\nif (a) then { hint str _count; } else { ${call} };`), false);
		assert.strictEqual(countLiveness(`private _count = 0;\nif (a) then [{ ${call} }, { hint str _count; }];`), false);
		// After the if statement, it runs whichever branch was taken.
		assert.strictEqual(
			countLiveness(`private _count = 0;\nif (a) then { ${call} } else { hint str _count; };\nhint str _count;`),
			true
		);
	});

	test('not when it is only read in another case of a switch', () => {
		assert.strictEqual(
			countLiveness(
				`private _count = 0;\nswitch (a) do {\n\tcase 1: { ${call} };\n\tcase 2: { hint str _count; };\n\tdefault { hint str _count; };\n};`
			),
			false
		);
	});

	test('when a loop around the if can run the other branch next', () => {
		const body = `if (b) then { ${call} } else { hint str _count; };`;
		assert.strictEqual(countLiveness(`private _count = 0;\nwhile {a} do { ${body} };`), true);
		// Unless the variable itself only lives for one round.
		assert.strictEqual(countLiveness(`while {a} do { private _count = 0; ${body} };`), false);
	});

	test('not when an exitWith block leaves the scope before the read', () => {
		assert.strictEqual(
			countLiveness(`private _count = 0;\nif (x) then {\n\tif (a) exitWith { ${call} };\n\thint str _count;\n};`),
			false
		);
		// It only leaves the then block: what comes after that still runs.
		assert.strictEqual(
			countLiveness(`private _count = 0;\nif (x) then {\n\tif (a) exitWith { ${call} };\n\thint str _count;\n};\nhint str _count;`),
			true
		);
	});

	test('not when an exitWith block leaves the loop it is in', () => {
		const loop = `private _count = 0;\nwhile {a} do {\n\thint str _count;\n\tif (b) exitWith { ${call} };\n};`;
		assert.strictEqual(countLiveness(loop), false);
		assert.strictEqual(countLiveness(`${loop}\nhint str _count;`), true);
	});

	test('try and catch are not alternatives: the catch block can run after the call', () => {
		assert.strictEqual(countLiveness(`private _count = 0;\ntry { ${call} } catch { hint str _count; };`), true);
	});

	test('a read in another branch does not stop a leak from looking intentional', () => {
		const files = workspace({
			'/m/caller.sqf':
				'private _done = false;\nif (a) then { hint str _done; } else { call TAG_fnc_callee; };\nhint str _done;',
			'/m/fn_callee.sqf': 'if (b) then { _done = true; } else { hint str _done; };'
		});
		const result = findScopeLeaks(files, [fn('TAG_fnc_callee', 'fn_callee.sqf')]);
		const [affected] = [...result.writes.get('file:///m/fn_callee.sqf')!.values()];
		assert.strictEqual(affected[0].kind, 'intentional');
	});
});

suite('findScopeLeaks - a variable created by the statement that makes the call', () => {
	const leaks = (caller: string) => {
		const files = workspace({ '/m/caller.sqf': caller, '/m/fn_callee.sqf': '_value = 5;\nhint str _value;' });
		return leakingCalls(findScopeLeaks(files, [fn('TAG_fnc_callee', 'fn_callee.sqf')]));
	};
	const leaked = { 'file:///m/caller.sqf': ['_value'] };

	test('does not exist yet during the call', () => {
		assert.deepStrictEqual(leaks('private _value = [] call TAG_fnc_callee;\nhint str _value;'), {});
		assert.deepStrictEqual(leaks('_value = [] call TAG_fnc_callee;\nhint str _value;'), {});
		assert.deepStrictEqual(leaks('private _value = if (a) then { call TAG_fnc_callee } else { 0 };\nhint str _value;'), {});
	});

	test('but one that existed before does', () => {
		assert.deepStrictEqual(leaks('private _value = 0;\n_value = [] call TAG_fnc_callee;\nhint str _value;'), leaked);
		assert.deepStrictEqual(leaks('private _value = 0;\nprivate _value = [] call TAG_fnc_callee;\nhint str _value;'), leaked);
		// The inner one is not created yet, so the callee overwrites the outer one.
		assert.deepStrictEqual(
			leaks('private _value = 0;\nif (a) then { private _value = [] call TAG_fnc_callee; };\nhint str _value;'),
			leaked
		);
	});

	test('exists in the statements after it', () => {
		assert.deepStrictEqual(leaks('private _value = 0; [] call TAG_fnc_callee;\nhint str _value;'), leaked);
		assert.deepStrictEqual(leaks('_value = 0;\n[] call TAG_fnc_callee;\nhint str _value;'), leaked);
	});
});

suite('findScopeLeaks - switch cases', () => {
	const callee =
		'private _message = _this select 0;\nswitch (_message) do {\n\tcase "build": { _var = 1; };\n\tcase "town": { hint "town"; };\n\tdefault { _other = 1; };\n};';
	const leaks = (caller: string, body = callee) => {
		const files = workspace({ '/m/caller.sqf': caller, '/m/fn_callee.sqf': body });
		return leakingCalls(findScopeLeaks(files, [fn('TAG_fnc_callee', 'fn_callee.sqf')]));
	};

	test('no leak from a case that the call does not select', () => {
		assert.deepStrictEqual(leaks('private _var = 0;\nprivate _other = 0;\n["town", [1]] call TAG_fnc_callee;\nhint str [_var, _other];'), {});
		assert.deepStrictEqual(leaks('private _var = 0;\n["TOWN"] call TAG_fnc_callee;\nhint str _var;'), {});
	});

	test('a leak from the case that the call selects, or from default', () => {
		assert.deepStrictEqual(leaks('private _var = 0;\n["Build"] call TAG_fnc_callee;\nhint str _var;'), {
			'file:///m/caller.sqf': ['_var']
		});
		assert.deepStrictEqual(leaks('private _other = 0;\n["spot"] call TAG_fnc_callee;\nhint str _other;'), {
			'file:///m/caller.sqf': ['_other']
		});
	});

	test('a leak from every case when the value passed is not a literal', () => {
		assert.deepStrictEqual(leaks('private _var = 0;\n[_kind] call TAG_fnc_callee;\nhint str _var;'), {
			'file:///m/caller.sqf': ['_var']
		});
		assert.deepStrictEqual(leaks('private _var = 0;\n_args call TAG_fnc_callee;\nhint str _var;'), {
			'file:///m/caller.sqf': ['_var']
		});
	});

	test('the case is chosen by the call into the switching function, further up the chain too', () => {
		const files = workspace({
			'/m/caller.sqf': 'private _var = 0;\ncall TAG_fnc_middle;\nhint str _var;',
			'/m/fn_middle.sqf': '["town"] call TAG_fnc_callee;',
			'/m/fn_callee.sqf': callee
		});
		const functions = [fn('TAG_fnc_callee', 'fn_callee.sqf'), fn('TAG_fnc_middle', 'fn_middle.sqf')];
		assert.deepStrictEqual(leakingCalls(findScopeLeaks(files, functions)), {});
		files.set('file:///m/fn_middle.sqf', workspace({ '/m/fn_middle.sqf': '["build"] call TAG_fnc_callee;' }).get('file:///m/fn_middle.sqf')!);
		assert.deepStrictEqual(leakingCalls(findScopeLeaks(files, functions)), { 'file:///m/caller.sqf': ['_var'] });
	});
});

suite('findScopeLeaks - reads that the caller\'s own assignment comes before', () => {
	const call = 'call TAG_fnc_callee;';

	test('not when the caller assigns it again in the block that reads it', () => {
		assert.strictEqual(countLiveness(`private _count = 0;\n${call}\nif (a) then { _count = 1; hint str _count; };`), false);
		assert.strictEqual(countLiveness(`private "_count";\n${call}\n{ _count = _x; hint str _count; } forEach [1, 2];`), false);
	});

	test('when that assignment might not run before the read', () => {
		// Its block has ended: the read may see either value.
		assert.strictEqual(countLiveness(`private _count = 0;\n${call}\nif (a) then { _count = 1; };\nhint str _count;`), true);
		// Nothing assigns it first: `isNil` sees the leaked value too.
		assert.strictEqual(countLiveness(`private "_count";\n${call}\nif (isNil "_count") then { hint "none"; };`), true);
	});

	test('in a loop, only when the assignment comes before the read in the same round', () => {
		// The next round assigns it again before reading it.
		assert.strictEqual(countLiveness(`private _count = 0;\nwhile {a} do {\n\t_count = 1;\n\thint str _count;\n\t${call}\n};`), false);
		// This round reads it right after the call; the assignment came before the call.
		assert.strictEqual(countLiveness(`private _count = 0;\nwhile {a} do {\n\t_count = 1;\n\t${call}\n\thint str _count;\n};`), true);
	});

	test('not when a later call only runs after the caller has assigned it again', () => {
		const show = { '/m/fn_show.sqf': 'hint str _count;' };
		assert.strictEqual(countLiveness(`private _count = 0;\n${call}\nif (a) then { _count = 1; call TAG_fnc_show; };`, '_count = 5;', show), false);
		assert.strictEqual(countLiveness(`private _count = 0;\n${call}\nif (a) then { call TAG_fnc_show; };`, '_count = 5;', show), true);
	});
});
