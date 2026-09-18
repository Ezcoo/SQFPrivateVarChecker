import * as vscode from 'vscode';
import { DIAGNOSTIC_CODE, DIAGNOSTIC_SOURCE } from './diagnostics';

/** Offers to insert the missing `private` keyword in front of the assignment. */
export class AddPrivateQuickFix implements vscode.CodeActionProvider {
	static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext
	): vscode.CodeAction[] {
		const ours = context.diagnostics.filter(isOurDiagnostic);
		if (ours.length === 0) {
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

		const all = vscode.languages.getDiagnostics(document.uri).filter(isOurDiagnostic);
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

function isOurDiagnostic(diagnostic: vscode.Diagnostic): boolean {
	return diagnostic.source === DIAGNOSTIC_SOURCE && diagnostic.code === DIAGNOSTIC_CODE;
}
