import * as vscode from 'vscode';
import {
	analyzeFile,
	CallSite,
	CodeBlock,
	CodeFunction,
	CompiledFunction,
	createPositionMapper,
	FlowFacts,
	SqfIssue
} from './analyzer/analyzer';
import { CallSiteMark, CallSiteMarks } from './callSiteMarks';
import { expandIncludes, parseCfgFunctions } from './analyzer/functionConfig';
import { CheckerConfig, readConfig } from './config';
import { MissionRoots } from './missions';
import { AffectedCaller, findScopeLeaks, FunctionSource, LeakingCall, LeakKind, ScopeLeakResult } from './scopeLeaks';
import { WorkspaceVariableIndex } from './workspaceIndex';

export const DIAGNOSTIC_SOURCE = 'sqf-private';
export const DIAGNOSTIC_CODE = 'missing-private';
export const DIAGNOSTIC_CODE_DUPLICATE = 'duplicate-name';
export const DIAGNOSTIC_CODE_HIGH_RISK = 'high-risk';
/** A non-private assignment that overwrites a caller's local variable through `call`. */
export const DIAGNOSTIC_CODE_SCOPE_LEAK = 'scope-leak';
/** Such an assignment that looks deliberate: a way of returning a value to the caller. */
export const DIAGNOSTIC_CODE_SCOPE_LEAK_INTENTIONAL = 'scope-leak-intentional';
/** The comment that marks assignments as meant for the caller, followed by their names. */
export const SHARED_DIRECTIVE = '// sqf-private: shared';

/** Where each diagnostic code is explained: the README section of that name. */
const DOCS_URL = 'https://github.com/Ezcoo/SQFPrivateVarChecker';

/** `code` as a link to its explanation, shown in the Problems view and the hover. */
export function withDocs(code: string): { value: string; target: vscode.Uri } {
	return { value: code, target: vscode.Uri.parse(`${DOCS_URL}#${code}`) };
}

/** The code of one of our diagnostics, whether or not it is a link. */
export function diagnosticCode(diagnostic: vscode.Diagnostic): string | undefined {
	const { code } = diagnostic;
	return typeof code === 'object' ? String(code.value) : code === undefined ? undefined : String(code);
}

/*
 * Scope leak messages are a one-line headline, which is all the Problems view shows in
 * its single-line mode, followed by a line each for the details, the note and the call
 * chain. Diagnostic messages are plain text: no Markdown.
 */

/** The note on a scope leak whose overwritten value is never read afterwards. */
const UNUSED_NOTE = 'The overwritten value is not read after the call, so this changes nothing yet, but it will once someone reads it there.';
/** The note on a scope leak that assigns the value the call passes in. */
const SAME_VALUE_NOTE = 'It assigns the same value that the call passes in, so the caller\'s variable keeps its value, until the function changes it.';
/** The note on a scope leak that looks deliberate, with the variable's name. */
const intentionalNote = (variable: string) =>
	'The caller does not use its value before the call, and the function never reads back what it assigns, ' +
	`so it looks like a way of returning a value.\nTo confirm it and hide this, add to the function: ${SHARED_DIRECTIVE} ${variable}`;

/** How long to wait after the last file change before re-following call chains. */
const SCOPE_LEAK_DEBOUNCE_MS = 250;
/**
 * How often buffered diagnostics are handed to VS Code. A workspace scan re-emits files
 * many times over (every name a file adds re-emits the files sharing it, and so does
 * every pass over the call chains); sending each of those on its own floods the Problems
 * view, which then stops redrawing until it is toggled, though its counters keep up.
 */
const PUBLISH_INTERVAL_MS = 150;
/** The most diagnostics handed to VS Code in one `set` call; see `batches`. */
const MAX_DIAGNOSTICS_PER_SET = 1000;

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

export function isSqfDocument(document: vscode.TextDocument): boolean {
	return document.languageId === 'sqf' || document.uri.path.toLowerCase().endsWith('.sqf');
}

