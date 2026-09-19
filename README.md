# SQF Private Variable Checker

Finds local variables in `.sqf` files that are assigned without ever being declared
`private`. In SQF an undeclared `_variable` leaks into the caller's scope, which is a
classic source of hard-to-trace bugs in Arma mission and mod code.

```sqf
params ["_unit"];

private _position = getPosATL _unit;   // fine
_speed = speed _unit;                  // warning: assigned without being declared private
```

## Features

- **Live diagnostics** — squiggles appear in `.sqf` files as you type, with the results
  in the Problems panel.
- **Recursive workspace scan** — `SQF: Check Workspace for Non-Private Local Variables`
  walks every `.sqf` file in the workspace, reports progress, and writes a per-file
  summary to the *SQF Private Variable Checker* output channel.
- **Quick fix** — `Declare '_myVariable' private` inserts the missing keyword; a second action
  fixes every occurrence in the file at once.
- **Cross-file duplicate-name check** — if a non-private variable's name is also used
  as a local variable in a *different* `.sqf` file in the workspace, it is reported
  separately and more severely than a plain missing-private warning, since the
  non-private one can silently read or overwrite the other file's variable if the two
  ever end up sharing a scope (for example one script `call`s or inlines the other).
  Two local variables sharing a name *within the same file* are not affected — normal
  SQF scoping already covers that case.
- **High risk detection** — if a non-private variable's name has *more than one*
  non-private occurrence across the workspace (i.e. two or more files, not just one,
  all forgot `private` for the same name), it is reported even more severely than a
  plain duplicate-name collision: none of those occurrences has private scope protecting
  it. Its own `ultraHighRiskSeverity` setting controls how severe that is (`error` by default).
- **Severity filtering** — `minimumSeverity` hides diagnostics below a chosen severity,
  in both the Problems panel and workspace scan summaries. For example, set it to
  `warning` to see warnings and errors but hide information/hint entries, or to `error`
  to see errors only.

### What counts as a declaration

| Form | Treated as private |
| --- | --- |
| `private _x = 1;` | yes |
| `private ["_x", "_y"];` | yes |
| `params ["_x", ["_y", 0]];` | yes (`treatParamsAsPrivate`) |
| `for "_i" from 0 to 10 do {…}` | yes (`treatForLoopVariablesAsPrivate`) |
| `_this`, `_x`, `_forEachIndex`, `_exception`, `_thisScript`, … | never reported |

A declaration in an outer scope covers inner `{…}` blocks, but not the other way round.
Variable names are compared case-insensitively, the way the engine does it. Comments,
string literals and preprocessor lines (`#define`, `#include`) are skipped, so macro
bodies do not produce false positives.

## Commands

| Command | Description |
| --- | --- |
| `SQF: Check Workspace for Non-Private Local Variables` | Recursive scan of the whole workspace |
| `SQF: Check Current File for Non-Private Local Variables` | Re-check the active editor |
| `SQF: Clear Non-Private Local Variable Diagnostics` | Empty the Problems panel |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sqfPrivateVariableChecker.enable` | `true` | Turn the checker off entirely |
| `sqfPrivateVariableChecker.include` | `**/*.sqf` | Files included in a workspace scan |
| `sqfPrivateVariableChecker.exclude` | `["**/node_modules/**", "**/.git/**"]` | Files excluded from a workspace scan |
| `sqfPrivateVariableChecker.severity` | `warning` | `error`, `warning`, `information` or `hint` |
| `sqfPrivateVariableChecker.flagDuplicateLocalNames` | `true` | Cross-check non-private variables against every other `.sqf` file in the workspace |
| `sqfPrivateVariableChecker.duplicateNameSeverity` | `error` | Severity for a non-private variable whose name is also used in another file |
| `sqfPrivateVariableChecker.ultraHighRiskSeverity` | `error` | Severity for a non-private variable whose name is missing `private` in two or more different files |
| `sqfPrivateVariableChecker.minimumSeverity` | `hint` | Hide diagnostics below this severity, e.g. `warning` for warnings + errors, or `error` for errors only |
| `sqfPrivateVariableChecker.checkOnType` | `true` | Re-check while typing, otherwise only on open and save |
| `sqfPrivateVariableChecker.treatParamsAsPrivate` | `true` | Accept `params [...]` as a declaration |
| `sqfPrivateVariableChecker.treatForLoopVariablesAsPrivate` | `true` | Accept `for "_i"` as a declaration |
| `sqfPrivateVariableChecker.magicVariables` | `[]` | Extra engine- or macro-supplied names to ignore |

## Development

```bash
npm install
npm run watch     # esbuild + tsc in watch mode
npm test          # unit tests plus integration tests in a real VS Code instance
```

Press `F5` to launch the Extension Development Host, then open `examples/sample.sqf`,
`examples/sample2.sqf` and `examples/sample3.sqf` to see the checker at work,
including the duplicate-name case (`_index`, missing private in one file only) and
the ultra-high-risk case (`_speed`, missing private in two files at once).

Source layout:

- `src/analyzer/tokenizer.ts` — SQF tokenizer (comments, strings, preprocessor)
- `src/analyzer/analyzer.ts` — per-file scope tracking and the missing-private rule,
  free of VS Code APIs
- `src/workspaceIndex.ts` — tracks which local variable names each scanned file uses,
  and which of those are missing `private` there, to power the cross-file
  duplicate-name and ultra-high-risk checks; also free of VS Code APIs
- `src/diagnostics.ts` — runs the analyzer per file, keeps the workspace index up to
  date, and turns the results into diagnostics for open documents and files on disk
- `src/quickFix.ts` — the `private` insertion code actions
- `src/extension.ts` — activation, commands, document listeners
