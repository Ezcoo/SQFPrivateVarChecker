import * as vscode from 'vscode';
import { AnalyzerOptions } from './analyzer/analyzer';

export const CONFIG_SECTION = 'sqfPrivateVariableChecker';

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
	ultraHighRiskSeverity: vscode.DiagnosticSeverity;
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
		severity: toSeverity(config.get<string>('severity', 'warning')),
		duplicateNameSeverity: toSeverity(config.get<string>('duplicateNameSeverity', 'error')),
		ultraHighRiskSeverity: toSeverity(config.get<string>('ultraHighRiskSeverity', 'error')),
		minimumSeverity: toSeverity(config.get<string>('minimumSeverity', 'hint')),
		checkOnType: config.get<boolean>('checkOnType', true),
		magicVariables: config.get<string[]>('magicVariables', []),
		treatParamsAsPrivate: config.get<boolean>('treatParamsAsPrivate', true),
		treatForLoopVariablesAsPrivate: config.get<boolean>('treatForLoopVariablesAsPrivate', true),
		flagDuplicateLocalNames: config.get<boolean>('flagDuplicateLocalNames', true)
	};
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
