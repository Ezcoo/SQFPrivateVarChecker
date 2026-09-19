/**
 * Tracks, across every `.sqf` file that has been scanned so far, which local variable
 * names each file uses. This is what powers the cross-file duplicate-name check: a
 * name that only ever shows up in one file is none of this module's business, but a
 * name reused in two or more different files is exactly what it is meant to find.
 *
 * Deliberately free of the `vscode` API (files are identified by plain string keys,
 * normally `uri.toString()`) so it can be unit tested without a running editor.
 */
export class WorkspaceVariableIndex {
	private readonly filesByName = new Map<string, Set<string>>();
	private readonly namesByFile = new Map<string, Set<string>>();

	/**
	 * Replaces what the index knows about `fileKey` with `names` (already lowercased).
	 * Returns the names whose cross-file membership changed as a result, so a caller
	 * can re-check any other file that might now need to flip between flagged and not.
	 */
	update(fileKey: string, names: ReadonlySet<string>): Set<string> {
		const previous = this.namesByFile.get(fileKey) ?? new Set<string>();
		const changed = new Set<string>();

		for (const name of previous) {
			if (!names.has(name)) {
				this.disassociate(name, fileKey);
				changed.add(name);
			}
		}
		for (const name of names) {
			if (!previous.has(name)) {
				this.associate(name, fileKey);
				changed.add(name);
			}
		}

		if (names.size > 0) {
			this.namesByFile.set(fileKey, new Set(names));
		} else {
			this.namesByFile.delete(fileKey);
		}

		return changed;
	}

	/** Forgets everything about `fileKey`, e.g. because the file was deleted. */
	remove(fileKey: string): Set<string> {
		return this.update(fileKey, new Set());
	}

	/** Drops every file. Used when the whole diagnostic collection is reset. */
	clear(): void {
		this.filesByName.clear();
		this.namesByFile.clear();
	}

	/** True when `name` is used as a local variable by some file other than `fileKey`. */
	isUsedElsewhere(name: string, fileKey: string): boolean {
		const files = this.filesByName.get(name.toLowerCase());
		if (!files || files.size === 0) {
			return false;
		}
		return files.size > 1 || !files.has(fileKey);
	}

	/** The other files (besides `fileKey`) currently known to use `name`. */
	otherFiles(name: string, fileKey: string): string[] {
		const files = this.filesByName.get(name.toLowerCase());
		if (!files) {
			return [];
		}
		return [...files].filter(key => key !== fileKey);
	}

	private associate(name: string, fileKey: string): void {
		let files = this.filesByName.get(name);
		if (!files) {
			files = new Set<string>();
			this.filesByName.set(name, files);
		}
		files.add(fileKey);
	}

	private disassociate(name: string, fileKey: string): void {
		const files = this.filesByName.get(name);
		if (!files) {
			return;
		}
		files.delete(fileKey);
		if (files.size === 0) {
			this.filesByName.delete(name);
		}
	}
}
