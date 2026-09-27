import { Comment, Token, tokenize } from './tokenizer';

export interface SqfIssue {
	/** The variable name exactly as written in the source. */
	variable: string;
	/** Offset of the first character of the variable. */
	start: number;
	/** Offset just past the last character of the variable. */
	end: number;
	message: string;
	/**
	 * `missing-private` is what this analyzer produces on its own. `duplicate-name`
	 * is assigned afterwards, by code outside this file, when the same variable name
	 * is also used as a local variable in a *different* file in the workspace — the
	 * analyzer only ever looks at one file, so it cannot know that by itself.
	 */
	kind: 'missing-private' | 'duplicate-name';
	/**
	 * True unless the assignment sits inside a block that does not run in the file's
	 * own scope (a `spawn` block, a code value such as `_fnc = {...}`, or code passed
	 * inside an array like `addEventHandler ["Killed", {...}]`). When the file is run
	 * with `call`, such an assignment can overwrite a local variable of the caller.
	 */
	reachesCaller: boolean;
	/** Set when the assigned value is what the caller passed in (see `LocalWrite.argument`). */
	argument?: number;
	/** Set when the assignment only runs for some of the values the caller passes in (see `CaseGuard`). */
	cases?: CaseGuard[];
}

/**
 * A `case` or `default` block of a `switch` on something the caller passed in (element
 * `argument` of `_this`, directly or through a local variable assigned from it once):
 * code in it only runs when the call passes one of the case labels, or, for `default`,
 * none of them. `switch (_this select 0) do { case "a": {...} }` only runs its block for
 * `["a"] call f`. An assignment in nested blocks has one guard per `switch`.
 */
export interface CaseGuard {
	/** Element of `_this` switched on; -1 for `_this` itself. */
	argument: number;
	/** The case labels (see `constantKey`) that run the block; for `default`, every label of the switch. */
	values: string[];
	/** Set for a `default` block: it runs when the argument matches none of `values`. */
	isDefault?: boolean;
}

/**
 * What a `call` points at: a named function, a file compiled in place, or a code block
 * in the same file (`private _fnc = {...}; call _fnc`, index into `codeBlocks`).
 */
export type CallTarget =
	| { kind: 'function'; name: string }
	| { kind: 'file'; path: string }
	| { kind: 'code'; block: number };

export interface CallSite {
	target: CallTarget;
	/** The callee as written, e.g. `TAG_fnc_foo` or `"scripts\\foo.sqf"`, for messages. */
	label: string;
	/** Offset of the `call` keyword. */
	start: number;
	/** Offset just past the callee. */
	end: number;
	/**
	 * Local variable names (lowercased) that already exist at the call site and that
	 * the callee could therefore overwrite: everything declared or assigned so far in
	 * the enclosing scopes, stopping at the nearest block that does not run in the
	 * file's own scope.
	 */
	visibleNames: Set<string>;
	/** True when the call sits inside such a block, so the callee's writes cannot reach this file's own caller. */
	detached: boolean;
	/**
	 * The local variables (lowercased) handed to the callee as `_this`: `_a call f` gives
	 * `'_a'`, `[_a, 5, _b] call f` gives `['_a', undefined, '_b']`. Unset for anything else.
	 */
	passed?: string | (string | undefined)[];
	/**
	 * Like `passed`, for the literal strings and numbers handed to the callee, as
	 * `constantKey` gives them: `["a", _b, 2] call f` gives `['"a', undefined, '#2']`.
	 */
	constants?: string | (string | undefined)[];
	/** The code block (index into `codeBlocks`) that the call is made from, if any. */
	codeBlock?: number;
	/** The flow scope (index into `FlowFacts.scopes`) the call is made in. */
	scope: number;
	/** For each of `visibleNames`, the flow scope that holds it, and whether it was declared `private` there. */
	owners: Map<string, { scope: number; isPrivate: boolean }>;
}

/**
 * A `{...}` block (or the file itself, at index 0) as far as following a variable's
 * value is concerned. Offsets are source offsets.
 */
export interface FlowScope {
	/** Index of the enclosing scope; -1 for the file. */
	parent: number;
	start: number;
	end: number;
	/** Runs somewhere other than the enclosing scope (see `SqfIssue.reachesCaller`). */
	detached: boolean;
	/** Set when the block is a code block stored in a local variable (index into `codeBlocks`). */
	codeBlock?: number;
	/**
	 * May run more than once, so code before a point in it can also run after that
	 * point: a loop body or condition, `forEach`, `count`, `waitUntil` and the like.
	 * Only `then`, `else`, `exitWith`, `try`, `catch`, `call`, `isNil`, `switch` and its
	 * cases are known to run at most once; everything else is assumed to repeat.
	 */
	repeats: boolean;
	/** The statement containing the block (e.g. the whole `while {...} do {...}`), when it `repeats`. */
	statementStart: number;
	statementEnd: number;
	/**
	 * Set on a block that is one of several alternatives, of which at most one runs: the
	 * `then` and `else` blocks of one `if` (also `then [{...}, {...}]`), or the `case` and
	 * `default` blocks of one `switch`. Blocks with the same `branch` are alternatives to
	 * each other; the value identifies their statement.
	 */
	branch?: number;
	/**
	 * Set on the block of `if (...) exitWith {...}`: the offset where that statement ends.
	 * Once the block has run, the rest of the enclosing scope is skipped.
	 */
	exits?: number;
}

/**
 * Something that happens to a local variable, at `offset`, in flow scope `scope`.
 * `assign` is a non-private assignment and `declare` a `private`/`params`/`for`
 * declaration; both take effect at the end of their statement (so `_a = _a + 1` reads
 * `_a` first). A `read` is any other mention, including inside a string
 * (`isNil "_a"`, `compile "..."`). A `call` has no name: its `offset` is that of the
 * `call` keyword, and it is either one of `callSites` or a callee that cannot be
 * followed (`call _param`, `call compile _string`); inline `call {...}` is not one.
 */
export type FlowEvent =
	| { kind: 'read' | 'assign' | 'declare'; name: string; offset: number; scope: number }
	| { kind: 'call'; offset: number; scope: number };

export interface FlowFacts {
	scopes: FlowScope[];
	/** Sorted by offset. */
	events: FlowEvent[];
}

/** A local variable assigned without `private` somewhere. */
export interface LocalWrite {
	/** The variable as written. */
	variable: string;
	start: number;
	end: number;
	/**
	 * Set when the assigned value is just what the caller passed in: element `argument`
	 * of `_this` (`_x = _this select 1`, also `_this # 1`, in parentheses or not), or
	 * `_this` itself (-1).
	 */
	argument?: number;
	/** Copied to `SqfIssue.cases`. */
	cases?: CaseGuard[];
}

