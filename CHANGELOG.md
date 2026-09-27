# Changelog

## [Unreleased]

- Several missions in one workspace are kept apart: a folder with `description.ext`
  or `mission.sqm` is a mission (failing that, the nearest folder named like one,
  `missionName.terrainName`), calls are only followed into functions of the
  caller's own mission (or code outside any mission), and the duplicate-name and high
  risk checks only compare files of the same mission (or shared code).
- Functions defined as `anyName = compileFinal {...}` or
  `missionNamespace setVariable ["anyName", {...}]` (also with `compileFinal`, and
  with further arguments) are followed too.

- Functions defined as a code block, `anyName = {...};` (any name, any number per
  file), are now followed by scope leak detection: calls to them run that block, so
  leaks from them into their callers are reported, and a later call to one of them
  counts as reading what its body reads.

- `call compile "..."` and `call compile format ["...", ...]` with the code written in
  place are no longer calls that "cannot be followed", which kept every scope leak
  before such a call an error. The locals the string mentions count as read; a
  `format` placeholder that could start a variable name of its own (`"%1 = 5"`) still
  counts as unknown code.

- A scope leak into a caller's variable that is not declared `private` either is no
  longer always an error: the calls that run the caller are followed up in turn, and
  it is an error only if one of them reads the variable afterwards. A file that is
  only run by `execVM`, `spawn` or an event handler takes its variables with it.
- Code given directly to an event handler command (`addPublicVariableEventHandler`,
  `onPlayerConnected`, `onPlayerDisconnected`, `onMapSingleClick`, `onPreloadStarted`,
  `onPreloadFinished`, `onTeamSwitch`, `onCommandModeChanged`,
  `onHCGroupSelectionChanged`, `onGroupIconClick`, `onGroupIconOverEnter`,
  `onGroupIconOverLeave`) now counts as running in a scope of its own, like `spawn`.
  Its assignments no longer show up as scope leaks into the caller, and calls made in
  it no longer see the enclosing script's variables.

## [0.3.1]

- Scope leaks whose overwritten variable is never read afterwards (by the caller, by
  anything it calls later, or by the functions in between on the call chain) are now
  reported with the new `unusedScopeLeakSeverity` setting, `warning` by default,
  instead of as errors. When that cannot be ruled out (for example the variable is
  read in an enclosing loop, or a later call cannot be followed), it stays an error.

## [0.3.0]

- Scope leak detection: follows `call` chains across files, any number of calls
  deep, and reports a non-private assignment in a called function that overwrites a
  local variable existing where the call is made, both at the assignment and at the
  call (`detectScopeLeaks`, `scopeLeakSeverity`, defaulting to `error`). Functions are
  resolved from `CfgFunctions` in `description.ext` / `CfgFunctions.hpp`, from
  `anyName = compile preprocessFileLineNumbers "file.sqf"` definitions (any name), and from
  `call compile preprocessFileLineNumbers "file.sqf"`, and local variables holding a
  code block or a compiled file (`private _fnc = {...}; call _fnc`) when assigned
  exactly once in the file.
- Renamed the "ultra high risk" check to "high risk": the `ultraHighRiskSeverity`
  setting is now `highRiskSeverity` (the old name is still honoured when the new one
  is not set), and the diagnostic code is now `high-risk`.
- Now that confirmed scope leaks are reported as errors, the checks that only flag
  *possible* problems are less severe by default: high risk (`highRiskSeverity`) is
  now `warning` (previously `error`), and both duplicate-name
  (`duplicateNameSeverity`, previously `error`) and plain missing-private
  (`severity`, previously `warning`) are now `information`. `minimumSeverity` now
  defaults to `information` (previously `hint`), so all of these still show.
  An existing explicit `minimumSeverity` other than `information` in the user
  settings is removed once on upgrade, so nothing stays hidden by an older value;
  changing it afterwards is respected. Workspace and folder settings are not touched.

## [0.2.0]

- High-risk detection: a non-private local variable whose name is missing
  `private` in *two or more* different files (not just one) is now reported with its
  own, even stronger severity (`ultraHighRiskSeverity`, defaulting to `error`) than a
  plain duplicate-name collision, since none of those occurrences has private scope
  protecting it.

## [0.1.0]

- Cross-file duplicate-name check: a non-private local variable whose name is also
  used as a local variable in a *different* `.sqf` file in the workspace is now
  reported separately, with its own severity (`duplicateNameSeverity`, defaulting to
  `error`), since the missing `private` can let it collide with the other file's
  variable. Variables reused within the same file are not affected. Can be disabled
  with `flagDuplicateLocalNames`.
- `minimumSeverity` setting to filter diagnostics by severity (e.g. `warning` for
  warnings + errors, `error` for errors only), applied in both the Problems panel and
  workspace scan summaries.

## [0.0.1]

- Initial release.
- Live diagnostics for local variables assigned without a `private` declaration in `.sqf` files.
- Recursive workspace scan with progress reporting and an output-channel summary.
- Quick fixes to insert the missing `private` keyword, singly or for a whole file.
- Settings for severity, include/exclude globs, on-type checking, and the treatment of
  `params`, `for` loop counters and extra magic variables.
