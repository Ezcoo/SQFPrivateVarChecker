import { CallSite, FlowEvent, FlowFacts, FlowScope } from './analyzer';

/**
 * Answers, within one file, whether the value a `call` leaves in a local variable can
 * be read afterwards, and which local variables a function body reads before setting
 * them itself (so it sees its caller's). Both err on the side of "it may be read":
 * they are used to tell a scope leak that breaks something today from one that only
 * could, and calling a harmless leak harmful is the safe mistake.
 */

/** What becomes of the value a call leaves in a local variable, in the frame that made the call. */
export type ValueAfterCall =
	| { read: true }
	| {
			read: false;
			/** Indices into `callSites` of later calls made while the value is still there; their callees may read it. */
			calls: number[];
			/**
			 * `overwritten` by a later assignment, `discarded` with the scope that holds it, or
			 * `escapes`: still there when the frame returns, so it is up to whoever called the frame.
			 */
			end: 'overwritten' | 'discarded' | 'escapes';
	  };

/** Local variables (lowercased) that a function body reads while they still hold its caller's value. */
export interface FrameReads {
	names: Set<string>;
	/** It makes a call that cannot be followed, so it may read anything. */
	unknown: boolean;
}

interface FlowIndex {
	/** Reads, assignments and declarations of each name, in source order. */
	byName: Map<string, FlowEvent[]>;
	/** Every call, in source order. */
	calls: FlowEvent[];
	/** Call offset -> index into `callSites`. */
	sites: Map<number, number>;
}

const indexes = new WeakMap<FlowFacts, FlowIndex>();

function indexOf(flow: FlowFacts, callSites: CallSite[]): FlowIndex {
	let index = indexes.get(flow);
	if (!index) {
		index = { byName: new Map(), calls: [], sites: new Map(callSites.map((site, i) => [site.start, i])) };
		for (const event of flow.events) {
			if (event.kind === 'call') {
				index.calls.push(event);
			} else {
				const list = index.byName.get(event.name) ?? [];
				list.push(event);
				index.byName.set(event.name, list);
			}
		}
		indexes.set(flow, index);
	}
	return index;
}

/**
 * What becomes of the value that the call `callSites[siteIndex]` leaves in `name`,
 * whether or not `name` is a local variable of the frame making the call (when it is
 * not, the variable belongs to some caller further up).
 */
