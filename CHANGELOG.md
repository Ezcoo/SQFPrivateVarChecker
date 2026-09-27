# Changelog

## [Unreleased]

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
