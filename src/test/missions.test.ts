import * as assert from 'assert';
import { MissionRoots } from '../missions';

suite('MissionRoots', () => {
	const missions = () => {
		const roots = new MissionRoots();
		roots.add('/ws/Missions/co.chernarus/description.ext');
		roots.add('/ws/Missions/co.chernarus/mission.sqm');
		roots.add('/ws/Modded/co.lingor/mission.sqm');
		return roots;
	};

	test('recognises the files that mark a mission, case-insensitively', () => {
		assert.ok(MissionRoots.isMarker('/ws/m/Description.ext'));
		assert.ok(MissionRoots.isMarker('/ws/m/MISSION.SQM'));
		assert.ok(!MissionRoots.isMarker('/ws/m/CfgFunctions.hpp'));
		assert.ok(!MissionRoots.isMarker('/ws/m/mission.sqf'));
	});

	test('a file belongs to the mission folder above it', () => {
		const roots = missions();
		assert.strictEqual(roots.missionOf('/ws/Missions/co.chernarus/Server/Init/Init_Server.sqf'), '/ws/missions/co.chernarus');
		assert.strictEqual(roots.missionOf('/ws/Modded/co.lingor/init.sqf'), '/ws/modded/co.lingor');
		assert.strictEqual(roots.missionOf('/ws/addons/main/fnc_x.sqf'), undefined);
		// A folder whose name merely starts the same is another folder.
		const other = new MissionRoots();
		other.add('/ws/co/mission.sqm');
		assert.strictEqual(other.missionOf('/ws/co2/init.sqf'), undefined);
	});

	test('failing that, to the nearest folder named like a mission', () => {
		const roots = missions();
		// A partial mission, without description.ext or mission.sqm.
		assert.strictEqual(roots.missionOf('/ws/Modded/[55-2hc]wf.Isladuala/Client/init.sqf'), '/ws/modded/[55-2hc]wf.isladuala');
		// A dotted folder inside a mission that has its marker does not split it.
		assert.strictEqual(roots.missionOf('/ws/Missions/co.chernarus/scripts/some.lib/a.sqf'), '/ws/missions/co.chernarus');
		// Not mission names: hidden folders, version numbers.
		assert.strictEqual(roots.missionOf('/ws/.vscode/a.sqf'), undefined);
		assert.strictEqual(roots.missionOf('/ws/addons/v1.2/a.sqf'), undefined);
		assert.ok(!roots.related('/ws/Modded/wf.isladuala/a.sqf', '/ws/Missions/co.chernarus/a.sqf'));
	});

	test('files of different missions are unrelated; shared code relates to all', () => {
		const roots = missions();
		const chernarus = '/ws/Missions/co.chernarus/a.sqf';
		assert.ok(roots.related(chernarus, '/ws/Missions/co.chernarus/sub/b.sqf'));
		assert.ok(!roots.related(chernarus, '/ws/Modded/co.lingor/a.sqf'));
		assert.ok(roots.related(chernarus, '/ws/addons/shared.sqf'));
	});

	test('reports whether the set of missions changed', () => {
		const roots = missions();
		// A second marker in a folder that is already a mission changes nothing.
		assert.strictEqual(roots.add('/ws/Modded/co.lingor/description.ext'), false);
		assert.strictEqual(roots.remove('/ws/Modded/co.lingor/mission.sqm'), false);
		assert.strictEqual(roots.remove('/ws/Modded/co.lingor/description.ext'), true);
		assert.strictEqual(roots.add('/ws/Modded/eden/mission.sqm'), true);
		assert.strictEqual(roots.missionOf('/ws/Modded/eden/init.sqf'), '/ws/modded/eden');
	});
});
