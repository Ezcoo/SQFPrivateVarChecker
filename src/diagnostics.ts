import * as vscode from 'vscode';
import { analyzeFile, createPositionMapper, SqfIssue } from './analyzer/analyzer';
import { CheckerConfig, readConfig } from './config';
import { WorkspaceVariableIndex } from './workspaceIndex';

export const DIAGNOSTIC_SOURCE = 'sqf-private';
export const DIAGNOSTIC_CODE = 'missing-private';
export const DIAGNOSTIC_CODE_DUPLICATE = 'duplicate-name';
export const DIAGNOSTIC_CODE_ULTRA_HIGH_RISK = 'ultra-high-risk';

export function isSqfDocument(document: vscode.TextDocument): boolean {
	return document.languageId === 'sqf' || document.uri.path.toLowerCase().endsWith('.sqf');
}

interface FileState {
	text: string;
	issues: SqfIssue[];
	/** Local variable names (lowercased) that have a `missing-private` issue in this file. */
	nonPrivateNames: Set<string>;
}

export class SqfDiagnostics implements vscode.Disposable {
	private readonly collection: vscode.DiagnosticCollection;
	/** Which local variable names every scanned file uses, to power the cross-file check. */
	private readonly index = new WorkspaceVariableIndex();
	private readonly files = new Map<string, FileState>();

	constructor() {
		this.collection = vscode.languages.createDiagnosticCollection('sqf-private-variables');
	}

	dispose(): void {
		this.collection.dispose();
	}

	clear(): void {
		this.collection.clear();
		this.files.clear();
		this.index.clear();
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
		this.files.set(key, { text, issues: result.issues, nonPrivateNames: result.nonPrivateNames });

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

		return shown;
	}

	private forget(uri: vscode.Uri): void {
		const key = uri.toString();
		this.collection.delete(uri);
		this.files.delete(key);
		const changedNames = this.index.remove(key);
		this.recheckAffected(changedNames, key);
	}

	/**
	 * Rebuilds diagnostics for `uri` from its cached analysis, against the current
	 * index and the current `minimumSeverity` filter. Returns how many are shown.
	 */
	private emit(uri: vscode.Uri, config: CheckerConfig): number {
		const key = uri.toString();
		const state = this.files.get(key);
		if (!state || state.issues.length === 0) {
			this.collection.delete(uri);
			return 0;
		}

		const positionAt = createPositionMapper(state.text);
		const diagnostics = state.issues
			.map(issue => {
				const lower = issue.variable.toLowerCase();
				const otherFiles = config.flagDuplicateLocalNames ? this.index.otherFiles(lower, key) : [];
				const otherNonPrivateFiles = config.flagDuplicateLocalNames
					? this.index.otherNonPrivateFiles(lower, key)
					: [];
				return toDiagnostic(issue, toRange(positionAt, issue), config, otherFiles, otherNonPrivateFiles);
			})
			// A severity numerically greater than minimumSeverity is less severe (Error=0 ... Hint=3).
			.filter(diagnostic => diagnostic.severity <= config.minimumSeverity);
		this.collection.set(uri, diagnostics);
		return diagnostics.length;
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

function toRange(positionAt: (offset: number) => { line: number; character: number }, issue: SqfIssue): vscode.Range {
	const start = positionAt(issue.start);
	const end = positionAt(issue.end);
	return new vscode.Range(start.line, start.character, end.line, end.character);
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
	const isUltraHighRisk = otherNonPrivateFiles.length > 0;
	const isDuplicate = !isUltraHighRisk && otherFiles.length > 0;

	let severity: vscode.DiagnosticSeverity;
	let message: string;
	let code: string;
	if (isUltraHighRisk) {
		severity = config.ultraHighRiskSeverity;
		message = ultraHighRiskMessage(issue.variable, otherNonPrivateFiles);
		code = DIAGNOSTIC_CODE_ULTRA_HIGH_RISK;
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

function ultraHighRiskMessage(variable: string, otherFileKeys: string[]): string {
	const [firstKey, ...rest] = otherFileKeys;
	const firstPath = vscode.workspace.asRelativePath(vscode.Uri.parse(firstKey));
	const extra = rest.length > 0 ? ` and ${rest.length} other file${rest.length === 1 ? '' : 's'}` : '';
	const siteCount = otherFileKeys.length + 1;
	return (
		`HIGH RISK: local variable '${variable}' is assigned without being declared private in at least ` +
		`${siteCount} different places in the workspace, including this one and ${firstPath}${extra}.`
	);
}
