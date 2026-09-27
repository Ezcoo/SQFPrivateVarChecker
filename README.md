# SQF Private Variable Checker

Finds local variables in `.sqf` files that are assigned without ever being declared
`private`. In SQF an undeclared `_variable` leaks into the caller's scope, which is a
classic source of hard-to-trace bugs in Arma mission and mod code.

```sqf
params ["_unit"];

private _position = getPosATL _unit;   // fine
_speed = speed _unit;                  // assigned without being declared private
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
  separately from a plain missing-private diagnostic, with its own message and severity
  setting (`duplicateNameSeverity`, `information` by default), since the
  non-private one can silently read or overwrite the other file's variable if the two
  ever end up sharing a scope (for example one script `call`s or inlines the other).
  Two local variables sharing a name *within the same file* are not affected — normal
  SQF scoping already covers that case.
- **High risk detection** — if a non-private variable's name has *more than one*
  non-private occurrence across the workspace (i.e. two or more files, not just one,
  all forgot `private` for the same name), it is reported separately from a plain
  duplicate-name collision: none of those occurrences has private scope protecting
  it. Its own `highRiskSeverity` setting controls how severe that is (`warning` by
  default). Both this and the duplicate-name check point at *possible* collisions; the
  scope leak check below reports the *confirmed* ones, as errors.
- **Scope leak detection** — `call` runs the callee inside the caller's scope, so a
  non-private assignment in a called function overwrites the caller's variable of the
  same name if one exists. The checker follows every `call` across files, however
  many calls deep, and reports each *confirmed* case (the variable really exists where
  the call is made) at the assignment, whether the overwrite was intentional or not.
  The call is underlined in the editor too, with the details on hover, but only the
  assignment is listed in the Problems view, with the affected calls under it.
  Callees are resolved from:
  - `CfgFunctions` in `description.ext` or `CfgFunctions.hpp` (including the default
    `functions\Category\fn_name.sqf` paths, category and function `file` attributes,
    and `tag` overrides),
  - `anyName = compile preprocessFileLineNumbers "path\file.sqf"` in any `.sqf` file:
    the name is whatever is assigned to and need not follow the `TAG_fnc_name`
    convention (also `compileFinal`, `preprocessFile`, `loadFile`, `compileScript`,
    nested forms like `compileFinal compile (...)`, and
    `missionNamespace setVariable ["anyName", compile ...]`),
  - functions defined as a code block in any `.sqf` file: `anyName = {...};`,
    `anyName = compileFinal {...};` or `missionNamespace setVariable ["anyName", {...}]`
    (several per file is fine; each body is followed on its own),
  - `call compile preprocessFileLineNumbers "path\file.sqf"` directly,
  - local variables in the same file: `private _fnc = {...}; call _fnc` or
    `private _fnc = compile preprocessFileLineNumbers "file.sqf"; call _fnc`, as long
    as `_fnc` is assigned exactly once in that file (otherwise what it holds at the
    call is not certain, so it is not followed). Code blocks can call each other and
    global functions, and those chains are followed too.

  Assignments inside code that runs elsewhere (`spawn {...}`, code passed in arrays,
  e.g. to `addEventHandler`, and event handlers that take their code directly, such as
  `addPublicVariableEventHandler {...}`, `onPlayerConnected {...}` or
  `onMapSingleClick {...}`) are not counted. Inline `call {...}` blocks are checked
  like any other block in the file. Controlled by `detectScopeLeaks` and
  `scopeLeakSeverity` (`error` by default).

  A leak whose overwritten variable is never read afterwards changes nothing yet, so
  it is reported with `unusedScopeLeakSeverity` instead (`warning` by default): it
  still breaks as soon as someone reads the variable after the call. That is only the
  case when it is certain; when in doubt, it is an error. The value counts as read
  when, before it is overwritten or its scope ends, it is:
  - mentioned after the call, including in a string (`isNil "_x"`, `compile "..."`)
    and inside blocks that run only sometimes, but not in a block that cannot run
    after it: another branch of the same `if`/`else` (also `then [{...}, {...}]`) or
    another `case`/`default` of the same `switch`, or, when the call is in an
    `if (...) exitWith {...}` block, the rest of the scope that block leaves (a loop,
    for an `exitWith` in a loop body). A `catch` block does count, since it can run
    after the call. Nor does a read that the caller's own assignment always comes
    before: one in the same block as the read, or in a block around it, after the
    call (`_camps = ...; {...} forEach _camps;`), or, in a loop around the call,
    earlier in the same round. The read then sees that value instead. An assignment
    in a block that has ended before the read does not count, since it may not have
    run,
  - mentioned anywhere in an enclosing loop (`while`, `for`, `forEach`, `count`,
    `waitUntil`, ...), since that code runs again after the call, other branches
    included,
  - read by a function called later, or by a callee of that function, that has no
    variable of its own by that name, or the call cannot be followed at all
    (`call _param`, `call compile _string`),
  - read by a function in between on the call chain after the call returns to it,
  - or the caller's own variable is not declared `private` at the top of its file or
    code block, so it may belong to whoever calls *that* file in turn, and one of
    those calls (found in the workspace, any number of calls up) reads it afterwards.
    A file that is only run by `execVM`, `spawn` or an event handler takes its
    variables with it.

  Two kinds of leak straight from the called function (not from further down the
  chain) are told apart from accidental ones:
  - **Same value** — the function only assigns what the call passes in for that
    variable: the caller does `[_itemID, _amount] call TAG_fnc_foo`, and the function
    does `_itemID = _this select 0` (also `(_this select 0)`, `_this # 0`, or
    `_this` for `_x call ...`) and never assigns `_itemID` again. The caller's
    variable keeps its value, so this is reported with `unusedScopeLeakSeverity`,
    like an unused leak. `round (_this select 1)` and the like do not count.
  - **Looks intentional** — the caller does not use its value between setting it and
    the call (not even through a function called in between), and the function never
    reads back what it assigns (not even through a function it calls afterwards). The
    assignment is then a way of returning a value, such as a "handled" flag or a
    cache reset for the caller, and is reported with `intentionalScopeLeakSeverity`
    (`information` by default) and its own code, `scope-leak-intentional`.

  An assignment inside a `switch` on what the caller passes in only leaks through
  calls that can select its case. For a function like

  ```sqf
  private _message = _this select 0;
  switch (_message) do {
  	case "build-by": { _var = ...; };
  	case "town-capture": { ... };
  };
  ```

  `["town-capture", [_town]] call TAG_fnc_displayMessage` does not overwrite the
  caller's `_var`, while `["build-by", ...]` (or a call that passes a variable) does.
  This works when the switch is on `_this select N` (also `_this # N`, or `_this`),
  or on a local variable assigned exactly once from it (or by `params`) before the
  switch; the call passes a string or number literal; and the case labels are
  literals (`case "a"; case "b": {...}` counts for both). Strings are compared
  ignoring case. An assignment in `default` only leaks through calls that pass none of
  the labels.

  To confirm that a function writes into its caller's scope on purpose, add a comment
  naming the variables anywhere in its body (the file, or the `{...}` of a function
  defined in code):

  ```sqf
  TAG_fnc_handleKey = {
  	// sqf-private: shared _handled
  	if (_this == 0x12) then { _handled = true; };
  };
  ```

  Its assignments to those names are then no longer reported at all, neither as
  leaks nor as missing `private`. The quick fix *Mark '_name' as shared with the
  caller on purpose* on a scope leak inserts that comment; on an intentional-looking
  leak it is the preferred fix, and *Declare private* is not offered, since it would
  break what the caller relies on.
