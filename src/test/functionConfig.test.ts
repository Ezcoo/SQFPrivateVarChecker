import * as assert from 'assert';
import { parseCfgFunctions } from '../analyzer/functionConfig';

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