/**
 * `description.ext`, an addon's `config.cpp` and `CfgFunctions.hpp`, the files
 * `CfgFunctions` is read from (together with the files they `#include`).
 */
export function isFunctionConfigFile(uri: vscode.Uri): boolean {
	const baseName = uri.path.slice(uri.path.lastIndexOf('/') + 1).toLowerCase();
	return baseName === 'description.ext' || baseName === 'config.cpp' || baseName === 'cfgfunctions.hpp';
}

interface FileState {
	path: string;
	text: string;
	issues: SqfIssue[];
	/** Local variable names (lowercased) that have a `missing-private` issue in this file. */
	nonPrivateNames: Set<string>;
	callSites: CallSite[];
	compiledFunctions: CompiledFunction[];
	codeFunctions: CodeFunction[];
	codeBlocks: CodeBlock[];
	flow: FlowFacts;
}

const NO_LEAKS: ScopeLeakResult = { writes: new Map(), calls: new Map() };

export class SqfDiagnostics implements vscode.Disposable {
	private readonly collection: vscode.DiagnosticCollection;
	/** The calls through which scope leaks happen; drawn in the editor, but kept out of Problems. */
	private readonly callMarks = new CallSiteMarks();
	/** Which local variable names every scanned file uses, to power the cross-file check. */
	private readonly index = new WorkspaceVariableIndex();
	/** Mission folders, so that several missions in one workspace are kept apart. */
	private readonly missions = new MissionRoots();
	private readonly files = new Map<string, FileState>();
	/** Functions declared in each `description.ext` / `config.cpp` / `CfgFunctions.hpp`, by file key. */
	private readonly configFunctions = new Map<string, FunctionSource[]>();
	/** The files each of those `#include`s, by file key, so that editing one re-reads it. */
	private readonly configIncludes = new Map<string, Set<string>>();
	private leaks: ScopeLeakResult = NO_LEAKS;
	private leakTimer: NodeJS.Timeout | undefined;
	/** Diagnostics not yet handed to VS Code, by file key; an empty list removes the file's. */
	private readonly pending = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
	/**
	 * What was last handed to VS Code for each file, by file key: to skip sending it again
	 * unchanged, and to tell when its most severe diagnostic changes.
	 */
	private readonly published = new Map<string, { signature: string; top: vscode.DiagnosticSeverity }>();
	private publishTimer: NodeJS.Timeout | undefined;
	/** How many `hold`s are in effect; nothing is published while there are any. */
	private holds = 0;

	constructor() {
		this.collection = vscode.languages.createDiagnosticCollection('sqf-private-variables');
	}

	dispose(): void {
		clearTimeout(this.leakTimer);
		clearTimeout(this.publishTimer);
		this.collection.dispose();
		this.callMarks.dispose();
	}

	clear(): void {
		clearTimeout(this.leakTimer);
		clearTimeout(this.publishTimer);
		this.publishTimer = undefined;
		this.pending.clear();
		this.published.clear();
		this.collection.clear();
		this.callMarks.clear();
		this.files.clear();
		this.configFunctions.clear();
		this.configIncludes.clear();
		this.index.clear();
		this.missions.clear();
		this.leaks = NO_LEAKS;
	}

	/** How many of this extension's diagnostics are currently shown for `uri`. */
	shownCount(uri: vscode.Uri): number {
		return this.pending.get(uri.toString())?.diagnostics.length ?? this.collection.get(uri)?.length ?? 0;
	}

	/**
	 * Keeps diagnostics back until the matching `release`, for a workspace scan: files
	 * change severity many times while the rest of the workspace is read in, and the
	 * Problems view only sorts files by severity as they are added to it, so they are
	 * all added at once with their final severities.
	 */
	hold(): void {
		this.holds++;
		clearTimeout(this.publishTimer);
		this.publishTimer = undefined;
	}