- **Several missions in one workspace** — a folder containing `description.ext` or
  `mission.sqm` is a mission, and each `.sqf` file belongs to the nearest one above it.
  A file with no such folder above it belongs to the nearest folder named like a
  mission, `missionName.terrainName` (as Arma requires), so partial missions without
  either file are kept apart too.
  Files of different missions never run together, so a `call` is only followed into
  functions of the caller's own mission (or files outside any mission, such as shared
  or addon code), and the duplicate-name and high risk checks only compare files that
  can meet. The same mission kept for several maps therefore does not report
  collisions or leaks between its copies.
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

## Diagnostics

Each diagnostic's code (shown as `sqf-private(code)` in the Problems view and the
hover) links to its section below.

### missing-private

A local variable is assigned without being declared `private`. If the file or
function is ever run with `call`, the assignment overwrites a variable of the same
name in the caller. Fix: declare it `private` (quick fix *Declare '_name' private*).

### duplicate-name

As `missing-private`, and the same name is also used as a local variable in another
file of the same mission, so the two could meet. Fix: declare it `private`.

### high-risk

The name is missing `private` in two or more files of the same mission, so neither
side has a scope of its own and they can overwrite each other. Fix: declare it
`private` in each of them.

### scope-leak

A confirmed leak: a function run with `call` assigns a variable without `private`,
and some caller up the call chain has a local variable of that name at the call, so
the function overwrites it. The calls are underlined too, with the details on hover.
The headline says how serious it is:

