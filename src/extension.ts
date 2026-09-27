import * as vscode from 'vscode';
import { CONFIG_SECTION, readConfig } from './config';
import { isFunctionConfigFile, isSqfDocument, SqfDiagnostics } from './diagnostics';
import { MissionRoots } from './missions';
import { AddPrivateQuickFix } from './quickFix';

const DEBOUNCE_MS = 300;
/** Candidates for `description.ext` and `CfgFunctions.hpp`; filtered by `isFunctionConfigFile`. */
const FUNCTION_CONFIG_GLOB = '**/*.{ext,hpp,EXT,HPP}';
/** Candidates for `description.ext` and `mission.sqm`, which mark a mission folder; filtered by `MissionRoots.isMarker`. */
const MISSION_MARKER_GLOB = '**/*.{ext,sqm,EXT,SQM}';

export function activate(context: vscode.ExtensionContext) {
	const diagnostics = new SqfDiagnostics();
	const output = vscode.window.createOutputChannel('SQF Private Variable Checker');
	context.subscriptions.push(diagnostics, output);

	const pendingChecks = new Map<string, NodeJS.Timeout>();
	const scheduleCheck = (document: vscode.TextDocument) => {
		const key = document.uri.toString();
		const existing = pendingChecks.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		pendingChecks.set(
			key,
			setTimeout(() => {
				pendingChecks.delete(key);
				diagnostics.refreshDocument(document);
			}, DEBOUNCE_MS)
		);
	};

	const refreshAllOpenDocuments = () => {
		for (const document of vscode.workspace.textDocuments) {
			if (isSqfDocument(document)) {
				diagnostics.refreshDocument(document);
			}
		}
	};

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(document => diagnostics.refreshDocument(document)),
		vscode.workspace.onDidSaveTextDocument(document => diagnostics.refreshDocument(document)),
		vscode.workspace.onDidCloseTextDocument(document => {
			if (isSqfDocument(document) && document.uri.scheme === 'untitled') {
				diagnostics.delete(document.uri);
			}
		}),
		vscode.workspace.onDidChangeTextDocument(event => {
			if (isSqfDocument(event.document) && readConfig(event.document.uri).checkOnType) {
				scheduleCheck(event.document);
			}
		}),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				diagnostics.clear();
				refreshAllOpenDocuments();
				void indexWorkspaceQuietly(diagnostics);
			}
		})
	);

	// The cross-file duplicate-name check needs every file's local variable names,
	// not just the ones currently open, so keep files that are only touched on disk
	// (created, edited outside VS Code, or already present at startup) in the index too.
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.sqf');
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(uri => void diagnostics.refreshFile(uri, readConfig(uri))),
		watcher.onDidChange(uri => {
			// Open documents are already re-checked by onDidChangeTextDocument/onDidSaveTextDocument.
			if (!vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString())) {
				void diagnostics.refreshFile(uri, readConfig(uri));
			}
		}),
		watcher.onDidDelete(uri => diagnostics.delete(uri))
	);

	// Functions declared in CfgFunctions, for following `call` chains across files.
	const configWatcher = vscode.workspace.createFileSystemWatcher(FUNCTION_CONFIG_GLOB);
	const refreshConfig = (uri: vscode.Uri) => {
		if (isFunctionConfigFile(uri)) {
			diagnostics.refreshFunctionConfig(uri).catch(() => diagnostics.deleteFunctionConfig(uri));
		}
	};
	context.subscriptions.push(
		configWatcher,
		configWatcher.onDidCreate(refreshConfig),
		configWatcher.onDidChange(refreshConfig),
		configWatcher.onDidDelete(uri => diagnostics.deleteFunctionConfig(uri))
	);

	// Mission folders, so that several missions in one workspace are kept apart.
	const missionWatcher = vscode.workspace.createFileSystemWatcher(MISSION_MARKER_GLOB, false, true, false);
	context.subscriptions.push(
		missionWatcher,
		missionWatcher.onDidCreate(uri => diagnostics.setMissionMarker(uri, true)),
		missionWatcher.onDidDelete(uri => diagnostics.setMissionMarker(uri, false))
	);

	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			[{ language: 'sqf' }, { pattern: '**/*.sqf' }],
			new AddPrivateQuickFix(),
			{ providedCodeActionKinds: AddPrivateQuickFix.providedCodeActionKinds }
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('sqf-private-variable-checker.checkWorkspace', () =>
			checkWorkspace(diagnostics, output)
		),
		vscode.commands.registerCommand('sqf-private-variable-checker.checkFile', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !isSqfDocument(editor.document)) {
				vscode.window.showInformationMessage('The active editor is not an .sqf file.');
				return;
			}
			diagnostics.refreshDocument(editor.document);
			diagnostics.flushScopeLeaks();
			const count = diagnostics.shownCount(editor.document.uri);
			vscode.window.showInformationMessage(
				count === 0
					? 'No non-private local variables found in this file.'
					: `Found ${count} non-private local variable${count === 1 ? '' : 's'} in this file.`
			);
		}),
		vscode.commands.registerCommand('sqf-private-variable-checker.clear', () => diagnostics.clear())
	);

	refreshAllOpenDocuments();
	void indexWorkspaceQuietly(diagnostics);
	// After the configuration listener above, so a reset re-checks everything.
	void resetMinimumSeverityOnce(context);
}

