import * as vscode from 'vscode';
import {
	DIAGNOSTIC_CODE,
	DIAGNOSTIC_CODE_DUPLICATE,
	DIAGNOSTIC_CODE_SCOPE_LEAK,
	DIAGNOSTIC_CODE_SCOPE_LEAK_INTENTIONAL,
	DIAGNOSTIC_CODE_HIGH_RISK,
	DIAGNOSTIC_SOURCE,
	diagnosticCode,
	SHARED_DIRECTIVE
} from './diagnostics';

/** Diagnostics sitting on an assignment, where inserting `private` fixes them. */
const OUR_CODES: ReadonlySet<string> = new Set([
	DIAGNOSTIC_CODE,
	DIAGNOSTIC_CODE_DUPLICATE,
	DIAGNOSTIC_CODE_HIGH_RISK,
	DIAGNOSTIC_CODE_SCOPE_LEAK
]);

/** Scope leaks, which may also be meant, and then are marked with `SHARED_DIRECTIVE`. */
const LEAK_CODES: ReadonlySet<string> = new Set([DIAGNOSTIC_CODE_SCOPE_LEAK, DIAGNOSTIC_CODE_SCOPE_LEAK_INTENTIONAL]);

/**
 * Offers to insert the missing `private` keyword in front of the assignment, or, for a
 * scope leak, to mark the assignment as meant for the caller instead.
 */
export class AddPrivateQuickFix implements vscode.CodeActionProvider {
	static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext
	): vscode.CodeAction[] {
		const ours = context.diagnostics.filter(diagnostic => hasCode(diagnostic, OUR_CODES));
		const leaks = context.diagnostics.filter(diagnostic => hasCode(diagnostic, LEAK_CODES));
		if (ours.length === 0 && leaks.length === 0) {
			return [];
		}

		const actions = ours.map(diagnostic => {
			const name = document.getText(diagnostic.range);
			const action = new vscode.CodeAction(
				`Declare '${name}' private`,
				vscode.CodeActionKind.QuickFix
			);
			action.diagnostics = [diagnostic];
			action.isPreferred = true;
			action.edit = new vscode.WorkspaceEdit();
			action.edit.insert(document.uri, diagnostic.range.start, 'private ');
			return action;
		});

		for (const diagnostic of leaks) {
			const name = document.getText(diagnostic.range);
			const action = new vscode.CodeAction(
				`Mark '${name}' as shared with the caller on purpose`,
				vscode.CodeActionKind.QuickFix
			);
			action.diagnostics = [diagnostic];
			// Declaring a deliberate one private would break what the caller relies on.
			action.isPreferred = diagnosticCode(diagnostic) === DIAGNOSTIC_CODE_SCOPE_LEAK_INTENTIONAL;
			const line = document.lineAt(diagnostic.range.start.line);
			const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
			const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
			action.edit = new vscode.WorkspaceEdit();
			action.edit.insert(document.uri, line.range.start, `${indent}${SHARED_DIRECTIVE} ${name}${eol}`);
			actions.push(action);
		}

		const all = vscode.languages.getDiagnostics(document.uri).filter(diagnostic => hasCode(diagnostic, OUR_CODES));
		if (all.length > 1) {
			const fixAll = new vscode.CodeAction(
				`Declare all ${all.length} local variables in this file private`,
				vscode.CodeActionKind.QuickFix
			);
			fixAll.diagnostics = all;
			fixAll.edit = new vscode.WorkspaceEdit();
			for (const diagnostic of all) {
				fixAll.edit.insert(document.uri, diagnostic.range.start, 'private ');
			}
			actions.push(fixAll);
		}

		return actions;
	}
}

function hasCode(diagnostic: vscode.Diagnostic, codes: ReadonlySet<string>): boolean {
	const code = diagnosticCode(diagnostic);
	return diagnostic.source === DIAGNOSTIC_SOURCE && code !== undefined && codes.has(code);
}
