# Changelog

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
