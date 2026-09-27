import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	DIAGNOSTIC_CODE_SCOPE_LEAK,
	DIAGNOSTIC_CODE_SCOPE_LEAK_CALL,
	DIAGNOSTIC_CODE_HIGH_RISK,
	DIAGNOSTIC_SOURCE
} from '../diagnostics';
import { resetMinimumSeverityOnce } from '../extension';

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

	test('a name missing private in two files is flagged as high risk', async () => {
		// A name not used by any other test, since this needs to be missing
		// private in *exactly* two open documents for the assertions below to hold.
		const content = '_highRiskyShared = 1;\n';

		const first = await vscode.workspace.openTextDocument({ language: 'sqf', content });
		await vscode.window.showTextDocument(first);
		const second = await vscode.workspace.openTextDocument({ language: 'sqf', content });
		await vscode.window.showTextDocument(second);

		const [firstDiagnostics, secondDiagnostics] = await Promise.all([
			waitForDiagnostics(first.uri),
			waitForDiagnostics(second.uri)
		]);

		for (const diagnostics of [firstDiagnostics, secondDiagnostics]) {
			assert.strictEqual(diagnostics.length, 1);
			assert.strictEqual(diagnostics[0].code, DIAGNOSTIC_CODE_HIGH_RISK);
			assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Warning);
			assert.ok(diagnostics[0].message.toLowerCase().includes('high risk'));
		}
	});
});

suite('minimumSeverity reset', () => {
	/** Just enough of an ExtensionContext for the reset: in-memory global/workspace state. */
	function fakeContext(): vscode.ExtensionContext {
		const memento = () => {
			const values = new Map<string, unknown>();
			return {
				get: (key: string) => values.get(key),
				update: async (key: string, value: unknown) => void values.set(key, value)
			};
		};
		return { globalState: memento(), workspaceState: memento() } as unknown as vscode.ExtensionContext;
	}

	test('removes an older explicit value once, then leaves later changes alone', async () => {
		const config = () => vscode.workspace.getConfiguration('sqfPrivateVariableChecker');
		await config().update('minimumSeverity', 'warning', vscode.ConfigurationTarget.Global);
		try {
			const context = fakeContext();
			await resetMinimumSeverityOnce(context);
			assert.strictEqual(config().inspect('minimumSeverity')?.globalValue, undefined);
			assert.strictEqual(config().get('minimumSeverity'), 'information');

			await config().update('minimumSeverity', 'error', vscode.ConfigurationTarget.Global);
			await resetMinimumSeverityOnce(context);
			assert.strictEqual(config().inspect('minimumSeverity')?.globalValue, 'error');
		} finally {
			await config().update('minimumSeverity', undefined, vscode.ConfigurationTarget.Global);
		}
	});
});

suite('scope leaks', () => {
	test('a called file overwriting a caller\'s local is reported at both ends', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqf-scope-leak-'));
		fs.mkdirSync(path.join(dir, 'scripts'));
		const callerPath = path.join(dir, 'init.sqf');
		const calleePath = path.join(dir, 'scripts', 'setup.sqf');
		// Names not used by any other test, to stay clear of the cross-file checks.
		fs.writeFileSync(
			callerPath,
			'private _leakTarget = 1;\ncall compile preprocessFileLineNumbers "scripts\\setup.sqf";\n'
		);
		fs.writeFileSync(calleePath, '_leakTarget = 2;\n');

		try {
			for (const file of [callerPath, calleePath]) {
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
			}

			const callee = await waitForDiagnostics(vscode.Uri.file(calleePath), 5000, DIAGNOSTIC_CODE_SCOPE_LEAK);
			assert.strictEqual(callee.length, 1);
			assert.strictEqual(callee[0].code, DIAGNOSTIC_CODE_SCOPE_LEAK);
			assert.strictEqual(callee[0].severity, vscode.DiagnosticSeverity.Error);
			assert.strictEqual(callee[0].relatedInformation?.[0].location.uri.fsPath, callerPath);

			const caller = await waitForDiagnostics(vscode.Uri.file(callerPath), 5000, DIAGNOSTIC_CODE_SCOPE_LEAK_CALL);
			assert.strictEqual(caller.length, 1);
			assert.strictEqual(caller[0].range.start.line, 1);
			assert.ok(caller[0].message.includes('_leakTarget'));
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Waits until `uri` has diagnostics of ours (with `code`, when given), then returns all of ours. */
async function waitForDiagnostics(uri: vscode.Uri, timeoutMs = 5000, code?: string): Promise<vscode.Diagnostic[]> {
	const ours = () => vscode.languages.getDiagnostics(uri).filter(d => d.source === DIAGNOSTIC_SOURCE);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const diagnostics = ours();
		if (diagnostics.some(d => code === undefined || d.code === code)) {
			return diagnostics;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return ours();
}