	release(): void {
		this.holds = Math.max(0, this.holds - 1);
		if (this.holds === 0) {
			this.publish();
		}
	}

	/** Buffers `diagnostics` as the ones to show for `uri`, sent on the next `publish`. */
	private show(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void {
		this.pending.set(uri.toString(), { uri, diagnostics });
		this.schedulePublish();
	}

	private schedulePublish(): void {
		if (this.holds === 0) {
			this.publishTimer ??= setTimeout(() => this.publish(), PUBLISH_INTERVAL_MS);
		}
	}

	/**
	 * Hands every buffered change to VS Code at once, leaving out files whose diagnostics
	 * did not change. A file whose most severe diagnostic changed is removed first and
	 * added back on the next publish: the Problems view sorts files by their most severe
	 * diagnostic, but only as they are added, not when the ones it already lists change.
	 */
	private publish(): void {
		clearTimeout(this.publishTimer);
		this.publishTimer = undefined;

		const changed: [vscode.Uri, vscode.Diagnostic[]][] = [];
		const readd = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
		for (const [key, entry] of this.pending) {
			const { uri, diagnostics } = entry;
			const signature = diagnostics.map(diagnosticSignature).join('\n');
			const before = this.published.get(key);
			if (before?.signature === signature || (!before && diagnostics.length === 0)) {
				continue;
			}
			if (diagnostics.length === 0) {
				this.published.delete(key);
				this.collection.delete(uri);
				continue;
			}
			// Error=0 ... Hint=3, so the most severe is the smallest.
			const top = Math.min(...diagnostics.map(d => d.severity)) as vscode.DiagnosticSeverity;
			if (before && before.top !== top) {
				this.published.delete(key);
				this.collection.delete(uri);
				readd.set(key, entry);
				continue;
			}
			this.published.set(key, { signature, top });
			changed.push([uri, diagnostics]);
		}
		this.pending.clear();
		for (const batch of batches(changed)) {
			this.collection.set(batch);
		}
		if (readd.size > 0) {
			readd.forEach((entry, key) => this.pending.set(key, entry));
			this.schedulePublish();
		}
	}

	/** The scope leak calls currently marked in `uri`. */
	callSiteMarks(uri: vscode.Uri): readonly CallSiteMark[] {
		return this.callMarks.get(uri);
	}

	/**
	 * Re-reads the functions declared in a `description.ext`, `config.cpp` or
	 * `CfgFunctions.hpp` on disk, and in the files it `#include`s.
	 */
	async refreshFunctionConfig(uri: vscode.Uri): Promise<void> {
		const read = async (path: string) => {
			try {
				return decode(await vscode.workspace.fs.readFile(uri.with({ path })));
			} catch {
				return undefined;
			}
		};
		const { text, included } = await expandIncludes(decode(await vscode.workspace.fs.readFile(uri)), uri.path, read);
		const bareTags = uri.path.toLowerCase().endsWith('.hpp');
		const functions = parseCfgFunctions(text, bareTags).map(fn => ({ ...fn, definedIn: uri.path }));
		this.configFunctions.set(uri.toString(), functions);
		this.configIncludes.set(uri.toString(), new Set(included.map(path => uri.with({ path }).toString())));
		this.scheduleScopeLeaks();
	}

	/** The function configs that `#include` the file at `uri`, and so must be re-read when it changes. */
	functionConfigsIncluding(uri: vscode.Uri): vscode.Uri[] {
		const key = uri.toString();
		return [...this.configIncludes]
			.filter(([, included]) => included.has(key))
			.map(([config]) => vscode.Uri.parse(config));
	}

	/**
	 * Records whether a `description.ext` or `mission.sqm` exists at `uri`, which makes
	 * its folder a mission. When that changes which files belong together, every file
	 * is re-emitted and call chains are followed again.
	 */
	setMissionMarker(uri: vscode.Uri, exists: boolean): void {
		if (!MissionRoots.isMarker(uri.path)) {
			return;
		}
		const changed = exists ? this.missions.add(uri.path) : this.missions.remove(uri.path);
		if (changed) {
			for (const key of this.files.keys()) {
				const fileUri = vscode.Uri.parse(key);
				this.emit(fileUri, readConfig(fileUri));
			}
			this.scheduleScopeLeaks();
		}
	}

	deleteFunctionConfig(uri: vscode.Uri): void {
		this.configIncludes.delete(uri.toString());
		if (this.configFunctions.delete(uri.toString())) {
			this.scheduleScopeLeaks();
		}
	}

	/**
	 * Follows every `call` chain again, right now rather than after the usual debounce,
	 * and re-emits the diagnostics of every file whose scope leaks changed.
	 */
	flushScopeLeaks(): void {
		clearTimeout(this.leakTimer);
		this.leakTimer = undefined;

		const functions: FunctionSource[] = [];
		for (const list of this.configFunctions.values()) {
			functions.push(...list);
		}
		for (const state of this.files.values()) {
			functions.push(...state.compiledFunctions.map(fn => ({ ...fn, definedIn: state.path })));
		}

		const previous = this.leaks;
		this.leaks = findScopeLeaks(this.files, functions, (a, b) => this.missions.related(a, b));

		for (const key of this.files.keys()) {
			if (leakSignature(previous, key) !== leakSignature(this.leaks, key)) {
				const uri = vscode.Uri.parse(key);
				this.emit(uri, readConfig(uri));
			}
		}
	}

	private scheduleScopeLeaks(): void {
		clearTimeout(this.leakTimer);
		this.leakTimer = setTimeout(() => this.flushScopeLeaks(), SCOPE_LEAK_DEBOUNCE_MS);
	}

	delete(uri: vscode.Uri): void {
		this.forget(uri);
	}

	/** Re-checks an open document. Returns the number of issues found. */
	refreshDocument(document: vscode.TextDocument): number {
		if (!isSqfDocument(document)) {
			return 0;
		}

		const config = readConfig(document.uri);
		if (!config.enable) {
			this.forget(document.uri);
			return 0;
		}

		return this.check(document.uri, document.getText(), config);
	}

	/** Checks a file on disk without opening it as a document. */
	async refreshFile(uri: vscode.Uri, config: CheckerConfig): Promise<number> {
		if (!config.enable) {
			this.forget(uri);
			return 0;
		}

		const openDocument = vscode.workspace.textDocuments.find(
			document => document.uri.toString() === uri.toString()
		);
		// Prefer unsaved editor content over what is on disk.
		const text = openDocument
			? openDocument.getText()
			: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));