/** Bump the suffix to run the reset again in some future release. */
const MINIMUM_SEVERITY_RESET_KEY = 'minimumSeverityReset.v1';
const MINIMUM_SEVERITY_DEFAULT = 'information';

/**
 * One-time migration: `minimumSeverity` now defaults to `information`, and every check
 * defaults to at least that, so an older explicit value (e.g. `warning`) would hide
 * them. Removes an explicit value other than `information` from the user settings,
 * once per install, so the default applies. Workspace and folder settings are project
 * files, possibly under version control, so they are left alone; so are later changes,
 * since the reset is remembered.
 */
export async function resetMinimumSeverityOnce(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get(MINIMUM_SEVERITY_RESET_KEY)) {
		return;
	}
	await context.globalState.update(MINIMUM_SEVERITY_RESET_KEY, true);

	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const previous = config.inspect<string>('minimumSeverity')?.globalValue;
	if (previous === undefined || previous === MINIMUM_SEVERITY_DEFAULT) {
		return;
	}
	try {
		await config.update('minimumSeverity', undefined, vscode.ConfigurationTarget.Global);
	} catch {
		return; // Settings that cannot be written are left as they are.
	}
	vscode.window.showInformationMessage(
		`SQF Private Variable Checker: ${CONFIG_SECTION}.minimumSeverity was reset from '${previous}' to its ` +
			`new default '${MINIMUM_SEVERITY_DEFAULT}' in your user settings, so no checks are hidden.`
	);
}

/**
 * Finds every mission folder in the workspace. Done before any file is checked, so the
 * first pass already keeps missions apart.
 */
async function indexMissions(diagnostics: SqfDiagnostics, exclude: string | null): Promise<void> {
	const files = await vscode.workspace.findFiles(MISSION_MARKER_GLOB, exclude ?? undefined);
	for (const uri of files.filter(uri => MissionRoots.isMarker(uri.path))) {
		diagnostics.setMissionMarker(uri, true);
	}
}

/** Reads every `description.ext` and `CfgFunctions.hpp` in the workspace. */
async function indexFunctionConfigs(diagnostics: SqfDiagnostics, exclude: string | null): Promise<void> {
	const files = await vscode.workspace.findFiles(FUNCTION_CONFIG_GLOB, exclude ?? undefined);
	for (const uri of files.filter(isFunctionConfigFile)) {
		try {
			await diagnostics.refreshFunctionConfig(uri);
		} catch {
			// An unreadable config only means fewer functions can be followed.
		}
	}
}

