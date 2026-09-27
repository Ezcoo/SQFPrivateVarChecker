import * as vscode from 'vscode';
import { AnalyzerOptions } from './analyzer/analyzer';

export const CONFIG_SECTION = 'sqfPrivateVariableChecker';
/** What `highRiskSeverity` was called in 0.2.0; still honoured when only it is set. */
const LEGACY_HIGH_RISK_SEVERITY = 'ultraHighRiskSeverity';

export interface CheckerConfig extends AnalyzerOptions {
	enable: boolean;
	include: string;
	exclude: string | null;
	severity: vscode.DiagnosticSeverity;
	/**
	 * Cross-check non-private variables against every other .sqf file in the
	 * workspace, not just the current file.
	 */
	flagDuplicateLocalNames: boolean;
	/** Severity for a non-private variable whose name is also used in another file. */
	duplicateNameSeverity: vscode.DiagnosticSeverity;
	/**
	 * Severity for a non-private variable whose name is missing `private` in two or
	 * more different files -- none of those occurrences has its own scope, so they
	 * can freely collide with each other. Stronger than a plain duplicate name, where
	 * only one side is missing `private`.
	 */
	highRiskSeverity: vscode.DiagnosticSeverity;
	/**
	 * Follow `call` chains across files and report non-private assignments that
	 * overwrite a local variable of some caller up the chain.
	 */
	detectScopeLeaks: boolean;
	/** Severity for such a confirmed scope leak, at the assignment and the call's mark. */
	scopeLeakSeverity: vscode.DiagnosticSeverity;
	/**
	 * Severity for a confirmed scope leak whose overwritten variable is never read
	 * afterwards, so it changes nothing yet.
	 */
	unusedScopeLeakSeverity: vscode.DiagnosticSeverity;
	/**
	 * Severity for a confirmed scope leak that looks deliberate: the caller does not use
	 * its value before the call, and the function never reads back what it assigns.
	 */
	intentionalScopeLeakSeverity: vscode.DiagnosticSeverity;
	/** Diagnostics less severe than this (e.g. Hint when this is Warning) are hidden. */
	minimumSeverity: vscode.DiagnosticSeverity;
	checkOnType: boolean;
}

export function readConfig(scope?: vscode.ConfigurationScope): CheckerConfig {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION, scope);
	const exclude = config.get<string[]>('exclude', []).filter(pattern => pattern.trim().length > 0);

	return {
		enable: config.get<boolean>('enable', true),
		include: config.get<string>('include', '**/*.sqf'),
		exclude: toExcludeGlob(exclude),
		severity: toSeverity(config.get<string>('severity', 'information')),
		duplicateNameSeverity: toSeverity(config.get<string>('duplicateNameSeverity', 'information')),
		highRiskSeverity: toSeverity(
			userValue(config, 'highRiskSeverity') ?? userValue(config, LEGACY_HIGH_RISK_SEVERITY) ?? 'warning'
		),
		detectScopeLeaks: config.get<boolean>('detectScopeLeaks', true),
		scopeLeakSeverity: toSeverity(config.get<string>('scopeLeakSeverity', 'error')),
		unusedScopeLeakSeverity: toSeverity(config.get<string>('unusedScopeLeakSeverity', 'warning')),
		intentionalScopeLeakSeverity: toSeverity(config.get<string>('intentionalScopeLeakSeverity', 'information')),
		minimumSeverity: toSeverity(config.get<string>('minimumSeverity', 'information')),
		checkOnType: config.get<boolean>('checkOnType', true),
		magicVariables: config.get<string[]>('magicVariables', []),
		treatParamsAsPrivate: config.get<boolean>('treatParamsAsPrivate', true),
		treatForLoopVariablesAsPrivate: config.get<boolean>('treatForLoopVariablesAsPrivate', true),
		flagDuplicateLocalNames: config.get<boolean>('flagDuplicateLocalNames', true)
	};
}

/** The value the user set for `key` at any level, ignoring the contributed default. */
function userValue(config: vscode.WorkspaceConfiguration, key: string): string | undefined {
	const inspected = config.inspect<string>(key);
	return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

/** `findFiles` takes a single glob, so several patterns become one brace group. */
function toExcludeGlob(patterns: string[]): string | null {
	if (patterns.length === 0) {
		return null;
	}
	return patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
}

function toSeverity(value: string): vscode.DiagnosticSeverity {
	switch (value) {
		case 'error':
			return vscode.DiagnosticSeverity.Error;
		case 'information':
			return vscode.DiagnosticSeverity.Information;
		case 'hint':
			return vscode.DiagnosticSeverity.Hint;
		default:
			return vscode.DiagnosticSeverity.Warning;
	}
}
