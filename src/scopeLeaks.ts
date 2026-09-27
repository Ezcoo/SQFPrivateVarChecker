import { CallSite, CodeBlock, FlowFacts, LocalWrite, SqfIssue } from './analyzer/analyzer';
import { FrameReads, frameReads, valueAfterCall } from './analyzer/flow';

/**
 * Finds *confirmed* scope leaks across `call` chains.
 *
 * `call` runs the callee inside the caller's scope. An assignment to a local variable
 * that is not declared `private` looks for an existing variable of that name in every
 * enclosing scope, the caller's included, and overwrites it if there is one; only when
 * there is none does it create a new variable. So when a function assigns `_foo`
 * without `private`, and some caller up the call chain already has a `_foo` where it
 * makes the call, the callee overwrites the caller's variable -- whether that was
 * meant or not.
 *
 * Every `.sqf` file is treated as one function body: that is how both `CfgFunctions`
 * and `compile preprocessFileLineNumbers "file.sqf"` build them. A code block stored in
 * a local variable (`private _fnc = {...}; call _fnc`) is a function body of its own.
 *
 * Each leak is also marked as `live` or not: whether the overwritten variable may be
 * read afterwards (by the caller, by anything it calls later, or by the functions in
 * between on the call chain). One that is not changes nothing yet, but would as soon as
 * someone reads the variable after the call.
 *
 * Deliberately free of the `vscode` API so it can be unit tested without an editor.
 */

export interface FileFacts {
	/** The file's path, e.g. `/mission/functions/fn_foo.sqf`. Used to resolve function paths. */
	path: string;
	issues: SqfIssue[];
	callSites: CallSite[];
	codeBlocks: CodeBlock[];
	flow: FlowFacts;
}

/** A named function and the file path it is compiled from. */
export interface FunctionSource {
	/** Lowercased function name. */
	name: string;
	/** The path as written in the config or script, relative to the mission or addon root. */
	path: string;
	/** Path of the file that defines the function; breaks ties when `path` matches several files. */
	definedIn: string;
}

/** A non-private assignment that can reach some caller's scope. */
export interface LeakOrigin {
	fileKey: string;
	/** The variable as written. */
	variable: string;
	start: number;
	end: number;
	/** Labels of the calls between the leaking frame and the file that assigns it, outermost first. */
	chain: string[];
	/**
	 * Whether the value it assigns may be read after the call that leaks it: `live` or
	 * `dead`, or still `open` while it is only known to reach the top of the frame it
	 * leaks from. Never `open` in a `LeakingCall`.
	 */
	state: OriginState;
}

export type OriginState = 'live' | 'dead' | 'open';

/** A caller whose local variable is overwritten through `callSite`. */
export interface AffectedCaller {
	/** Lowercased name of the overwritten variable. */
	name: string;
	callerKey: string;
	callSite: CallSite;
	/** Labels of every call from the caller down to the assigning file, outermost first. */
	chain: string[];
	/** Whether the overwritten variable may be read after the call (see `LeakOrigin.state`). */
	live: boolean;
}

/** One `call` that lets a callee overwrite local variables visible at the call site. */
export interface LeakingCall {
	callSite: CallSite;
	/** Lowercased variable name -> the assignments that overwrite it. */
	names: Map<string, LeakOrigin[]>;
}

export interface ScopeLeakResult {
	/** File key -> issue start offset -> the callers whose variable that assignment overwrites. */
	writes: Map<string, Map<number, AffectedCaller[]>>;
	/** File key -> the leaking calls it makes. */
	calls: Map<string, LeakingCall[]>;
}