export function valueAfterCall(flow: FlowFacts, callSites: CallSite[], siteIndex: number, name: string): ValueAfterCall {
	const { scopes } = flow;
	const { byName, calls, sites } = indexOf(flow, callSites);
	const site = callSites[siteIndex];
	const own = byName.get(name) ?? [];
	const owner = site.owners.get(name);
	const frame = frameOf(scopes, site.scope, scope => scope.detached);
	// The value can only be read while the variable exists: until its scope ends, or,
	// when it belongs to a caller further up, until this frame returns.
	const region = owner?.scope ?? frame;
	const later = new Set<number>();
	const here = { scope: site.scope, offset: site.start };
	// Code that cannot run after the call in the same pass (another branch of an `if`).
	const elsewhere = (event: FlowEvent) => exclusive(scopes, here, event, region);
	// False when some call made in [from, to] cannot be followed.
	const noteCalls = (from: number, to: number, skip: (event: FlowEvent) => boolean = () => false): boolean => {
		for (let e = firstAt(calls, from); e < calls.length && calls[e].offset <= to; e++) {
			if (skip(calls[e])) {
				continue;
			}
			const index = sites.get(calls[e].offset);
			if (index === undefined) {
				return false;
			}
			later.add(index);
		}
		return true;
	};

	// In a loop, everything in the loop statement may run again after the call, this
	// call included; unless the call is in an `exitWith` block that leaves the loop.
	let loop: number | undefined;
	let exited = false;
	for (let s = site.scope; s !== region && s !== -1; s = scopes[s].parent) {
		if (scopes[s].repeats && !exited) {
			loop = s;
		}
		exited = scopes[s].exits !== undefined;
	}

	// A read (or call) that one of this frame's own assignments always comes before sees
	// that assignment's value instead: the assignment's block contains it, and it runs
	// after the call, or earlier in the same round of the loop around the call.
	const reassigned = (event: FlowEvent) =>
		own.some(
			assign =>
				assign.kind === 'assign' &&
				assign.offset < event.offset &&
				isWithin(scopes, event.scope, assign.scope) &&
				(assign.offset > site.end ||
					(event.offset < site.start && loop !== undefined && isWithin(scopes, assign.scope, loop)))
		);

	if (loop !== undefined) {
		const { statementStart, statementEnd } = scopes[loop];
		const inLoop = (e: FlowEvent) => e.offset >= statementStart && e.offset <= statementEnd;
		if (own.some(e => e.kind === 'read' && inLoop(e) && !reassigned(e))) {
			return { read: true };
		}
		if (!noteCalls(statementStart, statementEnd, reassigned)) {
			return { read: true };
		}
	}

	// Straight on from the call until the value is overwritten or the variable is gone.
	// A `private` redeclaration in an inner scope starts a new variable there (a shadow):
	// what is read or assigned inside it is not this one.
	const shadows: number[] = [];
	const shadowed = (scope: number) => shadows.some(shadow => isWithin(scopes, scope, shadow));
	const regionEnd = scopes[region].end;
	let stop = regionEnd;
	let overwritten = false;
	for (let e = firstAt(own, site.end); e < own.length && own[e].offset <= regionEnd; e++) {
		const event = own[e];
		if (shadowed(event.scope) || elsewhere(event)) {
			continue;
		}
		if (event.kind === 'read') {
			if (reassigned(event)) {
				continue;
			}
			return { read: true };
		}
		if (event.kind === 'declare' && event.scope !== owner?.scope) {
			shadows.push(event.scope);
			continue;
		}
		// A declaration in the owning scope replaces the variable; an assignment
		// overwrites it, but only when it is sure to run, i.e. it is not nested
		// deeper than the call (inside an `if`, say).
		if (event.kind === 'declare' || isWithin(scopes, site.scope, event.scope)) {
			stop = event.offset;
			overwritten = true;
			break;
		}
	}
	if (!noteCalls(site.end, stop, event => elsewhere(event) || reassigned(event))) {
		return { read: true };
	}

	// A variable that is not this frame's own, or is assigned without `private` at the
	// top of a function body, may be its caller's, and so outlive the frame. Code run by
	// `spawn`, an event handler and the like has no caller to hand it to.
	const reachesCaller = frame === 0 || scopes[frame].codeBlock !== undefined;
	let end: 'overwritten' | 'discarded' | 'escapes';
	if (overwritten) {
		end = 'overwritten';
	} else if (reachesCaller && (!owner || (owner.scope === frame && !owner.isPrivate))) {
		end = 'escapes';
	} else {
		end = 'discarded';
	}
	return { read: false, calls: [...later].sort((a, b) => a - b), end };
}

/**
 * The local variables that the file (`block` undefined) or the code block `block`
 * reads while they may still hold its caller's value: read before this frame has
 * declared or assigned them itself. Reads inside code blocks stored in variables
 * belong to those blocks, which are followed through the calls that run them.
 */
export function frameReads(flow: FlowFacts, callSites: CallSite[], block?: number): FrameReads {
	const { scopes, events } = flow;
	const { byName, sites } = indexOf(flow, callSites);
	const root = block === undefined ? 0 : scopes.findIndex(scope => scope.codeBlock === block);
	const result: FrameReads = { names: new Set(), unknown: false };
	if (root === -1) {
		return result;
	}
	const inFrame = (scope: number) => frameOf(scopes, scope, s => s.codeBlock !== undefined) === root;

	for (const event of events) {
		if (!inFrame(event.scope)) {
			continue;
		}
		if (event.kind === 'call') {
			result.unknown ||= !sites.has(event.offset);
			continue;
		}
		if (event.kind !== 'read' || result.names.has(event.name)) {
			continue;
		}
		const bound = byName.get(event.name)!.some(
			binding =>
				binding.kind !== 'read' &&
				binding.offset <= event.offset &&
				isWithin(scopes, event.scope, binding.scope) &&
				isWithin(scopes, binding.scope, root)
		);
		if (!bound) {
			result.names.add(event.name);
		}
	}
	return result;
}