/**
 * A `{...}` stored in a variable: a local one (`private _fnc = {...}; call _fnc`) or a
 * global function (`TAG_fnc_foo = {...}`), which `call` runs in the caller's scope.
 */
export interface CodeBlock {
	/**
	 * First assignment of each name that the block does not declare itself, so it reaches
	 * the block's caller; and the first one in each further set of `case` blocks, when
	 * the earlier ones only run for some calls.
	 */
	writes: LocalWrite[];
}

/** `TAG_fnc_foo = {...}`: a global function whose body is a code block in this file. */
export interface CodeFunction {
	/** Lowercased function name. */
	name: string;
	/** Index into `codeBlocks`. */
	block: number;
}

/** `TAG_fnc_foo = compile preprocessFileLineNumbers "foo.sqf"` and similar. */
export interface CompiledFunction {
	/** Lowercased function name. */
	name: string;
	/** The path as written in the source. */
	path: string;
}

export interface AnalyzerOptions {
	/** Extra engine/macro supplied variables that must never be reported. */
	magicVariables?: string[];
	/** Treat `params ["_x"]` as a private declaration. Defaults to true. */
	treatParamsAsPrivate?: boolean;
	/** Treat `for "_i" from ...` as a private declaration. Defaults to true. */
	treatForLoopVariablesAsPrivate?: boolean;
}

export interface AnalyzeResult {
	issues: SqfIssue[];
	/** Local variable names (lowercased) declared `private` somewhere in the file. */
	privateNames: Set<string>;
	/** Local variable names (lowercased) that have a `missing-private` issue in the file. */
	nonPrivateNames: Set<string>;
	/** Every `call` whose callee can be identified statically. */
	callSites: CallSite[];
	/** Global functions this file defines by compiling another file. */
	compiledFunctions: CompiledFunction[];
	/** Global functions this file defines as a code block (`TAG_fnc_foo = {...}`). */
	codeFunctions: CodeFunction[];
	/** Code blocks stored in local variables, referenced by `CallTarget` and `CallSite.codeBlock`. */
	codeBlocks: CodeBlock[];
	/** Reads and writes of local variables, to tell whether a value is used after a call (see `flow.ts`). */
	flow: FlowFacts;
}

/** One place in the file where a name first becomes a local variable in some scope. */
interface NameOccurrence {
	name: string;
	isPrivate: boolean;
}

/**
 * Variables the engine puts into scope for us. They are private already, so
 * writing `private _x` inside a `forEach` would be a bug, not a fix.
 */
export const DEFAULT_MAGIC_VARIABLES = [
	'_this',
	'_x',
	'_y',
	'_forEachIndex',
	'_exception',
	'_thisScript',
	'_thisFSM',
	'_thisEventHandler',
	'_thisArgs',
	'_thisTrigger',
	'_thisList',
	'_thisObject',
	'_thisType',
	'_fnc_scriptName',
	'_fnc_scriptNameParent'
];

const COMPILE_COMMANDS = new Set(['compile', 'compilefinal', 'compilescript']);
const PREPROCESS_COMMANDS = new Set(['preprocessfilelinenumbers', 'preprocessfile', 'loadfile']);
/**
 * Commands whose `{...}` argument runs somewhere else than the current scope: in a
 * scope of its own, or later, when an event fires. Event handlers that take their code
 * inside an array (`addEventHandler ["Killed", {...}]`) are covered by the array rule
 * in `opensDetachedBlock`; these take it directly.
 */
const DETACHING_COMMANDS = new Set([
	'spawn',
	'oneachframe',
	'compilefinal',
	'addpublicvariableeventhandler',
	'onplayerconnected',
	'onplayerdisconnected',
	'onmapsingleclick',
	'onpreloadstarted',
	'onpreloadfinished',
	'onteamswitch',
	'oncommandmodechanged',
	'onhcgroupselectionchanged',
	'ongroupiconclick',
	'ongroupiconoverenter',
	'ongroupiconoverleave'
]);
/** Commands whose `{...}` argument runs at most once, in place. */
const RUN_ONCE_COMMANDS = new Set(['then', 'else', 'exitwith', 'try', 'catch', 'call', 'isnil', 'default']);
/** Statements whose `do {...}` block runs at most once. */
const RUN_ONCE_DO_STATEMENTS = new Set(['switch', 'with']);
/** A local variable name inside a string, e.g. in `isNil "_a"` or `compile "hint str _a"`. */
const LOCAL_NAME_IN_STRING = /(?<![A-Za-z0-9_])_[A-Za-z0-9_]+/g;

interface Scope {
	/** Index into `FlowFacts.scopes`. */
	id: number;
	names: Set<string>;
	/** The subset of `names` that were assigned without being declared `private`. */
	nonPrivate: Set<string>;
	/** The block does not run in the enclosing scope (see `SqfIssue.reachesCaller`). */
	detached: boolean;
	/** Set when the block is a code block stored in a local variable (index into `codeBlocks`). */
	codeBlock?: number;
	/** Token index of the `{`; -1 for the file. */
	brace: number;
	/** Code in the block has a `_this` of its own: it is detached, or run with `call`. */
	bindsThis: boolean;
	/**
	 * Names first added to `names` by a statement that is still running, with the token
	 * index where it ends: `private _a = [] call f` only creates `_a` once `f` has
	 * returned, so `f` cannot overwrite it.
	 */
	pending: Map<string, number>;
	/** Set on a `case` or `default` block of a `switch`. */
	guard?: PendingGuard;
}

/** A `CaseGuard` whose switch subject may still have to be traced back to `_this`. */
interface PendingGuard {
	/** An element of `_this` (see `CaseGuard.argument`), or a local variable (lowercased) that may hold one. */
	subject: number | string;
	/** Flow scope whose `_this` the switch sees. */
	thisScope: number;
	/** Offset of the `switch`. */
	offset: number;
	values: string[];
	isDefault: boolean;
}

/** Every assignment to one local variable name in a file. */
interface LocalAssignments {
	count: number;
	/** What the last assignment stored, when it is something `call` can be followed into. */
	value?: CallTarget;
	/** When the last assignment stored an element of `_this` (see `LocalWrite.argument`): which one, and where. */
	argument?: { index: number; thisScope: number; offset: number };
}

export function analyze(text: string, options: AnalyzerOptions = {}): SqfIssue[] {
	return analyzeFile(text, options).issues;
}