		return this.check(uri, text, config);
	}

	private check(uri: vscode.Uri, text: string, config: CheckerConfig): number {
		const key = uri.toString();
		const result = analyzeFile(text, config);
		this.files.set(key, {
			path: uri.path,
			text,
			issues: result.issues,
			nonPrivateNames: result.nonPrivateNames,
			callSites: result.callSites,
			compiledFunctions: result.compiledFunctions,
			codeFunctions: result.codeFunctions,
			codeBlocks: result.codeBlocks,
			flow: result.flow
		});

		// Files with the cross-file check turned off do not contribute their names to
		// the index, so other files cannot collide with them either.
		const allNames = config.flagDuplicateLocalNames
			? new Set<string>([...result.privateNames, ...result.nonPrivateNames])
			: new Set<string>();
		const nonPrivateNames = config.flagDuplicateLocalNames ? result.nonPrivateNames : new Set<string>();
		const changedNames = this.index.update(key, allNames, nonPrivateNames);

		const shown = this.emit(uri, config);

		if (config.flagDuplicateLocalNames) {
			// A name this file just introduced (or dropped) may change whether some
			// other, already-checked file counts as a duplicate.
			this.recheckAffected(changedNames, key);
		}

		// Call chains run through many files, so they are followed again once edits settle.
		this.scheduleScopeLeaks();

		return shown;
	}

	private forget(uri: vscode.Uri): void {
		const key = uri.toString();
		this.show(uri, []);
		this.callMarks.delete(uri);
		this.files.delete(key);
		const changedNames = this.index.remove(key);
		this.recheckAffected(changedNames, key);
		this.scheduleScopeLeaks();
	}

	/**
	 * Rebuilds diagnostics and scope leak call marks for `uri` from its cached analysis,
	 * against the current index and the current `minimumSeverity` filter. Returns how
	 * many diagnostics are shown.
	 */
	private emit(uri: vscode.Uri, config: CheckerConfig): number {
		const key = uri.toString();
		const state = this.files.get(key);
		const leakingCalls = config.detectScopeLeaks ? (this.leaks.calls.get(key) ?? []) : [];
		if (!state || (state.issues.length === 0 && leakingCalls.length === 0)) {
			this.show(uri, []);
			this.callMarks.delete(uri);
			return 0;
		}

		const leakingWrites = config.detectScopeLeaks ? this.leaks.writes.get(key) : undefined;
		const positionAt = createPositionMapper(state.text);
		const locate = this.locator();
		// A severity numerically greater than minimumSeverity is less severe (Error=0 ... Hint=3).
		const shown = (item: { severity: vscode.DiagnosticSeverity }) => item.severity <= config.minimumSeverity;
		const diagnostics = state.issues
			.map(issue => {
				const range = toRange(positionAt, issue);
				const lower = issue.variable.toLowerCase();
				const affected = leakingWrites?.get(issue.start);
				// Offsets from the last pass may be stale while typing, so check the name too.
				if (affected && affected[0].name === lower) {
					return scopeLeakDiagnostic(issue, range, config, affected, locate);
				}
				// Only files that can ever run together with this one (the same mission,
				// or code shared by all of them) can collide with it.
				const related = (other: string) =>
					this.missions.related(state.path, this.files.get(other)?.path ?? vscode.Uri.parse(other).path);
				const otherFiles = config.flagDuplicateLocalNames ? this.index.otherFiles(lower, key).filter(related) : [];
				const otherNonPrivateFiles = config.flagDuplicateLocalNames
					? this.index.otherNonPrivateFiles(lower, key).filter(related)
					: [];
				return toDiagnostic(issue, range, config, otherFiles, otherNonPrivateFiles);
			})
			.filter(shown);
		this.show(uri, diagnostics);
		this.callMarks.set(uri, leakingCalls.map(call => leakingCallMark(call, positionAt, config, locate)).filter(shown));
		return diagnostics.length;
	}

	/** Turns an offset in any checked file into a location, for related information. */
	private locator(): Locate {
		const mappers = new Map<string, (offset: number) => { line: number; character: number }>();
		return (fileKey, start, end) => {
			const state = this.files.get(fileKey);
			if (!state) {
				return undefined;
			}
			let positionAt = mappers.get(fileKey);
			if (!positionAt) {
				positionAt = createPositionMapper(state.text);
				mappers.set(fileKey, positionAt);
			}
			return new vscode.Location(vscode.Uri.parse(fileKey), toRange(positionAt, { start, end }));
		};
	}

	/** Re-emits diagnostics (no re-parsing) for every already-checked file that uses one of `changedNames`. */
	private recheckAffected(changedNames: Set<string>, excludeKey: string): void {
		if (changedNames.size === 0) {
			return;
		}
		for (const [key, state] of this.files) {
			if (key === excludeKey) {
				continue;
			}
			const affected = [...state.nonPrivateNames].some(name => changedNames.has(name));
			if (affected) {
				const uri = vscode.Uri.parse(key);
				this.emit(uri, readConfig(uri));
			}
		}
	}
}

