import * as vscode from 'vscode';
import { analyze, createPositionMapper, SqfIssue } from './analyzer/analyzer';
import { CheckerConfig, readConfig } from './config';

export const DIAGNOSTIC_SOURCE = 'sqf-private';
export const DIAGNOSTIC_CODE = 'missing-private';

export function isSqfDocument(document: vscode.TextDocument): boolean {
	return document.languageId === 'sqf' || document.uri.path.toLowerCase().endsWith('.sqf');
}

export class SqfDiagnostics implements vscode.Disposable {
	private readonly collection: vscode.DiagnosticCollection;

	constructor() {
		this.collection = vscode.languages.createDiagnosticCollection('sqf-private-variables');
	}

	dispose(): void {
		this.collection.dispose();
	}

	clear(): void {
		this.collection.clear();
	}

	delete(uri: vscode.Uri): void {
		this.collection.delete(uri);
	}

	/** Re-checks an open document. Returns the number of issues found. */
	refreshDocument(document: vscode.TextDocument): number {
		if (!isSqfDocument(document)) {
			return 0;
		}

		const config = readConfig(document.uri);
		if (!config.enable) {
			this.collection.delete(document.uri);
			return 0;
		}

		const issues = analyze(document.getText(), config);
		this.collection.set(
			document.uri,
			issues.map(issue =>
				toDiagnostic(
					issue,
					new vscode.Range(document.positionAt(issue.start), document.positionAt(issue.end)),
					config.severity
				)
			)
		);
		return issues.length;
	}

	/** Checks a file on disk without opening it as a document. */
	async refreshFile(uri: vscode.Uri, config: CheckerConfig): Promise<number> {
		const openDocument = vscode.workspace.textDocuments.find(
			document => document.uri.toString() === uri.toString()
		);
		// Prefer unsaved editor content over what is on disk.
		const text = openDocument
			? openDocument.getText()
			: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));

		const issues = analyze(text, config);
		if (issues.length === 0) {
			this.collection.delete(uri);
			return 0;
		}

		const positionAt = createPositionMapper(text);
		this.collection.set(
			uri,
			issues.map(issue => {
				const start = positionAt(issue.start);
				const end = positionAt(issue.end);
				const range = new vscode.Range(start.line, start.character, end.line, end.character);
				return toDiagnostic(issue, range, config.severity);
			})
		);
		return issues.length;
	}
}

function toDiagnostic(
	issue: SqfIssue,
	range: vscode.Range,
	severity: vscode.DiagnosticSeverity
): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(range, issue.message, severity);
	diagnostic.source = DIAGNOSTIC_SOURCE;
	diagnostic.code = DIAGNOSTIC_CODE;
	return diagnostic;
}
