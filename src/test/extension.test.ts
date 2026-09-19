import * as assert from 'assert';
import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE } from '../diagnostics';

suite('extension', () => {
	test('reports diagnostics for an open .sqf document', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'sqf',
			content: 'private _ok = 1;\n_bad = 2;\n'
		});
		await vscode.window.showTextDocument(document);

		const diagnostics = await waitForDiagnostics(document.uri);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(diagnostics[0].source, DIAGNOSTIC_SOURCE);
		assert.ok(diagnostics[0].message.includes('_bad'));
		assert.strictEqual(diagnostics[0].range.start.line, 1);
	});

	test('registers its commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('sqf-private-variable-checker.checkWorkspace'));
		assert.ok(commands.includes('sqf-private-variable-checker.checkFile'));
	});

	test('minimumSeverity hides diagnostics less severe than it', async () => {
		const config = vscode.workspace.getConfiguration('sqfPrivateVariableChecker');
		await config.update('minimumSeverity', 'error', vscode.ConfigurationTarget.Global);
		try {
			const document = await vscode.workspace.openTextDocument({
				language: 'sqf',
				// A name not used by any other test, so this stays a plain
				// "missing-private" warning rather than a cross-file "duplicate-name" error.
				content: '_minSeverityOnly = 2;\n'
			});
			await vscode.window.showTextDocument(document);

			// Give the checker a moment to run, then confirm nothing below "error" shows up.
			await new Promise(resolve => setTimeout(resolve, 500));
			const diagnostics = vscode.languages.getDiagnostics(document.uri).filter(d => d.source === DIAGNOSTIC_SOURCE);
			assert.deepStrictEqual(diagnostics, []);
		} finally {
			await config.update('minimumSeverity', undefined, vscode.ConfigurationTarget.Global);
		}
	});
});

async function waitForDiagnostics(uri: vscode.Uri, timeoutMs = 5000): Promise<vscode.Diagnostic[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const diagnostics = vscode.languages.getDiagnostics(uri).filter(d => d.source === DIAGNOSTIC_SOURCE);
		if (diagnostics.length > 0) {
			return diagnostics;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return vscode.languages.getDiagnostics(uri).filter(d => d.source === DIAGNOSTIC_SOURCE);
}