type Locate = (fileKey: string, start: number, end: number) => vscode.Location | undefined;

function toRange(
	positionAt: (offset: number) => { line: number; character: number },
	span: { start: number; end: number }
): vscode.Range {
	const start = positionAt(span.start);
	const end = positionAt(span.end);
	return new vscode.Range(start.line, start.character, end.line, end.character);
}

/**
 * `entries` split so that no batch holds more than `MAX_DIAGNOSTICS_PER_SET` diagnostics,
 * except a single file with more on its own. One `set` call only passes on about 1100
 * diagnostics to the Problems view (VS Code 1.139), silently dropping the files after
 * those, however many it keeps for `languages.getDiagnostics`.
 */
function batches(entries: [vscode.Uri, vscode.Diagnostic[]][]): [vscode.Uri, vscode.Diagnostic[]][][] {
	const result: [vscode.Uri, vscode.Diagnostic[]][][] = [];
	let batch: [vscode.Uri, vscode.Diagnostic[]][] = [];
	let count = 0;
	for (const entry of entries) {
		const size = entry[1].length;
		if (batch.length > 0 && count + size > MAX_DIAGNOSTICS_PER_SET) {
			result.push(batch);
			batch = [];
			count = 0;
		}
		batch.push(entry);
		count += size;
	}
	if (batch.length > 0) {
		result.push(batch);
	}
	return result;
}

