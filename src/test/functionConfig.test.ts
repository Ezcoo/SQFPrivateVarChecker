import * as assert from 'assert';
import { expandIncludes, parseCfgFunctions } from '../analyzer/functionConfig';

suite('parseCfgFunctions', () => {
	test('follows the default, category and function file rules', () => {
		const functions = parseCfgFunctions(
			`class CfgFunctions {
				class TAG {
					class Misc {
						class plain {};
						class exact { file = "scripts\\exact.sqf"; };
					};
					class Moved {
						file = "code\\moved";
						class inDir {};
					};
				};
				class Other {
					tag = "OVR";
					class Cat { class fn {}; class machine { ext = ".fsm"; }; };
				};
			};`,
			false
		);
		assert.deepStrictEqual(functions, [
			{ name: 'tag_fnc_plain', path: 'functions\\Misc\\fn_plain.sqf' },
			{ name: 'tag_fnc_exact', path: 'scripts\\exact.sqf' },
			{ name: 'tag_fnc_indir', path: 'code\\moved\\fn_inDir.sqf' },
			{ name: 'ovr_fnc_fn', path: 'functions\\Cat\\fn_fn.sqf' }
		]);
	});

	test('reads a CfgFunctions.hpp that is included inside class CfgFunctions', () => {
		const text = 'class TAG { class Misc { class foo {}; }; };';
		assert.deepStrictEqual(parseCfgFunctions(text, true), [
			{ name: 'tag_fnc_foo', path: 'functions\\Misc\\fn_foo.sqf' }
		]);
		// description.ext classes outside CfgFunctions are not functions.
		assert.deepStrictEqual(parseCfgFunctions(text, false), []);
	});

	test('ignores other description.ext content', () => {
		const functions = parseCfgFunctions(
			`author = "me";
			class Header { gameType = "Coop"; };
			respawnTemplates[] = {"Base"};
			class CfgFunctions { class T { class C { class f {}; }; }; };`,
			false
		);
		assert.deepStrictEqual(functions.map(fn => fn.name), ['t_fnc_f']);
	});
});

suite('expandIncludes', () => {
	const reader = (files: Record<string, string>) => async (path: string) => files[path];

	test('inlines included files, relative to the including file and nested', async () => {
		const files = {
			'/mod/addons/main/cfg/functions.hpp': 'class TAG {\n#include "../misc.hpp"\n};',
			'/mod/addons/main/misc.hpp': 'class Misc { class foo {}; };'
		};
		const { text, included } = await expandIncludes(
			'class CfgFunctions {\n\t#include "cfg\\functions.hpp"\n};',
			'/mod/addons/main/config.cpp',
			reader(files)
		);
		assert.deepStrictEqual(parseCfgFunctions(text, false), [{ name: 'tag_fnc_foo', path: 'functions\\Misc\\fn_foo.sqf' }]);
		assert.deepStrictEqual(included.sort(), ['/mod/addons/main/cfg/functions.hpp', '/mod/addons/main/misc.hpp']);
	});

	test('leaves out addon paths, missing files and includes of itself', async () => {
		const files = { '/m/loop.hpp': '#include "loop.hpp"\nclass A {};' };
		const { text, included } = await expandIncludes(
			'#include "\\x\\cba\\addons\\main\\script_macros.hpp"\n#include <missing.hpp>\n#include "loop.hpp"',
			'/m/description.ext',
			reader(files)
		);
		assert.strictEqual(text.trim(), 'class A {};');
		assert.deepStrictEqual(included.sort(), ['/m/loop.hpp', '/m/missing.hpp']);
	});
});

suite('parseCfgFunctions - addons', () => {
	test('reads CfgFunctions among the other classes of a config.cpp', () => {
		const functions = parseCfgFunctions(
			`class CfgPatches {
				class my_addon { units[] = {}; requiredAddons[] = {"cba_main"}; };
			};
			class CfgVehicles { class Man; class MyMan: Man { displayName = "x"; }; };
			class CfgFunctions {
				class MYMOD {
					class Core { file = "\\mymod\\addons\\core\\functions"; class init {}; };
				};
			};`,
			false
		);
		assert.deepStrictEqual(functions, [{ name: 'mymod_fnc_init', path: '\\mymod\\addons\\core\\functions\\fn_init.sqf' }]);
	});
});
