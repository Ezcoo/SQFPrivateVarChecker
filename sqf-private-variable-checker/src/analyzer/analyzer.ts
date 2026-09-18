import { Token, tokenize } from './tokenizer';

export interface SqfIssue {
	/** The variable name exactly as written in the source. */
	variable: string;
	/** Offset of the first character of the variable. */
	start: number;
	/** Offset just past the last character of the variable. */
	end: number;
	message: string;
}

export interface AnalyzerOptions {
	/** Extra engine/macro supplied variables that must never be reported. */
	magicVariables?: string[];
	/** Treat `params ["_x"]` as a private declaration. Defaults to true. */
	treatParamsAsPrivate?: boolean;
	/** Treat `for "_i" from ...` as a private declaration. Defaults to true. */
	treatForLoopVariablesAsPrivate?: boolean;
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

export function analyze(text: string, options: AnalyzerOptions = {}): SqfIssue[] {
	const tokens = tokenize(text);
	const magic = new Set(
		[...DEFAULT_MAGIC_VARIABLES, ...(options.magicVariables ?? [])].map(name => name.toLowerCase())
	);
	const paramsDeclare = options.treatParamsAsPrivate !== false;
	const forDeclare = options.treatForLoopVariablesAsPrivate !== false;

	// SQF variable names are case insensitive, so every lookup is lowercased.
	const scopes: Set<string>[] = [new Set<string>()];
	const declare = (name: string) => scopes[scopes.length - 1].add(name.toLowerCase());
	const isDeclared = (name: string) => {
		const lower = name.toLowerCase();
		return scopes.some(scope => scope.has(lower));
	};

	const issues: SqfIssue[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		if (token.type === 'symbol') {
			if (token.value === '{') {
				scopes.push(new Set<string>());
			} else if (token.value === '}' && scopes.length > 1) {
				scopes.pop();
			}
			continue;
		}

		if (token.type !== 'ident') {
			continue;
		}

		const lower = token.value.toLowerCase();

		if (lower === 'private') {
			i = consumePrivate(tokens, i, declare);
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

		if (!token.value.startsWith('_') || magic.has(lower)) {
			continue;
		}

		const next = tokens[i + 1];
		const isAssignment = next !== undefined && next.type === 'symbol' && next.value === '=';
		if (isAssignment && !isDeclared(token.value)) {
			issues.push({
				variable: token.value,
				start: token.start,
				end: token.end,
				message: `Local variable '${token.value}' is assigned without being declared private.`
			});
			// Record it so the same variable is reported once per scope rather
			// than on every following assignment.
			declare(token.value);
		}
	}

	return issues;
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