- `SCOPE LEAK` — the caller reads the variable afterwards, so this can break
  something today (`scopeLeakSeverity`, an error by default).
- `SCOPE LEAK (not read yet)` — nothing reads the overwritten value after the call,
  so it changes nothing yet (`unusedScopeLeakSeverity`, a warning by default).
- `SCOPE LEAK (same value)` — the function only assigns the value that the call
  passes in for it, so the caller's variable keeps its value
  (`unusedScopeLeakSeverity`).

Fix: declare the variable `private` in the function. If the function writes into its
caller's scope on purpose, confirm it instead with a `// sqf-private: shared _name`
comment in the function (quick fix *Mark '_name' as shared with the caller on
purpose*).

### scope-leak-intentional

A scope leak that looks deliberate: the caller does not use its value between
setting it and the call, and the function never reads back what it assigns, so the
assignment is a way of returning a value (`intentionalScopeLeakSeverity`,
information by default). If it is meant, confirm it with a
`// sqf-private: shared _name` comment in the function, which hides it; if not,
declare the variable `private` there.

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
| `sqfPrivateVariableChecker.severity` | `information` | Severity for a plain missing-private variable: `error`, `warning`, `information` or `hint` |
| `sqfPrivateVariableChecker.flagDuplicateLocalNames` | `true` | Cross-check non-private variables against every other `.sqf` file in the workspace |
| `sqfPrivateVariableChecker.duplicateNameSeverity` | `information` | Severity for a non-private variable whose name is also used in another file |
| `sqfPrivateVariableChecker.highRiskSeverity` | `warning` | Severity for a non-private variable whose name is missing `private` in two or more different files |
| `sqfPrivateVariableChecker.detectScopeLeaks` | `true` | Follow `call` chains across files and report assignments that overwrite a caller's local variable |
| `sqfPrivateVariableChecker.scopeLeakSeverity` | `error` | Severity for such a confirmed scope leak |
| `sqfPrivateVariableChecker.unusedScopeLeakSeverity` | `warning` | Severity for a confirmed scope leak whose overwritten variable is never read afterwards, or that only assigns the value the call passes in |
| `sqfPrivateVariableChecker.intentionalScopeLeakSeverity` | `information` | Severity for a confirmed scope leak that looks like a way of returning a value to the caller |
| `sqfPrivateVariableChecker.minimumSeverity` | `information` | Hide diagnostics below this severity, e.g. `warning` for warnings + errors, or `error` for errors only |
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
the high-risk case (`_speed`, missing private in two files at once). Run
`SQF: Check Workspace` with the `examples` folder open to see a scope leak:
`examples/sample4.sqf` calls `TAG_fnc_countNearby` (declared in
`examples/description.ext`), which overwrites its `_count`.

Source layout:

- `src/analyzer/tokenizer.ts` — SQF tokenizer (comments, strings, preprocessor)
- `src/analyzer/analyzer.ts` — per-file scope tracking and the missing-private rule,
  plus the file's `call` sites and `compile`d function definitions; free of VS Code APIs
- `src/analyzer/functionConfig.ts` — reads function names and paths from `CfgFunctions`
- `src/scopeLeaks.ts` — follows `call` chains across files to find assignments that
  overwrite a caller's local variable; also free of VS Code APIs
- `src/workspaceIndex.ts` — tracks which local variable names each scanned file uses,
  and which of those are missing `private` there, to power the cross-file
  duplicate-name and high-risk checks; also free of VS Code APIs
- `src/diagnostics.ts` — runs the analyzer per file, keeps the workspace index up to
  date, and turns the results into diagnostics for open documents and files on disk
- `src/callSiteMarks.ts` — underlines the calls through which scope leaks happen,
  without listing them in the Problems view
- `src/quickFix.ts` — the code actions that insert `private`, or the
  `// sqf-private: shared` comment
- `src/extension.ts` — activation, commands, document listeners