/** What the frame assigning a local variable does with that value itself (see `valueAfterWrite`). */
export interface ValueAfterWrite {
	/** It may read the value back, or calls something that cannot be followed after assigning it. */
	read: boolean;
	/** Indices into `callSites` of the calls it makes after assigning it; their callees may read it. */
	calls: number[];
	/** It assigns the variable more than once. */
	assignedAgain: boolean;
}

/**
 * What the file (`block` undefined) or the code block `block` does with the value it
 * assigns to `name` at `writeStart`, after that assignment (or anywhere in a loop around it).
 */
export function valueAfterWrite(
	flow: FlowFacts,
	callSites: CallSite[],
	block: number | undefined,
	name: string,
	writeStart: number
): ValueAfterWrite {
	const { scopes } = flow;
	const { byName, calls, sites } = indexOf(flow, callSites);
	const root = block === undefined ? 0 : scopes.findIndex(scope => scope.codeBlock === block);
	const inFrame = (scope: number) => frameOf(scopes, scope, s => s.codeBlock !== undefined) === root;
	const own = (byName.get(name) ?? []).filter(event => inFrame(event.scope));
	const write = own.find(event => event.kind === 'assign' && event.offset >= writeStart);
	const assignedAgain = own.some(event => event.kind === 'assign' && event !== write);
	if (root === -1 || !write) {
		return { read: true, calls: [], assignedAgain };
	}

	// In a loop, everything in the loop statement may run again after the assignment;
	// unless it is in an `exitWith` block that leaves the loop.
	let loopStart = Infinity;
	let exited = false;
	for (let s = write.scope; s !== root && s > 0; s = scopes[s].parent) {
		if (scopes[s].repeats && !exited) {
			loopStart = Math.min(loopStart, scopes[s].statementStart);
		}
		exited = scopes[s].exits !== undefined;
	}
	const after = (event: FlowEvent) =>
		(event.offset > write.offset || event.offset >= loopStart) && !exclusive(scopes, write, event, root);

	let read = own.some(event => event.kind === 'read' && after(event));
	const later: number[] = [];
	for (const call of calls) {
		if (inFrame(call.scope) && after(call)) {
			const index = sites.get(call.offset);
			if (index === undefined) {
				read = true;
			} else {
				later.push(index);
			}
		}
	}
	return { read, calls: later, assignedAgain };
}

/** Whether the frame making a call still uses the value a local variable has right before it (see `valueBeforeCall`). */
export type ValueBeforeCall = { unused: false } | { unused: true; calls: number[] };

/**
 * Whether the value `name` holds right before the call `callSites[siteIndex]` is left
 * unused by the frame making the call: set in a scope around the call, and not read
 * between there and the call. `calls` are the calls made in between, whose callees may
 * still read it. Not `unused` when the variable is not this frame's own, or it cannot tell.
 */