export function analyzeFile(text: string, options: AnalyzerOptions = {}): AnalyzeResult {
	const comments: Comment[] = [];
	const tokens = tokenize(text, comments);
	const magic = new Set(
		[...DEFAULT_MAGIC_VARIABLES, ...(options.magicVariables ?? [])].map(name => name.toLowerCase())
	);
	const paramsDeclare = options.treatParamsAsPrivate !== false;
	const forDeclare = options.treatForLoopVariablesAsPrivate !== false;

	// SQF variable names are case insensitive, so every lookup is lowercased.
	const scopes: Scope[] = [
		{
			id: 0,
			names: new Set<string>(),
			nonPrivate: new Set<string>(),
			detached: false,
			brace: -1,
			bindsThis: true,
			pending: new Map<string, number>()
		}
	];
	const flowScopes: FlowScope[] = [
		{ parent: -1, start: 0, end: text.length, detached: false, repeats: false, statementStart: 0, statementEnd: text.length }
	];
	const events: FlowEvent[] = [];
	const offsetAt = (index: number) => (index < tokens.length ? tokens[index].start : text.length);
	const currentScope = () => scopes[scopes.length - 1].id;
	const addEvent = (kind: 'read' | 'assign' | 'declare', name: string, offset: number) =>
		events.push({ kind, name: name.toLowerCase(), offset, scope: currentScope() });
	// A `for "_i"` variable belongs to the loop body, which has not been opened yet.
	let pendingForVariable: string | undefined;
	const occurrences: NameOccurrence[] = [];
	const callSites: CallSite[] = [];
	const compiledFunctions: CompiledFunction[] = [];
	const codeFunctions: CodeFunction[] = [];
	// For each open `[`, whether it is the `then [{...}, {...}]` form, whose blocks
	// run in place like ordinary `then {...} else {...}` blocks.
	const arrays: boolean[] = [];
	// Token index of each open `[`.
	const arrayStarts: number[] = [];
	const codeBlocks: CodeBlock[] = [];
	// Token index of a `{` -> the code block it opens.
	const codeBlockStarts = new Map<number, number>();
	const localAssignments = new Map<string, LocalAssignments>();
	// `call _fnc` sites, resolved once every assignment to `_fnc` is known.
	const localCalls: { site: Omit<CallSite, 'target'>; name: string }[] = [];

	// `until`: the token index where the statement that creates the variable ends.
	const markDeclared = (name: string, until: number) => {
		const scope = scopes[scopes.length - 1];
		scope.names.add(name.toLowerCase());
		scope.nonPrivate.add(name.toLowerCase());
		scope.pending.set(name.toLowerCase(), until);
	};

	// Used for `private`/`params`/`for` declarations. Only the first time a scope
	// sees a name counts as an "occurrence" of that local variable, so redundantly
	// re-declaring it is not recorded twice.
	const declare = (name: string, until?: number) => {
		const lower = name.toLowerCase();
		const scope = scopes[scopes.length - 1];
		if (!scope.names.has(lower)) {
			scope.names.add(lower);
			if (until !== undefined) {
				scope.pending.set(lower, until);
			}
			occurrences.push({ name, isPrivate: true });
		}
	};
	const isDeclared = (name: string) => {
		const lower = name.toLowerCase();
		return scopes.some(scope => scope.names.has(lower));
	};
	const isDetached = () => scopes.some(scope => scope.detached);
	const nearestDetached = () => {
		for (let s = scopes.length - 1; s >= 0; s--) {
			if (scopes[s].detached) {
				return s;
			}
		}
		return -1;
	};
	const currentCodeBlock = () => {
		const frame = nearestDetached();
		return frame === -1 ? undefined : scopes[frame].codeBlock;
	};
	// Whether a local holding code is reachable from here: code blocks run in their
	// caller's scope, so their enclosing scopes count; other detached blocks do not.
	const isReachableLocal = (lower: string) => {
		for (let s = scopes.length - 1; s >= 0; s--) {
			if (scopes[s].names.has(lower)) {
				return true;
			}
			if (scopes[s].detached && scopes[s].codeBlock === undefined) {
				return false;
			}
		}
		return false;
	};
	const thisScope = () => {
		for (let s = scopes.length - 1; s > 0; s--) {
			if (scopes[s].bindsThis) {
				return scopes[s].id;
			}
		}
		return 0;
	};
	// The `case` blocks an assignment here sits in, within its own function body.
	const guardsHere = () => {
		const frame = Math.max(nearestDetached(), 0);
		const frameThis = scopes[frame].id;
		return scopes
			.slice(frame)
			.flatMap(scope => (scope.guard && scope.guard.thisScope === frameThis ? [scope.guard] : []));
	};
	// Assignments whose `cases` are still pending, resolved once every assignment is known.
	const pendingGuards = new Map<SqfIssue | LocalWrite, PendingGuard[]>();
	const recordAssignment = (name: string, valueIndex: number, argument?: number) => {
		const lower = name.toLowerCase();
		const entry = localAssignments.get(lower) ?? { count: 0 };
		entry.count++;
		entry.value = undefined;
		entry.argument = undefined;
		if (argument !== undefined) {
			entry.argument = { index: argument, thisScope: thisScope(), offset: offsetAt(valueIndex) };
		}
		const value = tokens[valueIndex];
		if (value?.type === 'symbol' && value.value === '{') {
			codeBlocks.push({ writes: [] });
			codeBlockStarts.set(valueIndex, codeBlocks.length - 1);
			entry.value = { kind: 'code', block: codeBlocks.length - 1 };
		} else if (value?.type === 'ident' && COMPILE_COMMANDS.has(value.value.toLowerCase())) {
			const compiled = readCompiledPath(tokens, valueIndex);
			if (compiled) {
				entry.value = { kind: 'file', path: compiled.path };
			}
		}
		localAssignments.set(lower, entry);
	};
	// The local variables that exist at token `index`, and the scope of each.
	const visibleOwners = (index: number) => {
		const owners = new Map<string, { scope: number; isPrivate: boolean }>();
		for (let s = scopes.length - 1; s >= 0; s--) {
			for (const name of scopes[s].names) {
				// Still being created by the statement `index` is in; an outer one may exist.
				const pending = scopes[s].pending.get(name);
				if (!owners.has(name) && !(pending !== undefined && index < pending)) {
					owners.set(name, { scope: scopes[s].id, isPrivate: !scopes[s].nonPrivate.has(name) });
				}
			}
			if (scopes[s].detached) {
				break;
			}
		}
		return owners;
	};

	const issues: SqfIssue[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		if (token.type === 'symbol') {
			if (token.value === '{') {
				const detached = opensDetachedBlock(tokens[i - 1], arrays);
				const codeBlock = codeBlockStarts.get(i);
				const repeats = !detached && mayRepeat(tokens, i, arrays);
				const alternative = detached ? {} : readAlternative(tokens, i, arrays, arrayStarts, flowScopes[currentScope()]);
				const guard = detached ? undefined : readCaseGuard(tokens, i, scopes[scopes.length - 1].brace, thisScope());
				flowScopes.push({
					parent: currentScope(),
					start: token.start,
					end: text.length,
					detached,
					codeBlock,
					repeats,
					statementStart: repeats ? offsetAt(statementStart(tokens, i)) : token.start,
					statementEnd: repeats ? offsetAt(statementEnd(tokens, i)) : token.start,
					...alternative
				});
				scopes.push({
					id: flowScopes.length - 1,
					names: new Set<string>(),
					nonPrivate: new Set<string>(),
					pending: new Map<string, number>(),
					detached,
					codeBlock,
					brace: i,
					bindsThis: detached || (tokens[i - 1]?.type === 'ident' && tokens[i - 1].value.toLowerCase() === 'call'),
					...optional('guard', guard)
				});
				if (pendingForVariable !== undefined) {
					if (tokens[i - 1]?.type === 'ident' && tokens[i - 1].value.toLowerCase() === 'do') {
						addEvent('declare', pendingForVariable, token.start);
					}
					pendingForVariable = undefined;
				}
			} else if (token.value === '}' && scopes.length > 1) {
				flowScopes[currentScope()].end = token.end;
				scopes.pop();
			} else if (token.value === '[') {
				const previous = tokens[i - 1];
				arrays.push(previous !== undefined && previous.type === 'ident' && previous.value.toLowerCase() === 'then');
				arrayStarts.push(i);
			} else if (token.value === ']') {
				arrays.pop();
				arrayStarts.pop();
			}
			continue;
		}

		// Strings that declare something (`private "_a"`, `params [...]`, `for "_i"`) are
		// consumed below; any other mention of a local variable may be a read.
		if (token.type === 'string') {
			for (const [name] of token.value.matchAll(LOCAL_NAME_IN_STRING)) {
				if (!magic.has(name.toLowerCase())) {
					addEvent('read', name, token.start);
				}
			}
			continue;
		}

		if (token.type !== 'ident') {
			continue;
		}

		const lower = token.value.toLowerCase();
		// Declarations and assignments take effect once their statement has run.
		const declareHere = (name: string) => {
			declare(name, statementEnd(tokens, i));
			addEvent('declare', name, offsetAt(statementEnd(tokens, i)));
		};

		if (lower === 'private') {
			const declared = tokens[i + 1];
			i = consumePrivate(tokens, i, declareHere);
			if (declared?.type === 'ident' && tokens[i] === declared && tokens[i + 1]?.value === '=') {
				recordAssignment(declared.value, i + 2, readThisArgument(tokens, i + 2, statementEnd(tokens, i)));
			}
			continue;
		}

		if (paramsDeclare && lower === 'params') {
			const next = tokens[i + 1];
			if (next && next.type === 'symbol' && next.value === '[') {
				// `params [...]` reads `_this`; `_array params [...]` reads `_array`.
				const previous = tokens[i - 1];
				const ofThis = previous === undefined || (previous.type === 'symbol' && ARGUMENT_BOUNDARIES.has(previous.value));
				i = declareStringsInArray(tokens, i + 1, (name, position) => {
					declareHere(name);
					recordAssignment(name, i, ofThis ? position : undefined);
				});
			}
			continue;
		}

		if (forDeclare && lower === 'for') {
			const next = tokens[i + 1];
			if (next && next.type === 'string' && isLocalVariableName(next.value)) {
				declare(next.value);
				pendingForVariable = next.value;
				i++;
			}
			continue;
		}

		if (lower === 'call') {
			const owners = visibleOwners(i);
			const site = {
				start: token.start,
				visibleNames: new Set(owners.keys()),
				detached: isDetached(),
				codeBlock: currentCodeBlock(),
				scope: currentScope(),
				owners,
				...readPassed(tokens, i)
			};
			const callee = tokens[i + 1];
			// Inline code is part of this file, so its reads and writes are seen directly;
			// so is code compiled from a string written right here (its names are read
			// events of the string).
			const inline = (callee?.type === 'symbol' && callee.value === '{') || compilesVisibleCode(tokens, i + 1);
			if (!inline) {
				events.push({ kind: 'call', offset: token.start, scope: currentScope() });
			}
			if (callee?.type === 'ident' && isLocalVariableName(callee.value)) {
				const name = callee.value.toLowerCase();
				if (isReachableLocal(name)) {
					localCalls.push({ site: { ...site, label: callee.value, end: callee.end }, name });
				}
				continue;
			}
			const call = readCallTarget(tokens, i);
			if (call) {
				callSites.push({ ...call, ...site });
			}
			continue;
		}

		if (COMPILE_COMMANDS.has(lower)) {
			const name = definedFunctionName(tokens, i);
			const compiled = readCompiledPath(tokens, i);
			if (name && compiled) {
				compiledFunctions.push({ name: name.toLowerCase(), path: compiled.path });
			}
			continue;
		}

		// `TAG_fnc_foo = {...}`, `TAG_fnc_foo = compileFinal {...}` and
		// `missionNamespace setVariable ["TAG_fnc_foo", {...}]` define a function; its body
		// only runs when it is called.
		const definition = readCodeFunctionDefinition(tokens, i);
		if (definition) {
			codeBlocks.push({ writes: [] });
			codeBlockStarts.set(definition.brace, codeBlocks.length - 1);
			codeFunctions.push({ name: definition.name.toLowerCase(), block: codeBlocks.length - 1 });
			continue;
		}

		if (!token.value.startsWith('_') || magic.has(lower)) {
			continue;
		}

		const next = tokens[i + 1];
		const isAssignment = next !== undefined && next.type === 'symbol' && next.value === '=';
		addEvent(isAssignment ? 'assign' : 'read', token.value, isAssignment ? offsetAt(statementEnd(tokens, i)) : token.start);
		const argument = isAssignment ? readThisArgument(tokens, i + 2, statementEnd(tokens, i)) : undefined;
		const guards = isAssignment ? guardsHere() : [];
		if (isAssignment) {
			recordAssignment(token.value, i + 2, argument);

			// Inside a code block, anything the block does not declare itself reaches
			// whoever calls it, even if the file declares that name further out. A later
			// assignment counts too when it runs for calls that the earlier ones do not.
			const frame = nearestDetached();
			const block = frame === -1 ? undefined : scopes[frame].codeBlock;
			if (block !== undefined && !scopes.slice(frame).some(scope => scope.names.has(lower))) {
				const writes = codeBlocks[block].writes;
				const covered = writes.some(
					write =>
						write.variable.toLowerCase() === lower &&
						(pendingGuards.get(write) ?? []).every(guard => guards.includes(guard))
				);
				if (!covered) {
					const write: LocalWrite = { variable: token.value, start: token.start, end: token.end, ...optional('argument', argument) };
					writes.push(write);
					pendingGuards.set(write, guards);
				}
			}
		}
		if (isAssignment && !isDeclared(token.value)) {
			pendingGuards.set(issues[issues.push({
				variable: token.value,
				start: token.start,
				end: token.end,
				message: `Local variable '${token.value}' is assigned without being declared private.`,
				kind: 'missing-private',
				reachesCaller: !isDetached(),
				...optional('argument', argument)
			}) - 1], guards);
			// Record it so the same variable is reported once per scope rather
			// than on every following assignment.
			markDeclared(token.value, statementEnd(tokens, i));
			occurrences.push({ name: token.value, isPrivate: false });
		}
	}

	// A switch on a local variable is on the caller's argument when the variable is
	// assigned exactly once in the file, from `_this`, before the switch.
	const argumentOf = (guard: PendingGuard) => {
		if (typeof guard.subject === 'number') {
			return guard.subject;
		}
		const assignments = localAssignments.get(guard.subject);
		const argument = assignments?.count === 1 ? assignments.argument : undefined;
		return argument && argument.thisScope === guard.thisScope && argument.offset < guard.offset ? argument.index : undefined;
	};
	for (const [write, guards] of pendingGuards) {
		const cases = guards.flatMap(guard => {
			const argument = argumentOf(guard);
			return argument === undefined
				? []
				: [{ argument, values: guard.values, ...(guard.isDefault ? { isDefault: true } : {}) }];
		});
		if (cases.length > 0) {
			write.cases = cases;
		}
	}

	// `// sqf-private: shared _a, _b` in a function body: its assignments to those names
	// are meant for its caller, so they are neither issues nor scope leaks.
	const shared = sharedDirectives(comments, flowScopes);
	const isShared = (write: { variable: string; start: number }) => {
		const frame = frameAt(flowScopes, write.start);
		return shared.some(directive => directive.frame === frame && directive.names.has(write.variable.toLowerCase()));
	};
	const reported = issues.filter(issue => !isShared(issue));
	for (const block of codeBlocks) {
		block.writes = block.writes.filter(write => !isShared(write));
	}

	const privateNames = new Set<string>();
	for (const occurrence of occurrences) {
		if (occurrence.isPrivate) {
			privateNames.add(occurrence.name.toLowerCase());
		}
	}
	// Every non-private occurrence is an issue.
	const nonPrivateNames = new Set(reported.map(issue => issue.variable.toLowerCase()));

	// `call _fnc` is only followed when `_fnc` is assigned exactly once in the file, so
	// there is no doubt about what it holds.
	for (const { site, name } of localCalls) {
		const assignments = localAssignments.get(name);
		if (assignments?.count === 1 && assignments.value) {
			callSites.push({ ...site, target: assignments.value });
		}
	}
	callSites.sort((a, b) => a.start - b.start);
	events.sort((a, b) => a.offset - b.offset);

	return {
		issues: reported,
		privateNames,
		nonPrivateNames,
		callSites,
		compiledFunctions,
		codeFunctions,
		codeBlocks,
		flow: { scopes: flowScopes, events }
	};
}

