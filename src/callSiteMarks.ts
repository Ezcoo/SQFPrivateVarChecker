import * as vscode from 'vscode';

/** Something shown at a mark's hover, with a link to where it is. */
export interface CallSiteMarkInfo {
	location: vscode.Location;
	message: string;
}

/**
 * A `call` through which a scope leak happens. Drawn in the editor like a diagnostic,
 * but not one: the assignment it leads to already has the full diagnostic, with this
 * call among its related information, so the Problems view lists each leak only once.
 */
export interface CallSiteMark {
	range: vscode.Range;
	severity: vscode.DiagnosticSeverity;
	/** A headline, then a line each for the details; plain text. */
	message: string;
	related: CallSiteMarkInfo[];
	/** Shown at the end of the hover, linking to its explanation. */
	code: { value: string; target: vscode.Uri };
}

/** Squiggle and overview ruler colors per severity, matching those of diagnostics. */
const STYLES: [vscode.DiagnosticSeverity, string, string | undefined][] = [
	[vscode.DiagnosticSeverity.Error, 'editorError', 'editorOverviewRuler.errorForeground'],
	[vscode.DiagnosticSeverity.Warning, 'editorWarning', 'editorOverviewRuler.warningForeground'],
	[vscode.DiagnosticSeverity.Information, 'editorInfo', 'editorOverviewRuler.infoForeground'],
	[vscode.DiagnosticSeverity.Hint, 'editorHint', undefined]
];

export class CallSiteMarks implements vscode.Disposable {
	private readonly types = new Map<vscode.DiagnosticSeverity, vscode.TextEditorDecorationType>();
	private readonly marks = new Map<string, CallSiteMark[]>();
	private readonly listener: vscode.Disposable;

	constructor() {
		for (const [severity, color, rulerColor] of STYLES) {
			this.types.set(
				severity,
				vscode.window.createTextEditorDecorationType({
					// Theme colors are only available here as CSS variables.
					textDecoration: `underline ${severity === vscode.DiagnosticSeverity.Hint ? 'dotted' : 'wavy'} var(--vscode-${color}-foreground)`,
					overviewRulerColor: rulerColor && new vscode.ThemeColor(rulerColor),
					overviewRulerLane: vscode.OverviewRulerLane.Right
				})
			);
		}
		this.listener = vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(editor => this.apply(editor)));
	}

	dispose(): void {
		this.listener.dispose();
		this.types.forEach(type => type.dispose());
		this.marks.clear();
	}

	/** The marks currently shown for `uri`. */
	get(uri: vscode.Uri): readonly CallSiteMark[] {
		return this.marks.get(uri.toString()) ?? [];
	}

	set(uri: vscode.Uri, marks: CallSiteMark[]): void {
		const key = uri.toString();
		if (marks.length === 0) {
			if (!this.marks.delete(key)) {
				return;
			}
		} else {
			this.marks.set(key, marks);
		}
		this.applyTo(key);
	}

	delete(uri: vscode.Uri): void {
		this.set(uri, []);
	}

	clear(): void {
		const keys = [...this.marks.keys()];
		this.marks.clear();
		keys.forEach(key => this.applyTo(key));
	}

	private applyTo(key: string): void {
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.toString() === key) {
				this.apply(editor);
			}
		}
	}

	private apply(editor: vscode.TextEditor): void {
		const marks = this.marks.get(editor.document.uri.toString()) ?? [];
		for (const [severity, type] of this.types) {
			editor.setDecorations(
				type,
				marks
					.filter(mark => mark.severity === severity)
					.map(mark => ({ range: mark.range, hoverMessage: hover(mark) }))
			);
		}
	}
}

/**
 * The hover of a mark, laid out like VS Code's own hover for a diagnostic: the message,
 * then `sqf-private(code)` with the code linking to its explanation, then a paragraph per
 * related location, `file(line, column): message`. The diagnostic hover shows its text in
 * the editor font; the message is a plain text code block, which is shown in that font
 * too, and wrapped the same way. Links cannot go in a code block, so the rest is not.
 */
function hover(mark: CallSiteMark): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString();
	markdown.appendMarkdown(codeBlock(mark.message));
	markdown.appendMarkdown(`\n\nsqf-private([${escapeMarkdown(mark.code.value)}](${mark.code.target.toString()}))`);
	for (const info of mark.related) {
		const { uri, range } = info.location;
		const line = range.start.line + 1;
		const column = range.start.character + 1;
		const target = uri.with({ fragment: `L${line},${column}` });
		const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
		markdown.appendMarkdown(
			`\n\n[${escapeMarkdown(`${name}(${line}, ${column})`)}](${target.toString()}): ${escapeMarkdown(info.message)}`
		);
	}
	return markdown;
}

/** `text` as a plain text Markdown code block, fenced with more backticks than any run inside it. */
function codeBlock(text: string): string {
	const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
	const fence = '`'.repeat(Math.max(3, longestRun + 1));
	return `${fence}plaintext\n${text}\n${fence}`;
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
