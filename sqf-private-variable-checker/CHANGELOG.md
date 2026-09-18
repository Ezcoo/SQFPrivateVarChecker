# Change Log

## [0.0.1]

- Initial release.
- Live diagnostics for local variables assigned without a `private` declaration in `.sqf` files.
- Recursive workspace scan with progress reporting and an output-channel summary.
- Quick fixes to insert the missing `private` keyword, singly or for a whole file.
- Settings for severity, include/exclude globs, on-type checking, and the treatment of
  `params`, `for` loop counters and extra magic variables.