/** `{ [key]: value }`, or nothing when `value` is undefined, so objects compare equal without the key. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

const SHARED_DIRECTIVE = /\bsqf-private:\s*shared\b(.*)/i;

/** The `sqf-private: shared` comments, each with its frame (see `frameAt`) and the names (lowercased) it lists. */
function sharedDirectives(comments: Comment[], scopes: FlowScope[]): { frame: number; names: Set<string> }[] {
	const directives: { frame: number; names: Set<string> }[] = [];
	for (const comment of comments) {
		const match = SHARED_DIRECTIVE.exec(comment.text);
		if (match) {
			const names = new Set([...match[1].matchAll(/_[A-Za-z0-9_]+/g)].map(([name]) => name.toLowerCase()));
			directives.push({ frame: frameAt(scopes, comment.start), names });
		}
	}
	return directives;
}

/**
 * The function body that `offset` is in: the nearest enclosing block that does not run
 * in its surrounding scope (a code block stored in a variable, a `spawn` block, ...), or
 * the file (0).
 */
function frameAt(scopes: FlowScope[], offset: number): number {
	let innermost = 0;
	scopes.forEach((scope, index) => {
		// Blocks are recorded in source order, so a later one containing `offset` is nested deeper.
		if (index > 0 && scope.start <= offset && offset < scope.end) {
			innermost = index;
		}
	});
	let frame = innermost;
	while (frame > 0 && !scopes[frame].detached) {
		frame = scopes[frame].parent;
	}
	return frame;
}

