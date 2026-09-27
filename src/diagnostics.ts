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
import { parseCfgFunctions } from './analyzer/functionConfig';
import { CheckerConfig, readConfig } from './config';
import { MissionRoots } from './missions';
import { AffectedCaller, findScopeLeaks, FunctionSource, LeakingCall, ScopeLeakResult } from './scopeLeaks';
import { WorkspaceVariableIndex } from './workspaceIndex';

export const DIAGNOSTIC_SOURCE = 'sqf-private';
export const DIAGNOSTIC_CODE = 'missing-private';
export const DIAGNOSTIC_CODE_DUPLICATE = 'duplicate-name';
export const DIAGNOSTIC_CODE_HIGH_RISK = 'high-risk';
/** A non-private assignment that overwrites a caller's local variable through `call`. */
export const DIAGNOSTIC_CODE_SCOPE_LEAK = 'scope-leak';
/** The `call` through which that happens. Not fixable by inserting `private` there. */
export const DIAGNOSTIC_CODE_SCOPE_LEAK_CALL = 'scope-leak-call';

/** Appended to a scope leak whose overwritten value is never read afterwards. */
const UNUSED_NOTE = ' The overwritten value is not read after the call, so this changes nothing yet, but it might become an issue in the future.';

/** How long to wait after the last file change before re-following call chains. */
const SCOPE_LEAK_DEBOUNCE_MS = 250;

export function isSqfDocument(document: vscode.TextDocument): boolean {
	return document.languageId === 'sqf' || document.uri.path.toLowerCase().endsWith('.sqf');
}

