import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	DIAGNOSTIC_CODE_SCOPE_LEAK,
	DIAGNOSTIC_CODE_SCOPE_LEAK_INTENTIONAL,
	DIAGNOSTIC_CODE_HIGH_RISK,
	DIAGNOSTIC_SOURCE,
	diagnosticCode
} from '../diagnostics';
import { CallSiteMark } from '../callSiteMarks';
import { resetMinimumSeverityOnce, SqfCheckerApi } from '../extension';

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
			assert.strictEqual(diagnosticCode(diagnostics[0]), DIAGNOSTIC_CODE_HIGH_RISK);
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
			'private _leakTarget = 1;\ncall compile preprocessFileLineNumbers "scripts\\setup.sqf";\nhint str _leakTarget;\n'
		);
		// The callee uses the variable itself, so the leak is accidental rather than a way of returning a value.
		fs.writeFileSync(calleePath, '_leakTarget = 2;\nhint str _leakTarget;\n');

		try {
			for (const file of [callerPath, calleePath]) {
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
			}

			const callee = await waitForDiagnostics(vscode.Uri.file(calleePath), 5000, DIAGNOSTIC_CODE_SCOPE_LEAK);
			assert.strictEqual(callee.length, 1);
			assert.strictEqual(diagnosticCode(callee[0]), DIAGNOSTIC_CODE_SCOPE_LEAK);
			assert.strictEqual(callee[0].severity, vscode.DiagnosticSeverity.Error);
			assert.strictEqual(callee[0].relatedInformation?.[0].location.uri.fsPath, callerPath);
			assert.strictEqual(
				callee[0].relatedInformation?.[0].message,
				`'_leakTarget' is a local variable here (call chain: "scripts\\setup.sqf") and the variable is read afterwards!`
			);
			// A headline first, then a line each for the details and the call chain.
			const lines = callee[0].message.split('\n');
			assert.strictEqual(lines[0], "SCOPE LEAK: '_leakTarget' overwrites the caller's variable of the same name");
			assert.ok(lines[1].endsWith("which reads '_leakTarget' afterwards."));
			assert.strictEqual(lines[lines.length - 1], 'Call chain: "scripts\\setup.sqf"');
			const code = callee[0].code as { value: string; target: vscode.Uri };
			assert.strictEqual(code.target.toString(true), 'https://github.com/Ezcoo/SQFPrivateVarChecker#scope-leak');

			// The call is marked in the editor, but not listed in Problems a second time.
			const caller = await waitForCallSiteMarks(vscode.Uri.file(callerPath));
			assert.strictEqual(caller.length, 1);
			assert.strictEqual(caller[0].range.start.line, 1);
			assert.strictEqual(caller[0].severity, vscode.DiagnosticSeverity.Error);
			assert.ok(caller[0].message.includes('_leakTarget'));
			assert.strictEqual(caller[0].related[0].location.uri.fsPath, calleePath);
			assert.strictEqual(caller[0].related[0].message, "'_leakTarget' assigned without private and the variable is read afterwards!");
			assert.deepStrictEqual(
				vscode.languages.getDiagnostics(vscode.Uri.file(callerPath)).filter(d => d.source === DIAGNOSTIC_SOURCE),
				[]
			);
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a leak whose overwritten value is never read is only a warning', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqf-scope-leak-'));
		const callerPath = path.join(dir, 'init.sqf');
		const calleePath = path.join(dir, 'unused.sqf');
		fs.writeFileSync(callerPath, 'private _unusedLeak = 1;\ncall compile preprocessFileLineNumbers "unused.sqf";\n');
		fs.writeFileSync(calleePath, '_unusedLeak = 2;\nhint str _unusedLeak;\n');

		try {
			for (const file of [callerPath, calleePath]) {
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
			}

			const callee = await waitForDiagnostics(vscode.Uri.file(calleePath), 5000, DIAGNOSTIC_CODE_SCOPE_LEAK);
			assert.strictEqual(callee.length, 1);
			assert.strictEqual(callee[0].severity, vscode.DiagnosticSeverity.Warning);
			assert.strictEqual(
				callee[0].relatedInformation?.[0].message,
				`'_unusedLeak' is a local variable here (call chain: "unused.sqf")`
			);

			const caller = await waitForCallSiteMarks(vscode.Uri.file(callerPath));
			assert.strictEqual(caller.length, 1);
			assert.strictEqual(caller[0].severity, vscode.DiagnosticSeverity.Warning);
			assert.strictEqual(caller[0].related[0].message, "'_unusedLeak' assigned without private");
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

suite('scope leaks that look intentional', () => {
	test('are information, marked as intentional, and can be confirmed with a comment', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqf-scope-leak-'));
		const callerPath = path.join(dir, 'init.sqf');
		const calleePath = path.join(dir, 'setFlag.sqf');
		fs.writeFileSync(
			callerPath,
			'private _intentionalFlag = false;\ncall compile preprocessFileLineNumbers "setFlag.sqf";\nhint str _intentionalFlag;\n'
		);
		fs.writeFileSync(calleePath, 'if (alive player) then {\n\t_intentionalFlag = true;\n};\n');

		try {
			for (const file of [callerPath, calleePath]) {
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
			}
			const callee = await waitForDiagnostics(vscode.Uri.file(calleePath), 5000, DIAGNOSTIC_CODE_SCOPE_LEAK_INTENTIONAL);
			assert.strictEqual(callee.length, 1);
			assert.strictEqual(diagnosticCode(callee[0]), DIAGNOSTIC_CODE_SCOPE_LEAK_INTENTIONAL);
			assert.strictEqual(callee[0].severity, vscode.DiagnosticSeverity.Information);
			assert.ok(callee[0].message.includes('// sqf-private: shared _intentionalFlag'));

			const caller = await waitForCallSiteMarks(vscode.Uri.file(callerPath));
			assert.strictEqual(caller[0].severity, vscode.DiagnosticSeverity.Information);

			// The quick fix confirms it, which leaves nothing to report at either end.
			const document = await vscode.workspace.openTextDocument(calleePath);
			const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
				'vscode.executeCodeActionProvider',
				document.uri,
				callee[0].range
			);
			const confirm = actions.find(action => action.title.includes('shared with the caller'));
			assert.ok(confirm?.edit);
			assert.ok(!actions.some(action => action.title.startsWith('Declare')));
			await vscode.workspace.applyEdit(confirm.edit);
			assert.strictEqual(document.lineAt(1).text, '\t// sqf-private: shared _intentionalFlag');

			const deadline = Date.now() + 5000;
			const ours = () => vscode.languages.getDiagnostics(document.uri).filter(d => d.source === DIAGNOSTIC_SOURCE);
			while (Date.now() < deadline && (ours().length > 0 || (await callSiteMarks(vscode.Uri.file(callerPath))).length > 0)) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			assert.deepStrictEqual(ours(), []);
			assert.deepStrictEqual(await callSiteMarks(vscode.Uri.file(callerPath)), []);
		} finally {
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}).timeout(15000);
});

/** Waits until `uri` has diagnostics of ours (with `code`, when given), then returns all of ours. */
async function waitForDiagnostics(uri: vscode.Uri, timeoutMs = 5000, code?: string): Promise<vscode.Diagnostic[]> {
	const ours = () => vscode.languages.getDiagnostics(uri).filter(d => d.source === DIAGNOSTIC_SOURCE);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const diagnostics = ours();
		if (diagnostics.some(d => code === undefined || diagnosticCode(d) === code)) {
			return diagnostics;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return ours();
}

/** The call sites in `uri` through which scope leaks happen, as currently marked. */
async function callSiteMarks(uri: vscode.Uri): Promise<readonly CallSiteMark[]> {
	const extension = vscode.extensions.getExtension<SqfCheckerApi>('Ezcoo.sqf-private-variable-checker');
	assert.ok(extension);
	return (await extension.activate()).callSiteMarks(uri);
}

/** Waits until the call sites in `uri` through which scope leaks happen are marked, then returns the marks. */
async function waitForCallSiteMarks(uri: vscode.Uri, timeoutMs = 5000): Promise<readonly CallSiteMark[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const marks = await callSiteMarks(uri);
		if (marks.length > 0) {
			return marks;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return callSiteMarks(uri);
}