/** Tokens after which an expression starts, so `[...] call f` there is given exactly that array. */
const ARGUMENT_BOUNDARIES = new Set(['=', '(', '[', ',', ';', '{']);

/** What `CallSite.passed` and `CallSite.constants` say for the `call` at `index`. */
function readPassed(tokens: Token[], index: number): Pick<CallSite, 'passed' | 'constants'> {
	const single = (from: number, to: number) => (to - from === 1 ? tokens[from] : undefined);
	const localName = (token: Token | undefined) =>
		token?.type === 'ident' && isLocalVariableName(token.value) ? token.value.toLowerCase() : undefined;
	const last = index - 1;
	let first: number;
	let items: (Token | undefined)[];
	let isArray = false;
	if (localName(tokens[last]) !== undefined || constantKey(tokens[last]) !== undefined) {
		first = last;
		items = [tokens[last]];
	} else if (tokens[last]?.type === 'symbol' && tokens[last].value === ']') {
		let depth = 0;
		for (first = last; first >= 0; first--) {
			const value = tokens[first].type === 'symbol' ? tokens[first].value : '';
			if (value === ']') {
				depth++;
			} else if (value === '[' && --depth === 0) {
				break;
			}
		}
		if (first < 0) {
			return {};
		}
		items = [];
		let itemStart = first + 1;
		depth = 0;
		for (let j = first + 1; j < last; j++) {
			const value = tokens[j].type === 'symbol' ? tokens[j].value : '';
			if (value === '(' || value === '[' || value === '{') {
				depth++;
			} else if (value === ')' || value === ']' || value === '}') {
				depth--;
			} else if (value === ',' && depth === 0) {
				items.push(single(itemStart, j));
				itemStart = j + 1;
			}
		}
		if (itemStart < last) {
			items.push(single(itemStart, last));
		}
		isArray = true;
	} else {
		return {};
	}
	const before = tokens[first - 1];
	if (!(before === undefined || (before.type === 'symbol' && ARGUMENT_BOUNDARIES.has(before.value)))) {
		return {};
	}
	if (!isArray) {
		return { ...optional('passed', localName(items[0])), ...optional('constants', constantKey(items[0])) };
	}
	const constants = items.map(constantKey);
	return {
		passed: items.map(localName),
		...(constants.some(key => key !== undefined) ? { constants } : {})
	};
}