/** `description.ext` and `CfgFunctions.hpp`, the files `CfgFunctions` is read from. */
export function isFunctionConfigFile(uri: vscode.Uri): boolean {
	const baseName = uri.path.slice(uri.path.lastIndexOf('/') + 1).toLowerCase();
	return baseName === 'description.ext' || baseName === 'cfgfunctions.hpp';
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
	/** Which local variable names every scanned file uses, to power the cross-file check. */
	private readonly index = new WorkspaceVariableIndex();
	/** Mission folders, so that several missions in one workspace are kept apart. */
	private readonly missions = new MissionRoots();
	private readonly files = new Map<string, FileState>();
	/** Functions declared in each `description.ext` / `CfgFunctions.hpp`, by file key. */
	private readonly configFunctions = new Map<string, FunctionSource[]>();
	private leaks: ScopeLeakResult = NO_LEAKS;
	private leakTimer: NodeJS.Timeout | undefined;

	constructor() {
		this.collection = vscode.languages.createDiagnosticCollection('sqf-private-variables');
	}

	dispose(): void {
		clearTimeout(this.leakTimer);
		this.collection.dispose();
	}

	clear(): void {
		clearTimeout(this.leakTimer);
		this.collection.clear();
		this.files.clear();
		this.configFunctions.clear();
		this.index.clear();
		this.missions.clear();
		this.leaks = NO_LEAKS;
	}

	/** How many of this extension's diagnostics are currently shown for `uri`. */
	shownCount(uri: vscode.Uri): number {
		return this.collection.get(uri)?.length ?? 0;
	}

	/** Re-reads the functions declared in a `description.ext` or `CfgFunctions.hpp` on disk. */
	async refreshFunctionConfig(uri: vscode.Uri): Promise<void> {
		const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
		const bareTags = !uri.path.toLowerCase().endsWith('.ext');
		const functions = parseCfgFunctions(text, bareTags).map(fn => ({ ...fn, definedIn: uri.path }));
		this.configFunctions.set(uri.toString(), functions);
		this.scheduleScopeLeaks();
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
		this.collection.delete(uri);
		this.files.delete(key);
		const changedNames = this.index.remove(key);
		this.recheckAffected(changedNames, key);
		this.scheduleScopeLeaks();
	}

	/**
	 * Rebuilds diagnostics for `uri` from its cached analysis, against the current
	 * index and the current `minimumSeverity` filter. Returns how many are shown.
	 */
	private emit(uri: vscode.Uri, config: CheckerConfig): number {
		const key = uri.toString();
		const state = this.files.get(key);
		const leakingCalls = config.detectScopeLeaks ? (this.leaks.calls.get(key) ?? []) : [];
		if (!state || (state.issues.length === 0 && leakingCalls.length === 0)) {
			this.collection.delete(uri);
			return 0;
		}

		const leakingWrites = config.detectScopeLeaks ? this.leaks.writes.get(key) : undefined;
		const positionAt = createPositionMapper(state.text);
		const locate = this.locator();
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
			.concat(leakingCalls.map(call => leakingCallDiagnostic(call, positionAt, config, locate)))
			// A severity numerically greater than minimumSeverity is less severe (Error=0 ... Hint=3).
			.filter(diagnostic => diagnostic.severity <= config.minimumSeverity);
		this.collection.set(uri, diagnostics);
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

/** A compact description of a file's scope leaks, to tell whether it needs re-emitting. */
function leakSignature(leaks: ScopeLeakResult, fileKey: string): string {
	const writes = [...(leaks.writes.get(fileKey) ?? [])].map(
		([start, affected]) =>
			`${start}:${affected.map(a => `${a.callerKey}@${a.callSite.start}/${a.chain.join('>')}/${a.live}`).join(',')}`
	);
	const calls = (leaks.calls.get(fileKey) ?? []).map(
		call =>
			`${call.callSite.start}-${call.callSite.end}:` +
			[...call.names]
				.map(([name, origins]) => `${name}=${origins.map(o => `${o.fileKey}@${o.start}/${o.state}`).join(',')}`)
				.join(';')
	);
	return `${writes.join('|')}#${calls.join('|')}`;
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
	const live = affected.some(a => a.live);
	const message =
		`SCOPE LEAK: local variable '${issue.variable}' is assigned without being declared private, and overwrites ` +
		`the caller's '${issue.variable}' when run via call from ${callerPath}${extra}, and the modified variable gets read after that. Call chain: ${formatChain(first.chain)}.` +
		(live ? '' : UNUSED_NOTE);

	const diagnostic = new vscode.Diagnostic(
		range,
		message,
		live ? config.scopeLeakSeverity : config.unusedScopeLeakSeverity
	);
	diagnostic.source = DIAGNOSTIC_SOURCE;
	diagnostic.code = DIAGNOSTIC_CODE_SCOPE_LEAK;
	diagnostic.relatedInformation = affected
		.map(a => {
			const location = locate(a.callerKey, a.callSite.start, a.callSite.end);
			return location && new vscode.DiagnosticRelatedInformation(
				location,
				`'${issue.variable}' is a local variable here${a.live ? '' : ', not read after the call'}; ` +
					`call chain: ${formatChain(a.chain)}`
			);
		})
		.filter((info): info is vscode.DiagnosticRelatedInformation => info !== undefined);
	return diagnostic;
}

function leakingCallDiagnostic(
	call: LeakingCall,
	positionAt: (offset: number) => { line: number; character: number },
	config: CheckerConfig,
	locate: Locate
): vscode.Diagnostic {
	const origins = [...call.names.values()].flat();
	const variables = [...new Set(origins.map(origin => `'${origin.variable}'`))].join(', ');
	const plural = call.names.size === 1 ? 'variable' : 'variables';
	const firstPath = vscode.workspace.asRelativePath(vscode.Uri.parse(origins[0].fileKey));
	const live = origins.some(origin => origin.state === 'live');
	const message =
		`SCOPE LEAK: call ${call.callSite.label} overwrites local ${plural} ${variables} of this scope, ` +
		`assigned without private in ${firstPath}.` +
		(live ? '' : UNUSED_NOTE);

	const diagnostic = new vscode.Diagnostic(
		toRange(positionAt, call.callSite),
		message,
		live ? config.scopeLeakSeverity : config.unusedScopeLeakSeverity
	);
	diagnostic.source = DIAGNOSTIC_SOURCE;
	diagnostic.code = DIAGNOSTIC_CODE_SCOPE_LEAK_CALL;
	diagnostic.relatedInformation = origins
		.map(origin => {
			const location = locate(origin.fileKey, origin.start, origin.end);
			const via = origin.chain.length > 0 ? ` (via ${formatChain(origin.chain)})` : '';
			const unused = live && origin.state !== 'live' ? '; the value it overwrites is not read afterwards' : '';
			return location && new vscode.DiagnosticRelatedInformation(
				location,
				`'${origin.variable}' assigned without private${via}${unused}`
			);
		})
		.filter((info): info is vscode.DiagnosticRelatedInformation => info !== undefined);
	return diagnostic;
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
	diagnostic.code = code;
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
