/*
 * A third scratch file, only here to demonstrate the "ultra high risk" check:
 * "_speed" is missing private here too, just like in examples/sample.sqf. Since
 * *neither* occurrence has a private scope, they can silently read or overwrite each
 * other's value -- worse than a plain duplicate-name collision, where only one side
 * needs to be missing private. Once both files are scanned, both "_speed"
 * assignments are reported as ultra-high-risk (error by default).
 */
_speed = 0;
hint str _speed;
