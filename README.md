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
- **Quick fix** — `Declare '_x' private` inserts the missing keyword; a second action
  fixes every occurrence in the file at once.

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

Press `F5` to launch the Extension Development Host, then open `examples/sample.sqf`
to see the checker at work.

Source layout:

- `src/analyzer/tokenizer.ts` — SQF tokenizer (comments, strings, preprocessor)
- `src/analyzer/analyzer.ts` — scope tracking and the rule itself, free of VS Code APIs
- `src/diagnostics.ts` — turns issues into diagnostics for open documents and files on disk
- `src/quickFix.ts` — the `private` insertion code actions
- `src/extension.ts` — activation, commands, document listeners