/**
 * Scans every matching file in the background so the cross-file duplicate-name check
 * (`flagDuplicateLocalNames`) has something to compare against from the start, rather
 * than only ever seeing files the user happens to open. Silent by design: unlike
 * `SQF: Check Workspace`, this is not a user-initiated action.
 */
async function indexWorkspaceQuietly(diagnostics: SqfDiagnostics): Promise<void> {
	if (!vscode.workspace.workspaceFolders?.length) {
		return;
	}

	const config = readConfig();
	if (!config.enable || (!config.flagDuplicateLocalNames && !config.detectScopeLeaks)) {
		return;
	}

	let files: vscode.Uri[];
	try {
		await indexMissions(diagnostics, config.exclude);
		await indexFunctionConfigs(diagnostics, config.exclude);
		files = await vscode.workspace.findFiles(config.include, config.exclude ?? undefined);
	} catch {
		return;
	}

	for (const uri of files) {
		try {
			await diagnostics.refreshFile(uri, config);
		} catch {
			// Best-effort background indexing; one unreadable file should not stop the rest.
		}
	}
}

async function checkWorkspace(diagnostics: SqfDiagnostics, output: vscode.OutputChannel): Promise<void> {
	if (!vscode.workspace.workspaceFolders?.length) {
		vscode.window.showInformationMessage('Open a folder or workspace to scan for .sqf files.');
		return;
	}

	const config = readConfig();
	if (!config.enable) {
		vscode.window.showWarningMessage(
			`${CONFIG_SECTION}.enable is false, so no files were checked.`
		);
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Checking .sqf files for non-private local variables',
			cancellable: true
		},
		async (progress, token) => {
			diagnostics.clear();

			const files = await vscode.workspace.findFiles(config.include, config.exclude ?? undefined);
			if (files.length === 0) {
				vscode.window.showInformationMessage(`No files matched '${config.include}'.`);
				return;
			}

			output.clear();
			output.appendLine(`Scanning ${files.length} file(s) matching '${config.include}'...`);

			let issueCount = 0;
			let fileCount = 0;
			let checked = 0;

			await indexMissions(diagnostics, config.exclude);
			await indexFunctionConfigs(diagnostics, config.exclude);

			const scanned: vscode.Uri[] = [];
			for (const uri of files) {
				if (token.isCancellationRequested) {
					break;
				}

				try {
					await diagnostics.refreshFile(uri, config);
					scanned.push(uri);
				} catch (error) {
					output.appendLine(`  ! ${vscode.workspace.asRelativePath(uri)}: ${describe(error)}`);
				}

				checked++;
				progress.report({
					increment: 100 / files.length,
					message: `${checked}/${files.length}`
				});
			}

			// Scope leaks follow calls between files, so they are only complete once every file is in.
			diagnostics.flushScopeLeaks();

			for (const uri of scanned) {
				const found = diagnostics.shownCount(uri);
				if (found > 0) {
					issueCount += found;
					fileCount++;
					output.appendLine(
						`  ${vscode.workspace.asRelativePath(uri)}: ${found} non-private local variable${
							found === 1 ? '' : 's'
						}`
					);
				}
			}

			const summary =
				issueCount === 0
					? `Checked ${checked} .sqf file(s): no non-private local variables found.`
					: `Checked ${checked} .sqf file(s): ${issueCount} non-private local variable(s) in ${fileCount} file(s).`;

			output.appendLine(summary);

			if (issueCount === 0) {
				vscode.window.showInformationMessage(summary);
				return;
			}

			const choice = await vscode.window.showWarningMessage(summary, 'Show Problems', 'Show Details');
			if (choice === 'Show Problems') {
				await vscode.commands.executeCommand('workbench.actions.view.problems');
			} else if (choice === 'Show Details') {
				output.show(true);
			}
		}
	);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function deactivate() {}