export function valueBeforeCall(flow: FlowFacts, callSites: CallSite[], siteIndex: number, name: string): ValueBeforeCall {
	const { scopes } = flow;
	const { byName, calls, sites } = indexOf(flow, callSites);
	const site = callSites[siteIndex];
	const owner = site.owners.get(name);
	if (!owner) {
		return { unused: false };
	}
	const own = byName.get(name) ?? [];
	const inRegion = (scope: number) => isWithin(scopes, scope, owner.scope);

	// The last declaration or assignment sure to have run before the call.
	let last: FlowEvent | undefined;
	for (const event of own) {
		if (event.offset >= site.start) {
			break;
		}
		if (event.kind !== 'read' && inRegion(event.scope) && isWithin(scopes, site.scope, event.scope)) {
			last = event;
		}
	}
	if (!last) {
		return { unused: false };
	}
	const from = last.offset;
	// Code that cannot run before the call in the same pass (another branch of an `if`).
	const here = { scope: site.scope, offset: site.start };
	const elsewhere = (event: FlowEvent) => exclusive(scopes, event, here, owner.scope);
	const before = (event: FlowEvent) =>
		event.offset > from && event.offset < site.start && inRegion(event.scope) && !elsewhere(event);
	if (own.some(event => event.kind === 'read' && before(event))) {
		return { unused: false };
	}

	const between: number[] = [];
	for (let e = firstAt(calls, from); e < calls.length && calls[e].offset < site.start; e++) {
		if (!inRegion(calls[e].scope) || elsewhere(calls[e])) {
			continue;
		}
		const index = sites.get(calls[e].offset);
		if (index === undefined) {
			return { unused: false };
		}
		between.push(index);
	}
	return { unused: true, calls: between };
}

/** A point in the code: an offset, in flow scope `scope`. */
interface Point {
	scope: number;
	offset: number;
}

/**
 * Whether no single pass through the code can reach both `a` and `b`: they sit in
 * different alternatives of one `if` or `switch`, or one is in an `exitWith` block and
 * the other comes after it in the scope that the block leaves. Not when a loop around
 * them, inside `limit` (the scope the variable lives in), can run them again.
 */
export function exclusive(scopes: FlowScope[], a: Point, b: Point, limit: number): boolean {
	return alternatives(scopes, a, b, limit) || skippedAfterExit(scopes, a, b, limit) || skippedAfterExit(scopes, b, a, limit);
}

function alternatives(scopes: FlowScope[], a: Point, b: Point, limit: number): boolean {
	for (let x = a.scope; x > 0; x = scopes[x].parent) {
		const { branch, parent } = scopes[x];
		if (branch === undefined) {
			continue;
		}
		for (let y = b.scope; y > 0; y = scopes[y].parent) {
			if (y !== x && scopes[y].branch === branch && scopes[y].parent === parent) {
				return !mayRunAgain(scopes, parent, limit, false);
			}
		}
	}
	return false;
}

/** Whether `b` is skipped once an `exitWith` block around `a` has run. */
function skippedAfterExit(scopes: FlowScope[], a: Point, b: Point, limit: number): boolean {
	for (let x = a.scope; x > 0; x = scopes[x].parent) {
		const { exits, parent: left } = scopes[x];
		if (exits !== undefined && b.offset > exits && isWithin(scopes, b.scope, left) && !isWithin(scopes, b.scope, x)) {
			return left === limit || !mayRunAgain(scopes, left, limit, true);
		}
	}
	return false;
}

/**
 * Whether a loop from scope `from` up to (not including) `limit` may run it again. A
 * loop body left by an `exitWith` block on the way up (or right away, `fromExit`) does not.
 */
function mayRunAgain(scopes: FlowScope[], from: number, limit: number, fromExit: boolean): boolean {
	let exited = fromExit;
	for (let s = from; s !== limit && s !== -1; s = scopes[s].parent) {
		if (scopes[s].repeats && !exited) {
			return true;
		}
		exited = scopes[s].exits !== undefined;
	}
	return false;
}

/** The nearest scope enclosing (or being) `scope` that matches, or the file. */
function frameOf(scopes: FlowScope[], scope: number, isFrame: (scope: FlowScope) => boolean): number {
	for (let s = scope; s > 0; s = scopes[s].parent) {
		if (isFrame(scopes[s])) {
			return s;
		}
	}
	return 0;
}

/** Whether `scope` is `ancestor` or nested in it. */
function isWithin(scopes: FlowScope[], scope: number, ancestor: number): boolean {
	for (let s = scope; s !== -1; s = scopes[s].parent) {
		if (s === ancestor) {
			return true;
		}
	}
	return false;
}

/** Index of the first event at or after `offset`. */
function firstAt(events: FlowEvent[], offset: number): number {
	let low = 0;
	let high = events.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (events[mid].offset < offset) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}