/**
 * A literal string or number as a switch compares it: `"a"` -> `'"a'` (lowercased, as
 * string comparison in SQF ignores case), `2` -> `'#2'`. Undefined for anything else.
 */
export function constantKey(token: Token | undefined): string | undefined {
	if (token?.type === 'string') {
		return `"${token.value.toLowerCase()}`;
	}
	if (token?.type === 'number') {
		const value = Number(token.value.replace(/^\$/, '0x'));
		return Number.isNaN(value) ? undefined : `#${value}`;
	}
	return undefined;
}

/**
 * The `PendingGuard` of the block opened by the `{` at `index`, when it is a `case` or
 * `default` block of a switch on `_this` or a local variable, and every case label of
 * that switch that matters is a literal. `parentBrace` is the `{` of the enclosing block.
 */
function readCaseGuard(tokens: Token[], index: number, parentBrace: number, thisScope: number): PendingGuard | undefined {
	const isSymbol = (i: number, value: string) => tokens[i]?.type === 'symbol' && tokens[i].value === value;
	const isIdent = (i: number, value: string) => tokens[i]?.type === 'ident' && tokens[i].value.toLowerCase() === value;
	const isDefault = isIdent(index - 1, 'default');
	if (!(isDefault || isSymbol(index - 1, ':')) || parentBrace < 0 || !isIdent(parentBrace - 1, 'do')) {
		return undefined;
	}
	const switchIndex = statementStart(tokens, parentBrace - 1);
	if (!isIdent(switchIndex, 'switch')) {
		return undefined;
	}

	let from = switchIndex + 1;
	let to = parentBrace - 1;
	while (isSymbol(from, '(') && isSymbol(to - 1, ')') && closingParenthesis(tokens, from) === to - 1) {
		from++;
		to--;
	}
	const argument = readThisArgument(tokens, from, to);
	const subject =
		argument ?? (to - from === 1 && tokens[from].type === 'ident' && isLocalVariableName(tokens[from].value)
			? tokens[from].value.toLowerCase()
			: undefined);
	if (subject === undefined) {
		return undefined;
	}

	const values: string[] = [];
	if (isDefault) {
		// Every label in the switch body, which `default` runs for none of.
		let depth = 0;
		for (let i = parentBrace + 1; i < tokens.length; i++) {
			if (tokens[i].type === 'symbol') {
				if (tokens[i].value === '(' || tokens[i].value === '[' || tokens[i].value === '{') {
					depth++;
				} else if (tokens[i].value === ')' || tokens[i].value === ']' || tokens[i].value === '}') {
					if (depth-- === 0) {
						break;
					}
				}
			} else if (depth === 0 && isIdent(i, 'case')) {
				const key = constantKey(tokens[i + 1]);
				if (key === undefined || !(isSymbol(i + 2, ':') || isSymbol(i + 2, ';'))) {
					return undefined;
				}
				values.push(key);
			}
		}
	} else {
		// `case "a"; case "b": {...}` runs the block for both.
		for (let colon = index - 1; ; colon -= 3) {
			const key = constantKey(tokens[colon - 1]);
			if (key === undefined || !isIdent(colon - 2, 'case')) {
				return undefined;
			}
			values.push(key);
			if (!isSymbol(colon - 3, ';') || !isIdent(colon - 5, 'case')) {
				break;
			}
		}
	}
	return { subject, thisScope, offset: tokens[switchIndex].start, values, isDefault };
}

/** What `LocalWrite.argument` says for the value in tokens [from, to). */
function readThisArgument(tokens: Token[], from: number, to: number): number | undefined {
	const isSymbol = (i: number, value: string) => tokens[i]?.type === 'symbol' && tokens[i].value === value;
	while (isSymbol(from, '(') && isSymbol(to - 1, ')') && closingParenthesis(tokens, from) === to - 1) {
		from++;
		to--;
	}
	const first = tokens[from];
	if (first?.type !== 'ident' || first.value.toLowerCase() !== '_this') {
		return undefined;
	}
	if (to - from === 1) {
		return -1;
	}
	const operator = tokens[from + 1];
	const index = tokens[from + 2];
	const selects = operator.value.toLowerCase() === 'select' || isSymbol(from + 1, '#');
	return to - from === 3 && selects && index.type === 'number' && /^\d+$/.test(index.value) ? Number(index.value) : undefined;
}

/** Index of the `)` matching the `(` at `index`. */
function closingParenthesis(tokens: Token[], index: number): number {
	let depth = 0;
	for (let i = index; i < tokens.length; i++) {
		if (tokens[i].type !== 'symbol') {
			continue;
		}
		if (tokens[i].value === '(') {
			depth++;
		} else if (tokens[i].value === ')' && --depth === 0) {
			return i;
		}
	}
	return -1;
}

/**
 * `FlowScope.branch` and `FlowScope.exits` for the (not detached) block opened by the
 * `{` at `index`, inside `parent`.
 */