export function findScopeLeaks(files: ReadonlyMap<string, FileFacts>, functions: FunctionSource[]): ScopeLeakResult {
	const resolvePath = createPathResolver(files);

	const functionsByName = new Map<string, FunctionSource[]>();
	for (const fn of functions) {
		const list = functionsByName.get(fn.name) ?? [];
		list.push(fn);
		functionsByName.set(fn.name, list);
	}

	// Returns frame keys: a file key, or `codeBlockKey(...)` for a code block.
	const targetsCache = new Map<CallSite, string[]>();
	const resolveCall = (callSite: CallSite, callerKey: string): string[] => {
		let targets = targetsCache.get(callSite);
		if (!targets) {
			const target = callSite.target;
			let keys: (string | undefined)[];
			if (target.kind === 'code') {
				keys = [codeBlockKey(callerKey, target.block)];
			} else if (target.kind === 'file') {
				keys = [resolvePath(target.path, files.get(callerKey)!.path)];
			} else {
				keys = (functionsByName.get(target.name) ?? []).map(fn => resolvePath(fn.path, fn.definedIn));
			}
			targets = [...new Set(keys.filter((key): key is string => key !== undefined))];
			targetsCache.set(callSite, targets);
		}
		return targets;
	};

	// What each frame, once called, reads of its caller's local variables: what it reads
	// before setting it itself, plus what its own callees read that it does not have a
	// variable for at the call site. Used to tell whether a later call may read a value.
	const reads = new Map<string, FrameReads>();
	const readsInProgress = new Set<string>();
	const readsOf = (frameKey: string): FrameReads => {
		const known = reads.get(frameKey);
		if (known) {
			return known;
		}
		const [key, block] = parseFrameKey(frameKey);
		const facts = files.get(key);
		if (!facts || readsInProgress.has(frameKey)) {
			return { names: new Set(), unknown: false };
		}
		readsInProgress.add(frameKey);

		const own = frameReads(facts.flow, facts.callSites, block);
		const result: FrameReads = { names: new Set(own.names), unknown: own.unknown };
		for (const [callSite] of callsInFrame(facts, block)) {
			for (const target of resolveCall(callSite, key)) {
				const callee = readsOf(target);
				result.unknown ||= callee.unknown;
				for (const name of callee.names) {
					if (!callSite.visibleNames.has(name)) {
						result.names.add(name);
					}
				}
			}
		}

		readsInProgress.delete(frameKey);
		reads.set(frameKey, result);
		return result;
	};

	// Whether the value that `callSite` (made in file `key`) leaves in `name` may be
	// read in that frame, or is still there when the frame returns (`open`).
	const stateCache = new Map<string, OriginState>();
	const stateAfter = (key: string, siteIndex: number, name: string): OriginState => {
		const cacheKey = `${key}\0${siteIndex}\0${name}`;
		let state = stateCache.get(cacheKey);
		if (!state) {
			const facts = files.get(key)!;
			const value = valueAfterCall(facts.flow, facts.callSites, siteIndex, name);
			const readLater =
				value.read ||
				value.calls.some(later =>
					resolveCall(facts.callSites[later], key).some(target => {
						const callee = readsOf(target);
						return callee.unknown || callee.names.has(name);
					})
				);
			state = readLater ? 'live' : value.end === 'escapes' ? 'open' : 'dead';
			stateCache.set(cacheKey, state);
		}
		return state;
	};

	// What each frame (a file, or a code block), once called, leaks into its caller's
	// scope: its own non-private assignments, plus whatever its own callees leak that it
	// does not have a variable for at the call site (those keep travelling up the chain).
	const escapes = new Map<string, Map<string, LeakOrigin[]>>();
	const inProgress = new Set<string>();
	const escapesOf = (frameKey: string): Map<string, LeakOrigin[]> => {
		const known = escapes.get(frameKey);
		if (known) {
			return known;
		}
		const result = new Map<string, LeakOrigin[]>();
		const [key, block] = parseFrameKey(frameKey);
		const facts = files.get(key);
		const codeBlock = block === undefined ? undefined : facts?.codeBlocks[block];
		// Recursion: the frame already being computed contributes nothing new.
		if (!facts || (block !== undefined && !codeBlock) || inProgress.has(frameKey)) {
			return result;
		}
		inProgress.add(frameKey);

		const writes: LocalWrite[] = codeBlock
			? codeBlock.writes
			: facts.issues.filter(issue => issue.reachesCaller);
		for (const write of writes) {
			// What the assigning frame itself does with its own value is its business.
			addOrigin(result, write.variable.toLowerCase(), {
				fileKey: key,
				variable: write.variable,
				start: write.start,
				end: write.end,
				chain: [],
				state: 'open'
			});
		}
		for (const [callSite, siteIndex] of callsInFrame(facts, block)) {
			for (const target of resolveCall(callSite, key)) {
				for (const [name, origins] of escapesOf(target)) {
					if (callSite.visibleNames.has(name)) {
						continue; // Stops here: overwrites this file's own variable.
					}
					for (const origin of origins) {
						const state = origin.state === 'open' ? stateAfter(key, siteIndex, name) : origin.state;
						addOrigin(result, name, { ...origin, chain: [callSite.label, ...origin.chain], state });
					}
				}
			}
		}

		inProgress.delete(frameKey);
		escapes.set(frameKey, result);
		return result;
	};

	const writes = new Map<string, Map<number, AffectedCaller[]>>();
	const calls = new Map<string, LeakingCall[]>();

	for (const [callerKey, facts] of files) {
		facts.callSites.forEach((callSite, siteIndex) => {
			const names = new Map<string, LeakOrigin[]>();
			for (const target of resolveCall(callSite, callerKey)) {
				for (const [name, origins] of escapesOf(target)) {
					if (!callSite.visibleNames.has(name)) {
						continue;
					}
					for (const found of origins) {
						// A value still there when the frame holding the variable returns is
						// assumed to be read by whoever called it.
						const state = found.state === 'open' ? stateAfter(callerKey, siteIndex, name) : found.state;
						const origin: LeakOrigin = { ...found, state: state === 'dead' ? 'dead' : 'live' };
						addOrigin(names, name, origin);

						let byStart = writes.get(origin.fileKey);
						if (!byStart) {
							byStart = new Map();
							writes.set(origin.fileKey, byStart);
						}
						const affected = byStart.get(origin.start) ?? [];
						affected.push({
							name,
							callerKey,
							callSite,
							chain: [callSite.label, ...origin.chain],
							live: origin.state === 'live'
						});
						byStart.set(origin.start, affected);
					}
				}
			}
			if (names.size > 0) {
				const list = calls.get(callerKey) ?? [];
				list.push({ callSite, names });
				calls.set(callerKey, list);
			}
		});
	}

	return { writes, calls };
}

