/**
 * A small, dependency-free tokenizer for SQF.
 *
 * It is deliberately forgiving: the goal is not to build a parse tree but to
 * hand the analyzer a stream of tokens in which comments, strings and
 * preprocessor directives can no longer be mistaken for code.
 */

export type TokenType = 'ident' | 'string' | 'number' | 'symbol';

export interface Token {
	type: TokenType;
	/** Raw source text, except for strings where it is the decoded content. */
	value: string;
	/** Offset of the first character of the token. */
	start: number;
	/** Offset just past the last character of the token. */
	end: number;
}

/** Operators that must not be split, so that `==` is never read as `=`. */
const MULTI_CHAR_OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '>>'];

export function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	const len = text.length;
	let i = 0;

	while (i < len) {
		const ch = text[i];

		if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
			i++;
			continue;
		}

		if (ch === '/' && text[i + 1] === '/') {
			while (i < len && text[i] !== '\n') {
				i++;
			}
			continue;
		}

		if (ch === '/' && text[i + 1] === '*') {
			i += 2;
			while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
				i++;
			}
			i = Math.min(i + 2, len);
			continue;
		}

		// Preprocessor directives are skipped whole: macro bodies routinely
		// mention `_vars` that the engine declares for us.
		if (ch === '#' && isAtLineStart(text, i)) {
			i = skipPreprocessorLine(text, i);
			continue;
		}

		if (ch === '"' || ch === '\'') {
			const start = i;
			const quote = ch;
			let value = '';
			i++;
			while (i < len) {
				if (text[i] === quote) {
					// SQF escapes a quote by doubling it.
					if (text[i + 1] === quote) {
						value += quote;
						i += 2;
						continue;
					}
					i++;
					break;
				}
				value += text[i];
				i++;
			}
			tokens.push({ type: 'string', value, start, end: i });
			continue;
		}

		if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1]))) {
			const start = i;
			if (ch === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
				i += 2;
				while (i < len && isHexDigit(text[i])) {
					i++;
				}
			} else {
				while (i < len && (isDigit(text[i]) || text[i] === '.')) {
					i++;
				}
				if (i < len && (text[i] === 'e' || text[i] === 'E')) {
					const beforeExponent = i;
					i++;
					if (text[i] === '+' || text[i] === '-') {
						i++;
					}
					if (isDigit(text[i])) {
						while (i < len && isDigit(text[i])) {
							i++;
						}
					} else {
						i = beforeExponent;
					}
				}
			}
			tokens.push({ type: 'number', value: text.slice(start, i), start, end: i });
			continue;
		}

		if (isIdentStart(ch)) {
			const start = i;
			while (i < len && isIdentPart(text[i])) {
				i++;
			}
			tokens.push({ type: 'ident', value: text.slice(start, i), start, end: i });
			continue;
		}

		const twoChar = text.substr(i, 2);
		if (MULTI_CHAR_OPERATORS.includes(twoChar)) {
			tokens.push({ type: 'symbol', value: twoChar, start: i, end: i + 2 });
			i += 2;
			continue;
		}

		tokens.push({ type: 'symbol', value: ch, start: i, end: i + 1 });
		i++;
	}

	return tokens;
}

function isDigit(ch: string | undefined): boolean {
	return ch !== undefined && ch >= '0' && ch <= '9';
}

function isHexDigit(ch: string): boolean {
	return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isIdentStart(ch: string): boolean {
	return ch === '_' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isIdentPart(ch: string): boolean {
	return isIdentStart(ch) || isDigit(ch);
}

function isAtLineStart(text: string, i: number): boolean {
	for (let j = i - 1; j >= 0; j--) {
		const ch = text[j];
		if (ch === '\n') {
			return true;
		}
		if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
			return false;
		}
	}
	return true;
}

/** Returns the offset just past the directive, honouring `\` line continuations. */
function skipPreprocessorLine(text: string, i: number): number {
	const len = text.length;
	while (i < len) {
		const ch = text[i];
		if (ch === '\\') {
			let j = i + 1;
			while (j < len && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')) {
				j++;
			}
			if (text[j] === '\n') {
				i = j + 1;
				continue;
			}
			i++;
			continue;
		}
		if (ch === '\n') {
			return i + 1;
		}
		i++;
	}
	return len;
}