function readAlternative(
	tokens: Token[],
	index: number,
	arrays: boolean[],
	arrayStarts: number[],
	parent: FlowScope
): Pick<FlowScope, 'branch' | 'exits'> {
	const previous = tokens[index - 1];
	const offsetOf = (i: number) => (i < tokens.length ? tokens[i].start : tokens[tokens.length - 1].end);
	if (previous?.type === 'ident') {
		const command = previous.value.toLowerCase();
		// Both blocks of one `if` share the start of its statement.
		if (command === 'then' || command === 'else') {
			return { branch: offsetOf(statementStart(tokens, index - 1)) };
		}
		// Everything directly in a `switch` body is its cases.
		if (command === 'default') {
			return { branch: parent.start };
		}
		if (command === 'exitwith') {
			return { exits: offsetOf(statementEnd(tokens, index)) };
		}
		return {};
	}
	if (previous?.type === 'symbol') {
		if (previous.value === ':') {
			return { branch: parent.start };
		}
		// `if (...) then [{...}, {...}]`.
		if ((previous.value === '[' || previous.value === ',') && arrays[arrays.length - 1]) {
			return { branch: offsetOf(statementStart(tokens, arrayStarts[arrayStarts.length - 1] - 1)) };
		}
	}
	return {};
}

/**
 * Whether the `{` at `index` opens a block that may run more than once (see
 * `FlowScope.repeats`). Assumed so unless it is known to run at most once.
 */
function mayRepeat(tokens: Token[], index: number, arrays: boolean[]): boolean {
	const previous = tokens[index - 1];
	if (previous?.type === 'ident') {
		const command = previous.value.toLowerCase();
		if (command === 'do') {
			const first = tokens[statementStart(tokens, index)];
			return !(first?.type === 'ident' && RUN_ONCE_DO_STATEMENTS.has(first.value.toLowerCase()));
		}
		return !RUN_ONCE_COMMANDS.has(command);
	}
	if (previous?.type === 'symbol') {
		// `case 1: {...}`, and the blocks of `then [{...}, {...}]`.
		if (previous.value === ':') {
			return false;
		}
		if ((previous.value === '[' || previous.value === ',') && arrays[arrays.length - 1]) {
			return false;
		}
	}
	return true;
}

/**
 * Reads a global function defined as a code block, starting at the token at `index`:
 * `anyName = {...}` or `anyName = compileFinal {...}` (at the name), or
 * `missionNamespace setVariable ["anyName", {...}]`, also with `compileFinal {...}` and
 * further arguments (at `setVariable`). Returns the name and the index of the `{`.
 */
function readCodeFunctionDefinition(tokens: Token[], index: number): { name: string; brace: number } | undefined {
	const token = tokens[index];
	const isSymbol = (i: number, value: string) => tokens[i]?.type === 'symbol' && tokens[i].value === value;
	// The `{`, possibly after `compileFinal`, starting at `i`.
	const braceAt = (i: number) => {
		if (tokens[i]?.type === 'ident' && tokens[i].value.toLowerCase() === 'compilefinal') {
			i++;
		}
		return isSymbol(i, '{') ? i : undefined;
	};
	if (token.type !== 'ident' || token.value.startsWith('_')) {
		return undefined;
	}

	if (isSymbol(index + 1, '=')) {
		const brace = braceAt(index + 2);
		return brace === undefined ? undefined : { name: token.value, brace };
	}

	const namespace = tokens[index - 1];
	const name = tokens[index + 2];
	if (
		token.value.toLowerCase() === 'setvariable' &&
		namespace?.type === 'ident' &&
		namespace.value.toLowerCase() === 'missionnamespace' &&
		isSymbol(index + 1, '[') &&
		name?.type === 'string' &&
		name.value.trim().length > 0 &&
		!name.value.trim().startsWith('_') &&
		isSymbol(index + 3, ',')
	) {
		const brace = braceAt(index + 4);
		return brace === undefined ? undefined : { name: name.value.trim(), brace };
	}
	return undefined;
}

/**
 * Whether the tokens at `index` compile code whose text is all here:
 * `compile "..."` or `compile format ["...", ...]` (any `compile` command, with or
 * without parentheses). With `format`, every `%1` placeholder must continue a name
 * (`"TAG_%1 = _a"`): one that could start a name of its own could be filled in with a
 * local variable's name.
 */
function compilesVisibleCode(tokens: Token[], index: number): boolean {
	let i = index;
	if (!(tokens[i]?.type === 'ident' && COMPILE_COMMANDS.has(tokens[i].value.toLowerCase()))) {
		return false;
	}
	i++;
	while (tokens[i]?.type === 'symbol' && tokens[i].value === '(') {
		i++;
	}
	if (tokens[i]?.type === 'string') {
		return true;
	}
	if (!(tokens[i]?.type === 'ident' && tokens[i].value.toLowerCase() === 'format')) {
		return false;
	}
	i++;
	while (tokens[i]?.type === 'symbol' && tokens[i].value === '(') {
		i++;
	}
	if (!(tokens[i]?.type === 'symbol' && tokens[i].value === '[' && tokens[i + 1]?.type === 'string')) {
		return false;
	}
	return !/(?<![A-Za-z0-9_])%\d/.test(tokens[i + 1].value);
}

/** Index of the first token of the statement containing the token at `index`. */
function statementStart(tokens: Token[], index: number): number {
	let depth = 0;
	for (let i = index - 1; i >= 0; i--) {
		const token = tokens[i];
		if (token.type !== 'symbol') {
			continue;
		}
		if (token.value === ')' || token.value === ']' || token.value === '}') {
			depth++;
		} else if (token.value === '(' || token.value === '[' || token.value === '{') {
			if (depth === 0) {
				return i + 1;
			}
			depth--;
		} else if (depth === 0 && (token.value === ';' || token.value === ',')) {
			return i + 1;
		}
	}
	return 0;
}

/**
 * Index of the token that ends the statement containing the token at `index`: its `;`
 * or `,`, or the bracket closing the enclosing block. `tokens.length` at the end of the file.
 */
function statementEnd(tokens: Token[], index: number): number {
	let depth = 0;
	for (let i = index; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.type !== 'symbol') {
			continue;
		}
		if (token.value === '(' || token.value === '[' || token.value === '{') {
			depth++;
		} else if (token.value === ')' || token.value === ']' || token.value === '}') {
			if (depth === 0) {
				return i;
			}
			depth--;
		} else if (depth === 0 && (token.value === ';' || token.value === ',')) {
			return i;
		}
	}
	return tokens.length;
}

/**
 * Whether a `{` preceded by `previous` opens a block that runs somewhere other than
 * the current scope: `spawn {...}`, a code value (`_fnc = {...}`), or code inside an
 * array, which is almost always handed to something else (`addEventHandler`,
 * `setVariable`, `CBA_fnc_waitAndExecute`, ...). The exception is `then [{...}, {...}]`.
 */