/** Everything about a diagnostic that the Problems view or the editor shows, to tell whether it changed. */
function diagnosticSignature(diagnostic: vscode.Diagnostic): string {
	const { start, end } = diagnostic.range;
	const related = (diagnostic.relatedInformation ?? []).map(info => {
		const { uri, range } = info.location;
		return `${uri.toString()}:${range.start.line}.${range.start.character}-${range.end.line}.${range.end.character}:${info.message}`;
	});
	return JSON.stringify([
		start.line,
		start.character,
		end.line,
		end.character,
		diagnostic.severity,
		diagnosticCode(diagnostic),
		diagnostic.message,
		related
	]);
}

/** A compact description of a file's scope leaks, to tell whether it needs re-emitting. */
function leakSignature(leaks: ScopeLeakResult, fileKey: string): string {
	const writes = [...(leaks.writes.get(fileKey) ?? [])].map(
		([start, affected]) =>
			`${start}:${affected.map(a => `${a.callerKey}@${a.callSite.start}/${a.chain.join('>')}/${a.live}/${a.kind}`).join(',')}`
	);
	const calls = (leaks.calls.get(fileKey) ?? []).map(
		call =>
			`${call.callSite.start}-${call.callSite.end}:` +
			[...call.names]
				.map(([name, origins]) => `${name}=${origins.map(o => `${o.fileKey}@${o.start}/${o.state}/${o.kind}`).join(',')}`)
				.join(';')
	);
	return `${writes.join('|')}#${calls.join('|')}`;
}

/** How one leak into one call is reported: with what severity, and which note explains it. */
interface LeakTreatment {
	severity: vscode.DiagnosticSeverity;
	/** Whether it may break something today: the value is read afterwards, and nothing suggests it is harmless or deliberate. */
	harmful: boolean;
	/** Starts the headline, e.g. `SCOPE LEAK (same value)`. */
	label: string;
	/** A line of its own explaining why it is less serious, or nothing. */
	note: (variable: string) => string | undefined;
}

function treatment(config: CheckerConfig, live: boolean, kind: LeakKind | undefined): LeakTreatment {
	if (kind === 'intentional') {
		return {
			severity: config.intentionalScopeLeakSeverity,
			harmful: false,
			label: 'SCOPE LEAK (looks intentional)',
			note: intentionalNote
		};
	}
	if (kind === 'same-value') {
		return {
			severity: config.unusedScopeLeakSeverity,
			harmful: false,
			label: 'SCOPE LEAK (same value)',
			note: () => SAME_VALUE_NOTE
		};
	}
	return live
		? { severity: config.scopeLeakSeverity, harmful: true, label: 'SCOPE LEAK', note: () => undefined }
		: { severity: config.unusedScopeLeakSeverity, harmful: false, label: 'SCOPE LEAK (not read yet)', note: () => UNUSED_NOTE };
}

