import { Token, tokenize } from './tokenizer';

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
	/** The code block (index into `codeBlocks`) that the call is made from, if any. */
	codeBlock?: number;
}

/** A local variable assigned without `private` somewhere. */
export interface LocalWrite {
	/** The variable as written. */
	variable: string;
	start: number;
	end: number;
}

/** A `{...}` stored in a local variable, which `call _fnc` runs in the caller's scope. */
export interface CodeBlock {
	/** First assignment of each name that the block does not declare itself, so it reaches the block's caller. */
	writes: LocalWrite[];
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
	/** Code blocks stored in local variables, referenced by `CallTarget` and `CallSite.codeBlock`. */
	codeBlocks: CodeBlock[];
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
/** Commands whose `{...}` argument runs somewhere else than the current scope. */
const DETACHING_COMMANDS = new Set(['spawn', 'oneachframe', 'compilefinal']);

interface Scope {
	names: Set<string>;
	/** The block does not run in the enclosing scope (see `SqfIssue.reachesCaller`). */
	detached: boolean;
	/** Set when the block is a code block stored in a local variable (index into `codeBlocks`). */
	codeBlock?: number;
}

/** Every assignment to one local variable name in a file. */
interface LocalAssignments {
	count: number;
	/** What the last assignment stored, when it is something `call` can be followed into. */
	value?: CallTarget;
}

export function analyze(text: string, options: AnalyzerOptions = {}): SqfIssue[] {
	return analyzeFile(text, options).issues;
}

export function analyzeFile(text: string, options: AnalyzerOptions = {}): AnalyzeResult {
	const tokens = tokenize(text);
	const magic = new Set(
		[...DEFAULT_MAGIC_VARIABLES, ...(options.magicVariables ?? [])].map(name => name.toLowerCase())
	);
	const paramsDeclare = options.treatParamsAsPrivate !== false;
	const forDeclare = options.treatForLoopVariablesAsPrivate !== false;

	// SQF variable names are case insensitive, so every lookup is lowercased.
	const scopes: Scope[] = [{ names: new Set<string>(), detached: false }];
	const occurrences: NameOccurrence[] = [];
	const callSites: CallSite[] = [];
	const compiledFunctions: CompiledFunction[] = [];
	// For each open `[`, whether it is the `then [{...}, {...}]` form, whose blocks
	// run in place like ordinary `then {...} else {...}` blocks.
	const arrays: boolean[] = [];
	const codeBlocks: CodeBlock[] = [];
	// Token index of a `{` -> the code block it opens.
	const codeBlockStarts = new Map<number, number>();
	const localAssignments = new Map<string, LocalAssignments>();
	// `call _fnc` sites, resolved once every assignment to `_fnc` is known.
	const localCalls: { site: Omit<CallSite, 'target'>; name: string }[] = [];

	const markDeclared = (name: string) => scopes[scopes.length - 1].names.add(name.toLowerCase());

	// Used for `private`/`params`/`for` declarations. Only the first time a scope
	// sees a name counts as an "occurrence" of that local variable, so redundantly
	// re-declaring it is not recorded twice.
	const declare = (name: string) => {
		const lower = name.toLowerCase();
		const scope = scopes[scopes.length - 1].names;
		if (!scope.has(lower)) {
			scope.add(lower);
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
	const recordAssignment = (name: string, valueIndex: number) => {
		const lower = name.toLowerCase();
		const entry = localAssignments.get(lower) ?? { count: 0 };
		entry.count++;
		entry.value = undefined;
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
	const visibleNames = () => {
		const names = new Set<string>();
		for (let s = scopes.length - 1; s >= 0; s--) {
			scopes[s].names.forEach(name => names.add(name));
			if (scopes[s].detached) {
				break;
			}
		}
		return names;
	};

	const issues: SqfIssue[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		if (token.type === 'symbol') {
			if (token.value === '{') {
				scopes.push({
					names: new Set<string>(),
					detached: opensDetachedBlock(tokens[i - 1], arrays),
					codeBlock: codeBlockStarts.get(i)
				});
			} else if (token.value === '}' && scopes.length > 1) {
				scopes.pop();
			} else if (token.value === '[') {
				const previous = tokens[i - 1];
				arrays.push(previous !== undefined && previous.type === 'ident' && previous.value.toLowerCase() === 'then');
			} else if (token.value === ']') {
				arrays.pop();
			}
			continue;
		}

		if (token.type !== 'ident') {
			continue;
		}

		const lower = token.value.toLowerCase();

		if (lower === 'private') {
			const declared = tokens[i + 1];
			i = consumePrivate(tokens, i, declare);
			if (declared?.type === 'ident' && tokens[i] === declared && tokens[i + 1]?.value === '=') {
				recordAssignment(declared.value, i + 2);
			}
			continue;
		}

		if (paramsDeclare && lower === 'params') {
			const next = tokens[i + 1];
			if (next && next.type === 'symbol' && next.value === '[') {
				i = declareStringsInArray(tokens, i + 1, declare);
			}
			continue;
		}

		if (forDeclare && lower === 'for') {
			const next = tokens[i + 1];
			if (next && next.type === 'string' && isLocalVariableName(next.value)) {
				declare(next.value);
				i++;
			}
			continue;
		}

		if (lower === 'call') {
			const site = { start: token.start, visibleNames: visibleNames(), detached: isDetached(), codeBlock: currentCodeBlock() };
			const callee = tokens[i + 1];
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

		if (!token.value.startsWith('_') || magic.has(lower)) {
			continue;
		}

		const next = tokens[i + 1];
		const isAssignment = next !== undefined && next.type === 'symbol' && next.value === '=';
		if (isAssignment) {
			recordAssignment(token.value, i + 2);

			// Inside a code block, anything the block does not declare itself reaches
			// whoever calls it, even if the file declares that name further out.
			const frame = nearestDetached();
			const block = frame === -1 ? undefined : scopes[frame].codeBlock;
			if (block !== undefined && !scopes.slice(frame).some(scope => scope.names.has(lower))) {
				const writes = codeBlocks[block].writes;
				if (!writes.some(write => write.variable.toLowerCase() === lower)) {
					writes.push({ variable: token.value, start: token.start, end: token.end });
				}
			}
		}
		if (isAssignment && !isDeclared(token.value)) {
			issues.push({
				variable: token.value,
				start: token.start,
				end: token.end,
				message: `Local variable '${token.value}' is assigned without being declared private.`,
				kind: 'missing-private',
				reachesCaller: !isDetached()
			});
			// Record it so the same variable is reported once per scope rather
			// than on every following assignment.
			markDeclared(token.value);
			occurrences.push({ name: token.value, isPrivate: false });
		}
	}

	const privateNames = new Set<string>();
	const nonPrivateNames = new Set<string>();
	for (const occurrence of occurrences) {
		const lower = occurrence.name.toLowerCase();
		if (occurrence.isPrivate) {
			privateNames.add(lower);
		} else {
			nonPrivateNames.add(lower);
		}
	}

	// `call _fnc` is only followed when `_fnc` is assigned exactly once in the file, so
	// there is no doubt about what it holds.
	for (const { site, name } of localCalls) {
		const assignments = localAssignments.get(name);
		if (assignments?.count === 1 && assignments.value) {
			callSites.push({ ...site, target: assignments.value });
		}
	}
	callSites.sort((a, b) => a.start - b.start);

	return { issues, privateNames, nonPrivateNames, callSites, compiledFunctions, codeBlocks };
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
function declareStringsInArray(tokens: Token[], openIndex: number, declare: (name: string) => void): number {
	let depth = 0;
	for (let i = openIndex; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.type === 'symbol') {
			if (token.value === '[') {
				depth++;
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
			declare(token.value);
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