function codeBlockKey(fileKey: string, block: number): string {
	return `${fileKey}\0${block}`;
}

/** Splits a frame key into its file key and, for a code block, the block index. */
function parseFrameKey(frameKey: string): [string, number | undefined] {
	const separator = frameKey.lastIndexOf('\0');
	return separator === -1
		? [frameKey, undefined]
		: [frameKey.slice(0, separator), Number(frameKey.slice(separator + 1))];
}

/** The calls made directly in a frame (the file, or code block `block`), which run inside it, with their indices. */
function callsInFrame(facts: FileFacts, block: number | undefined): [CallSite, number][] {
	const result: [CallSite, number][] = [];
	facts.callSites.forEach((callSite, index) => {
		if (block === undefined ? !callSite.detached : callSite.codeBlock === block) {
			result.push([callSite, index]);
		}
	});
	return result;
}

const STATE_RANK: Record<OriginState, number> = { dead: 0, open: 1, live: 2 };

/**
 * Adds `origin` unless the same assignment is already known, keeping the shortest
 * chain. Reached along several chains, it is as live as the livest of them.
 */
function addOrigin(map: Map<string, LeakOrigin[]>, name: string, origin: LeakOrigin): void {
	const list = map.get(name) ?? [];
	const index = list.findIndex(o => o.fileKey === origin.fileKey && o.start === origin.start);
	if (index === -1) {
		list.push(origin);
	} else {
		const existing = list[index];
		const shorter = origin.chain.length < existing.chain.length ? origin : existing;
		const state = STATE_RANK[origin.state] > STATE_RANK[existing.state] ? origin.state : existing.state;
		list[index] = { ...shorter, state };
	}
	map.set(name, list);
}

/**
 * Maps a path as written in SQF or config (`functions\misc\fn_foo.sqf`,
 * `\x\tag\addons\main\fnc_foo.sqf`) to one of the known files, by matching it against
 * the end of each file's path. Leading segments are dropped one at a time, so an addon
 * prefix that is not part of the workspace layout still matches, but at least the
 * file's directory and name must agree. When several files match equally well, the one
 * closest to `nearPath` (the file that mentions the path) wins.
 */
export function createPathResolver(
	files: ReadonlyMap<string, { path: string }>
): (rawPath: string, nearPath: string) => string | undefined {
	const byBaseName = new Map<string, { key: string; path: string }[]>();
	for (const [key, { path }] of files) {
		const normalized = normalize(path);
		const baseName = normalized.slice(normalized.lastIndexOf('/') + 1);
		const list = byBaseName.get(baseName) ?? [];
		list.push({ key, path: normalized });
		byBaseName.set(baseName, list);
	}

	const cache = new Map<string, string | undefined>();
	return (rawPath, nearPath) => {
		const cacheKey = `${rawPath}\0${nearPath}`;
		if (cache.has(cacheKey)) {
			return cache.get(cacheKey);
		}

		const segments = normalize(rawPath).split('/').filter(segment => segment.length > 0 && segment !== '.');
		const candidates = byBaseName.get(segments[segments.length - 1]) ?? [];
		const minimumSegments = Math.min(2, segments.length);
		let resolved: string | undefined;

		for (let drop = 0; candidates.length > 0 && segments.length - drop >= minimumSegments; drop++) {
			const suffix = segments.slice(drop).join('/');
			const matches = candidates.filter(c => c.path === suffix || c.path.endsWith(`/${suffix}`));
			if (matches.length > 0) {
				const near = normalize(nearPath);
				matches.sort((a, b) => commonPrefixLength(b.path, near) - commonPrefixLength(a.path, near));
				resolved = matches[0].key;
				break;
			}
		}

		cache.set(cacheKey, resolved);
		return resolved;
	};
}

function normalize(path: string): string {
	return path.trim().replace(/\\/g, '/').toLowerCase();
}

function commonPrefixLength(a: string, b: string): number {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) {
		i++;
	}
	return i;
}