/** The lines of a message, leaving out missing ones. */
function lines(...parts: (string | undefined)[]): string {
	return parts.filter(part => part !== undefined).join('\n');
}

/** The item with the most severe treatment, harmful ones first among equals, which the message then describes (Error=0 ... Hint=3). */
function mostSevere<T extends { treatment: LeakTreatment }>(items: T[]): T {
	return items.reduce((worst, item) => {
		const a = item.treatment;
		const b = worst.treatment;
		return a.severity < b.severity || (a.severity === b.severity && a.harmful && !b.harmful) ? item : worst;
	});
}

/**
 * Ends the related information for a single caller's or assignment's leak: why it is
 * less serious, and whether the overwritten variable is read afterwards.
 */
function relatedNote(live: boolean, kind: LeakKind | undefined): string {
	const read = live ? ' and the variable is read afterwards!' : '';
	if (kind === 'intentional') {
		return `; looks intentional${read}`;
	}
	if (kind === 'same-value') {
		return `; assigns the value passed in${read}`;
	}
	return read;
}

function scopeLeakDiagnostic(
	issue: SqfIssue,
	range: vscode.Range,
	config: CheckerConfig,
	affected: AffectedCaller[],
	locate: Locate
): vscode.Diagnostic {
	const [first] = affected;
	const callerPath = vscode.workspace.asRelativePath(vscode.Uri.parse(first.callerKey));
	const others = new Set(affected.map(a => `${a.callerKey}@${a.callSite.start}`)).size - 1;
	const extra = others > 0 ? ` (and ${others} other call${others === 1 ? '' : 's'})` : '';
	const worst = mostSevere(affected.map(a => ({ affected: a, treatment: treatment(config, a.live, a.kind) })));
	const { label, harmful, note } = worst.treatment;
	const message = lines(
		`${label}: '${issue.variable}' overwrites the caller's variable of the same name`,
		`Assigned without private, and run via call from ${callerPath}${extra}` +
			(harmful ? `, which reads '${issue.variable}' afterwards.` : '.'),
		note(issue.variable),
		`Call chain: ${formatChain(first.chain)}`
	);

	const diagnostic = new vscode.Diagnostic(range, message, worst.treatment.severity);
	diagnostic.source = DIAGNOSTIC_SOURCE;
	diagnostic.code = withDocs(
		worst.affected.kind === 'intentional' ? DIAGNOSTIC_CODE_SCOPE_LEAK_INTENTIONAL : DIAGNOSTIC_CODE_SCOPE_LEAK
	);
	diagnostic.relatedInformation = affected
		.map(a => {
			const location = locate(a.callerKey, a.callSite.start, a.callSite.end);
			return location && new vscode.DiagnosticRelatedInformation(
				location,
				`'${issue.variable}' is a local variable here (call chain: ${formatChain(a.chain)})${relatedNote(a.live, a.kind)}`
			);
		})
		.filter((info): info is vscode.DiagnosticRelatedInformation => info !== undefined);
	return diagnostic;
}

/**
 * The mark at a `call` through which a scope leak happens. Not a diagnostic, since the
 * assignment's diagnostic already lists this call, and not fixable by inserting
 * `private` here.
 */
