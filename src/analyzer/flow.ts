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
	// False when some call made in [from, to] cannot be followed.
	const noteCalls = (from: number, to: number): boolean => {
		for (let e = firstAt(calls, from); e < calls.length && calls[e].offset <= to; e++) {
			const index = sites.get(calls[e].offset);
			if (index === undefined) {
				return false;
			}
			later.add(index);
		}
		return true;
	};

	// In a loop, everything in the loop statement may run again after the call, this
	// call included.
	let loop: FlowScope | undefined;
	for (let s = site.scope; s !== region && s !== -1; s = scopes[s].parent) {
		if (scopes[s].repeats) {
			loop = scopes[s];
		}
	}
	if (loop) {
		const { statementStart, statementEnd } = loop;
		if (own.some(e => e.kind === 'read' && e.offset >= statementStart && e.offset <= statementEnd)) {
			return { read: true };
		}
		if (!noteCalls(statementStart, statementEnd)) {
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
		if (shadowed(event.scope)) {
			continue;
		}
		if (event.kind === 'read') {
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
	if (!noteCalls(site.end, stop)) {
		return { read: true };
	}

	let end: 'overwritten' | 'discarded' | 'escapes';
	if (overwritten) {
		end = 'overwritten';
	} else if (!owner) {
		end = 'escapes';
	} else {
		// A variable assigned without `private` at the top of a function body may itself
		// be its caller's, and so outlive the frame. Code run by `spawn` and the like has
		// no caller to hand it to.
		const reachesCaller = frame === 0 || scopes[frame].codeBlock !== undefined;
		end = owner.scope === frame && !owner.isPrivate && reachesCaller ? 'escapes' : 'discarded';
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