function opensDetachedBlock(previous: Token | undefined, arrays: boolean[]): boolean {
	if (!previous) {
		return false;
	}
	if (previous.type === 'ident') {
		return DETACHING_COMMANDS.has(previous.value.toLowerCase());
	}
	if (previous.type === 'symbol') {
		if (previous.value === '=') {
			return true;
		}
		if (previous.value === '[' || previous.value === ',') {
			return arrays.length > 0 && !arrays[arrays.length - 1];
		}
	}
	return false;
}

/**
 * Reads the callee of the `call` at `index`: a global function name (`call TAG_fnc_foo`)
 * or a file compiled in place (`call compile preprocessFileLineNumbers "foo.sqf"`).
 * Inline code (`call {...}`) and local or computed code (`call _fnc`) are not followed.
 */
function readCallTarget(tokens: Token[], index: number): Pick<CallSite, 'target' | 'label' | 'end'> | undefined {
	const next = tokens[index + 1];
	if (!next || next.type !== 'ident' || next.value.startsWith('_')) {
		return undefined;
	}
	if (COMPILE_COMMANDS.has(next.value.toLowerCase())) {
		const compiled = readCompiledPath(tokens, index + 1);
		if (!compiled) {
			return undefined;
		}
		return {
			target: { kind: 'file', path: compiled.path },
			label: `"${compiled.path}"`,
			end: tokens[compiled.index].end
		};
	}
	return { target: { kind: 'function', name: next.value.toLowerCase() }, label: next.value, end: next.end };
}

/**
 * Reads the file path from `compile preprocessFileLineNumbers "foo.sqf"`,
 * `compileFinal compile (preprocessFile "foo.sqf")`, `compileScript ["foo.sqf"]` and
 * the like, where `index` points at the first compile command. Returns the path and
 * the index of its string token.
 */
function readCompiledPath(tokens: Token[], index: number): { path: string; index: number } | undefined {
	let i = index + 1;
	while (tokens[i] && (isCompileOrPreprocess(tokens[i]) || isOpening(tokens[i]))) {
		i++;
	}
	const pathToken = tokens[i];
	if (!pathToken || pathToken.type !== 'string' || !/\.sqf$/i.test(pathToken.value.trim())) {
		return undefined;
	}
	return { path: pathToken.value.trim(), index: i };
}

/**
 * The global name that the compile command at `index` is stored in: whatever is
 * assigned to (`anyName = compile ...`), or the variable name given to `setVariable`
 * (`missionNamespace setVariable ["anyName", compile ...]`). Names do not have to
 * follow the `TAG_fnc_name` convention. Returns undefined for a compile command nested
 * in another one (`compileFinal compile ...`); the outer one is the definition.
 */
function definedFunctionName(tokens: Token[], index: number): string | undefined {
	let i = index - 1;
	while (tokens[i] && (isCompileOrPreprocess(tokens[i]) || isOpening(tokens[i]))) {
		if (tokens[i].type === 'ident' && COMPILE_COMMANDS.has(tokens[i].value.toLowerCase())) {
			return undefined;
		}
		i--;
	}
	const [before1, before2, before3, before4] = [0, 1, 2, 3].map(offset => tokens[i - offset]);
	if (before1?.type === 'symbol' && before1.value === '=' && before2?.type === 'ident' && !before2.value.startsWith('_')) {
		return before2.value;
	}
	if (
		before1?.type === 'symbol' &&
		before1.value === ',' &&
		before2?.type === 'string' &&
		before2.value.trim().length > 0 &&
		!before2.value.trim().startsWith('_') &&
		before3?.type === 'symbol' &&
		before3.value === '[' &&
		before4?.type === 'ident' &&
		before4.value.toLowerCase() === 'setvariable'
	) {
		return before2.value.trim();
	}
	return undefined;
}

function isCompileOrPreprocess(token: Token): boolean {
	const lower = token.value.toLowerCase();
	return token.type === 'ident' && (COMPILE_COMMANDS.has(lower) || PREPROCESS_COMMANDS.has(lower));
}

function isOpening(token: Token): boolean {
	return token.type === 'symbol' && (token.value === '(' || token.value === '[');
}

/**
 * Handles `private _x`, `private "_x"` and `private ["_x", "_y"]`.
 * Returns the index of the last token consumed.
 */
function consumePrivate(tokens: Token[], index: number, declare: (name: string) => void): number {
	const next = tokens[index + 1];
	if (!next) {
		return index;
	}
	if (next.type === 'ident' && isLocalVariableName(next.value)) {
		declare(next.value);
		return index + 1;
	}
	if (next.type === 'string' && isLocalVariableName(next.value)) {
		declare(next.value);
		return index + 1;
	}
	if (next.type === 'symbol' && next.value === '[') {
		return declareStringsInArray(tokens, index + 1, declare);
	}
	return index;
}

/**
 * Declares every local-variable string literal inside the array starting at
 * `openIndex`, including nested defaults such as `params [["_x", 0]]`.
 * Returns the index of the matching `]`, or the last token seen.
 */
function declareStringsInArray(
	tokens: Token[],
	openIndex: number,
	declare: (name: string, position: number | undefined) => void
): number {
	let depth = 0;
	// Index of the current element of the outer array.
	let element = 0;
	for (let i = openIndex; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.type === 'symbol') {
			if (token.value === '[') {
				depth++;
			} else if (token.value === ',' && depth === 1) {
				element++;
			} else if (token.value === ']') {
				depth--;
				if (depth === 0) {
					return i;
				}
			} else if (token.value === ';' || token.value === '{') {
				// Unbalanced source; bail out rather than swallowing the file.
				return i - 1;
			}
			continue;
		}
		if (token.type === 'string' && isLocalVariableName(token.value)) {
			// The name of element `element`: `"_a"` or `["_a", default]`, not a default value.
			const previous = tokens[i - 1].value;
			const named = depth === 1 || (depth === 2 && previous === '[' && (tokens[i - 2].value === '[' || tokens[i - 2].value === ','));
			declare(token.value, named ? element : undefined);
		}
	}
	return tokens.length - 1;
}

function isLocalVariableName(name: string): boolean {
	return /^_[A-Za-z0-9_]+$/.test(name);
}

/** Maps offsets to zero-based line/character pairs without loading a document. */
export function createPositionMapper(text: string): (offset: number) => { line: number; character: number } {
	const lineStarts: number[] = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') {
			lineStarts.push(i + 1);
		}
	}

	return (offset: number) => {
		let low = 0;
		let high = lineStarts.length - 1;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (lineStarts[mid] <= offset) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		return { line: low, character: offset - lineStarts[low] };
	};
}
