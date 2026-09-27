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

/** `#include "file"` or `#include <file>` on a line of its own. */
const INCLUDE_DIRECTIVE = /^[ \t]*#[ \t]*include[ \t]*["<]([^">\r\n]+)[">][^\r\n]*$/gm;
/** How deep `#include`s are followed, against runaway nesting. */
const MAX_INCLUDE_DEPTH = 16;

/**
 * Replaces each `#include` in `text` (the file at `path`, a `/`-separated path) with
 * the contents of the file it names, recursively, the way the preprocessor does, so
 * that a `CfgFunctions` block spread over several files can be parsed as one. Paths
 * are relative to the including file; one that starts with `\` (an addon path, such
 * as `\x\cba\addons\main\script_macros.hpp`) is left out, as is anything `read` cannot
 * find (it returns undefined) and a file that includes itself.
 *
 * Returns the expanded text and the path of every file it tried to include (found or
 * not, so that creating a missing one can be noticed too).
 */
export async function expandIncludes(
	text: string,
	path: string,
	read: (path: string) => Promise<string | undefined>
): Promise<{ text: string; included: string[] }> {
	const included = new Set<string>();
	const expand = async (source: string, from: string, stack: string[]): Promise<string> => {
		const parts: string[] = [];
		let last = 0;
		for (const match of source.matchAll(INCLUDE_DIRECTIVE)) {
			parts.push(source.slice(last, match.index));
			last = match.index + match[0].length;
			const target = resolveInclude(from, match[1]);
			if (target === undefined || stack.includes(target) || stack.length >= MAX_INCLUDE_DEPTH) {
				continue;
			}
			included.add(target);
			const content = await read(target);
			if (content !== undefined) {
				parts.push(await expand(content, target, [...stack, target]));
			}
		}
		parts.push(source.slice(last));
		return parts.join('');
	};
	return { text: await expand(text, path, [path]), included: [...included] };
}

/** The path that `#include "name"` in the file at `from` refers to, or undefined for an addon path. */
function resolveInclude(from: string, name: string): string | undefined {
	const normalized = name.trim().replace(/\\/g, '/');
	if (normalized.startsWith('/')) {
		return undefined;
	}
	const segments = from.split('/').slice(0, -1);
	for (const segment of normalized.split('/')) {
		if (segment === '..') {
			segments.pop();
		} else if (segment !== '.' && segment !== '') {
			segments.push(segment);
		}
	}
	return segments.join('/');
}

/**
 * Lists the functions declared in a `CfgFunctions` block, as found in
 * `description.ext`, an addon's `config.cpp` or a `CfgFunctions.hpp`. The latter is often `#include`d from
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
