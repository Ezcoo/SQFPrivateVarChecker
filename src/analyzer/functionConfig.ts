import { Token, tokenize } from './tokenizer';

/** A function registered through `CfgFunctions`, and the file it is compiled from. */
export interface ConfigFunction {
	/** Lowercased full function name, e.g. `tag_fnc_myfunction`. */
	name: string;
	/** Path as the engine would resolve it, relative to the mission (or addon) root. */
	path: string;
}

interface ConfigClass {
	name: string;
	attributes: Map<string, string>;
	classes: ConfigClass[];
}

/**
 * Lists the functions declared in a `CfgFunctions` block, as found in
 * `description.ext` or a `CfgFunctions.hpp`. The latter is often `#include`d from
 * inside `class CfgFunctions { ... };` in description.ext, so when a file has no
 * `CfgFunctions` class of its own and `bareTags` is true, its top-level classes are
 * read as the tags.
 *
 * Follows the engine's naming and path rules:
 *
 *     class CfgFunctions {
 *         class TAG {                       // or tag = "OTHER"; to override
 *             class Category {              // file = "some\dir"; optional
 *                 class myFunction {};      // file = "exact\path.sqf"; optional
 *             };
 *         };
 *     };
 *
 * gives `TAG_fnc_myFunction`, compiled from `functions\Category\fn_myFunction.sqf`
 * (or `some\dir\fn_myFunction.sqf`, or `exact\path.sqf`).
 */
export function parseCfgFunctions(text: string, bareTags: boolean): ConfigFunction[] {
	const root = parseClassBody(tokenize(text), 0).body;
	const cfgFunctions = root.classes.find(child => child.name.toLowerCase() === 'cfgfunctions');
	const tags = cfgFunctions ? cfgFunctions.classes : bareTags ? root.classes : [];

	const functions: ConfigFunction[] = [];
	for (const tagClass of tags) {
		const tag = tagClass.attributes.get('tag') ?? tagClass.name;
		for (const category of tagClass.classes) {
			const categoryDir = category.attributes.get('file') ?? `functions\\${category.name}`;
			for (const fn of category.classes) {
				const ext = fn.attributes.get('ext') ?? '.sqf';
				if (ext.toLowerCase() !== '.sqf') {
					continue;
				}
				functions.push({
					name: `${tag}_fnc_${fn.name}`.toLowerCase(),
					path: fn.attributes.get('file') ?? `${categoryDir}\\fn_${fn.name}${ext}`
				});
			}
		}
	}
	return functions;
}

/**
 * Parses `class X [: Base] { ... };` declarations and `key = value;` attributes until
 * the `}` closing the current body (or the end of the file). Array attributes and
 * anything else are skipped. Returns the parsed body and the index of that `}`.
 */
function parseClassBody(tokens: Token[], index: number): { body: ConfigClass; end: number } {
	const body: ConfigClass = { name: '', attributes: new Map(), classes: [] };
	let i = index;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token.type === 'symbol' && token.value === '}') {
			return { body, end: i };
		}

		if (token.type === 'ident' && token.value.toLowerCase() === 'class' && tokens[i + 1]?.type === 'ident') {
			const name = tokens[i + 1].value;
			i += 2;
			// Inheritance, `class X: Base`.
			if (tokens[i]?.value === ':' && tokens[i + 1]?.type === 'ident') {
				i += 2;
			}
			if (tokens[i]?.value === '{') {
				const inner = parseClassBody(tokens, i + 1);
				inner.body.name = name;
				body.classes.push(inner.body);
				i = inner.end + 1;
			}
			continue;
		}

		if (token.type === 'ident' && tokens[i + 1]?.value === '=') {
			const value = tokens[i + 2];
			if (value && value.type !== 'symbol') {
				body.attributes.set(token.value.toLowerCase(), value.value);
			}
			i += 2;
			continue;
		}

		// `name[] = {...};` and the like: skip the braces without opening a class.
		if (token.type === 'symbol' && token.value === '{') {
			i = skipBraces(tokens, i);
			continue;
		}

		i++;
	}
	return { body, end: tokens.length };
}

/** Returns the index just past the `}` matching the `{` at `index`. */
function skipBraces(tokens: Token[], index: number): number {
	let depth = 0;
	for (let i = index; i < tokens.length; i++) {
		if (tokens[i].type !== 'symbol') {
			continue;
		}
		if (tokens[i].value === '{') {
			depth++;
		} else if (tokens[i].value === '}') {
			depth--;
			if (depth === 0) {
				return i + 1;
			}
		}
	}
	return tokens.length;
}