function leakingCallMark(
	call: LeakingCall,
	positionAt: (offset: number) => { line: number; character: number },
	config: CheckerConfig,
	locate: Locate
): CallSiteMark {
	const origins = [...call.names.values()].flat();
	const variables = [...new Set(origins.map(origin => `'${origin.variable}'`))].join(', ');
	const firstPath = vscode.workspace.asRelativePath(vscode.Uri.parse(origins[0].fileKey));
	const worst = mostSevere(
		origins.map(origin => ({ origin, treatment: treatment(config, origin.state === 'live', origin.kind) }))
	);
	const message = lines(
		`${worst.treatment.label}: call ${call.callSite.label} overwrites ${variables} of this scope`,
		`Assigned without private in ${firstPath}.`,
		worst.treatment.note(worst.origin.variable)
	);

	const related = origins
		.map(origin => {
			const location = locate(origin.fileKey, origin.start, origin.end);
			const via = origin.chain.length > 0 ? ` (via ${formatChain(origin.chain)})` : '';
			return location && {
				location,
				message: `'${origin.variable}' assigned without private${via}${relatedNote(origin.state === 'live', origin.kind)}`
			};
		})
		.filter(info => info !== undefined);
	return {
		range: toRange(positionAt, call.callSite),
		severity: worst.treatment.severity,
		message,
		related,
		code: withDocs(worst.origin.kind === 'intentional' ? DIAGNOSTIC_CODE_SCOPE_LEAK_INTENTIONAL : DIAGNOSTIC_CODE_SCOPE_LEAK)
	};
}

function formatChain(chain: string[]): string {
	return chain.join(' \u2192 ');
}

function toDiagnostic(
	issue: SqfIssue,
	range: vscode.Range,
	config: CheckerConfig,
	otherFiles: string[],
	otherNonPrivateFiles: string[]
): vscode.Diagnostic {
	// otherNonPrivateFiles is a subset of otherFiles, so check it first: two or more
	// files all missing private is strictly worse than one missing private while the
	// other is safely declared, and only one diagnostic should be shown per issue.
	const isHighRisk = otherNonPrivateFiles.length > 0;
	const isDuplicate = !isHighRisk && otherFiles.length > 0;

	let severity: vscode.DiagnosticSeverity;
	let message: string;
	let code: string;
	if (isHighRisk) {
		severity = config.highRiskSeverity;
		message = highRiskMessage(issue.variable, otherNonPrivateFiles);
		code = DIAGNOSTIC_CODE_HIGH_RISK;
	} else if (isDuplicate) {
		severity = config.duplicateNameSeverity;
		message = duplicateNameMessage(issue.variable, otherFiles);
		code = DIAGNOSTIC_CODE_DUPLICATE;
	} else {
		severity = config.severity;
		message = issue.message;
		code = DIAGNOSTIC_CODE;
	}

	const diagnostic = new vscode.Diagnostic(range, message, severity);
	diagnostic.source = DIAGNOSTIC_SOURCE;
	diagnostic.code = withDocs(code);
	return diagnostic;
}

function duplicateNameMessage(variable: string, otherFileKeys: string[]): string {
	const [firstKey, ...rest] = otherFileKeys;
	const firstPath = vscode.workspace.asRelativePath(vscode.Uri.parse(firstKey));
	const extra = rest.length > 0 ? ` and ${rest.length} other file${rest.length === 1 ? '' : 's'}` : '';
	return (
		`Local variable '${variable}' is assigned without being declared private, and the same name is also used ` +
		`as a local variable in ${firstPath}${extra}.`
	);
}

function highRiskMessage(variable: string, otherFileKeys: string[]): string {
	const [firstKey, ...rest] = otherFileKeys;
	const firstPath = vscode.workspace.asRelativePath(vscode.Uri.parse(firstKey));
	const extra = rest.length > 0 ? ` and ${rest.length} other file${rest.length === 1 ? '' : 's'}` : '';
	const siteCount = otherFileKeys.length + 1;
	return (
		`HIGH RISK: local variable '${variable}' is assigned without being declared private in at least ` +
		`${siteCount} different places in the workspace, including this one and ${firstPath}${extra}.`
	);
}
