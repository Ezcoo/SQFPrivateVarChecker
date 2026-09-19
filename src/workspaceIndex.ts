/**
 * Tracks, across every `.sqf` file that has been scanned so far, which local variable
 * names each file uses, and which of those it uses without `private`. This is what
 * powers the cross-file checks:
 *
 * - a name that only ever shows up in one file is none of this module's business;
 * - a name used in two or more different files is a "duplicate name";
 * - a name that is missing `private` in two or more different files is "ultra high
 *   risk" -- neither occurrence has its own scope, so they can freely read and
 *   overwrite each other.
 *
 * Deliberately free of the `vscode` API (files are identified by plain string keys,
 * normally `uri.toString()`) so it can be unit tested without a running editor.
 */
export class WorkspaceVariableIndex {
	private readonly filesByName = new Map<string, Set<string>>();
	private readonly namesByFile = new Map<string, Set<string>>();
	private readonly nonPrivateFilesByName = new Map<string, Set<string>>();
	private readonly nonPrivateNamesByFile = new Map<string, Set<string>>();

	/**
	 * Replaces what the index knows about `fileKey`. `names` is every local variable
	 * name the file uses (already lowercased); `nonPrivateNames` is the subset that is
	 * missing `private` there. Returns the names whose membership changed in either
	 * set, so a caller can re-check any other file that might now need to flip between
	 * flagged and not.
	 */
	update(fileKey: string, names: ReadonlySet<string>, nonPrivateNames: ReadonlySet<string>): Set<string> {
		const changed = new Set<string>();
		this.replace(this.filesByName, this.namesByFile, fileKey, names, changed);
		this.replace(this.nonPrivateFilesByName, this.nonPrivateNamesByFile, fileKey, nonPrivateNames, changed);
		return changed;
	}

	/** Forgets everything about `fileKey`, e.g. because the file was deleted. */
	remove(fileKey: string): Set<string> {
		return this.update(fileKey, new Set(), new Set());
	}

	/** Drops every file. Used when the whole diagnostic collection is reset. */
	clear(): void {
		this.filesByName.clear();
		this.namesByFile.clear();
		this.nonPrivateFilesByName.clear();
		this.nonPrivateNamesByFile.clear();
	}

	/** True when `name` is used as a local variable by some file other than `fileKey`. */
	isUsedElsewhere(name: string, fileKey: string): boolean {
		return this.otherFiles(name, fileKey).length > 0;
	}

	/** The other files (besides `fileKey`) currently known to use `name` at all. */
	otherFiles(name: string, fileKey: string): string[] {
		return otherFilesFrom(this.filesByName, name, fileKey);
	}

	/** The other files (besides `fileKey`) currently known to use `name` without `private`. */
	otherNonPrivateFiles(name: string, fileKey: string): string[] {
		return otherFilesFrom(this.nonPrivateFilesByName, name, fileKey);
	}

	private replace(
		byName: Map<string, Set<string>>,
		byFile: Map<string, Set<string>>,
		fileKey: string,
		names: ReadonlySet<string>,
		changed: Set<string>
	): void {
		const previous = byFile.get(fileKey) ?? new Set<string>();

		for (const name of previous) {
			if (!names.has(name)) {
				disassociate(byName, name, fileKey);
				changed.add(name);
			}
		}
		for (const name of names) {
			if (!previous.has(name)) {
				associate(byName, name, fileKey);
				changed.add(name);
			}
		}

		if (names.size > 0) {
			byFile.set(fileKey, new Set(names));
		} else {
			byFile.delete(fileKey);
		}
	}
}

function otherFilesFrom(byName: Map<string, Set<string>>, name: string, fileKey: string): string[] {
	const files = byName.get(name.toLowerCase());
	if (!files) {
		return [];
	}
	return [...files].filter(key => key !== fileKey);
}

function associate(byName: Map<string, Set<string>>, name: string, fileKey: string): void {
	let files = byName.get(name);
	if (!files) {
		files = new Set<string>();
		byName.set(name, files);
	}
	files.add(fileKey);
}

function disassociate(byName: Map<string, Set<string>>, name: string, fileKey: string): void {
	const files = byName.get(name);
	if (!files) {
		return;
	}
	files.delete(fileKey);
	if (files.size === 0) {
		byName.delete(name);
	}
}
