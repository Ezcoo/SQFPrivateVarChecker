import * as vscode from 'vscode';
import { AnalyzerOptions } from './analyzer/analyzer';

export const CONFIG_SECTION = 'sqfPrivateVariableChecker';

export interface CheckerConfig extends AnalyzerOptions {
	enable: boolean;
	include: string;
	exclude: string | null;
	severity: vscode.DiagnosticSeverity;
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
		checkOnType: config.get<boolean>('checkOnType', true),
		magicVariables: config.get<string[]>('magicVariables', []),
		treatParamsAsPrivate: config.get<boolean>('treatParamsAsPrivate', true),
		treatForLoopVariablesAsPrivate: config.get<boolean>('treatForLoopVariablesAsPrivate', true)
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
