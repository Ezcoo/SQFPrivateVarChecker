/** `missionName.terrainName`: anything, a dot, and a terrain name, which starts with a letter. */
const MISSION_FOLDER_NAME = /^.+\.[a-z][a-z0-9_]*$/;

/**
 * Knows which folders in the workspace are missions, so that a workspace holding several
 * missions (say the same mission for different maps) does not mix them up. A folder is a
 * mission when it contains `description.ext` or `mission.sqm`; a file belongs to the
 * nearest such folder above it. Failing that, it belongs to the nearest folder named
 * like a mission, `missionName.terrainName` (which Arma requires of mission folders),
 * so a partial mission without either file is still kept apart. Otherwise it belongs to
 * no mission at all (addon or shared code).
 *
 * Files of different missions never run together: a `call` in one mission cannot reach
 * a function defined in another, and their local variables never meet. Files that belong
 * to no mission may be used by any of them.
 *
 * Deliberately free of the `vscode` API (paths are plain `/`-separated strings, normally
 * `uri.path`) so it can be unit tested without a running editor.
 */
export class MissionRoots {
	/** Marker file path -> its folder, both lowercased. */
	private readonly markers = new Map<string, string>();
	/** Mission folders, lowercased, deepest first so the nearest one wins. */
	private roots: string[] = [];

	/** Whether `path` names a file that makes its folder a mission. */
	static isMarker(path: string): boolean {
		const baseName = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
		return baseName === 'description.ext' || baseName === 'mission.sqm';
	}

	/** Records that the marker file at `path` exists. Returns whether the set of missions changed. */
	add(path: string): boolean {
		const lower = path.toLowerCase();
		if (this.markers.has(lower)) {
			return false;
		}
		this.markers.set(lower, lower.slice(0, lower.lastIndexOf('/')));
		return this.update();
	}

	/** Records that the marker file at `path` is gone. Returns whether the set of missions changed. */
	remove(path: string): boolean {
		return this.markers.delete(path.toLowerCase()) && this.update();
	}

	clear(): void {
		this.markers.clear();
		this.roots = [];
	}

	/** The mission folder `path` belongs to, or undefined when it belongs to none. */
	missionOf(path: string): string | undefined {
		const lower = path.toLowerCase();
		const marked = this.roots.find(root => lower.startsWith(`${root}/`));
		if (marked !== undefined) {
			return marked;
		}
		for (let end = lower.lastIndexOf('/'); end > 0; end = lower.lastIndexOf('/', end - 1)) {
			const folder = lower.slice(0, end);
			if (MISSION_FOLDER_NAME.test(folder.slice(folder.lastIndexOf('/') + 1))) {
				return folder;
			}
		}
		return undefined;
	}

	/** Whether code in the files at `a` and `b` can ever run together. */
	related(a: string, b: string): boolean {
		const missionA = this.missionOf(a);
		const missionB = this.missionOf(b);
		return missionA === undefined || missionB === undefined || missionA === missionB;
	}

	private update(): boolean {
		const roots = [...new Set(this.markers.values())].sort((a, b) => b.length - a.length);
		const changed = roots.length !== this.roots.length || roots.some((root, i) => root !== this.roots[i]);
		this.roots = roots;
		return changed;
	}
}
