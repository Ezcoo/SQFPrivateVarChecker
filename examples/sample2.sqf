/*
 * A second scratch file, only here to demonstrate the cross-file duplicate-name
 * check: "_index" is declared private here, but examples/sample.sqf uses the
 * same name without private. Once both files are scanned, sample.sqf's "_index"
 * is reported as a duplicate-name collision instead of a plain missing-private
 * warning.
 */
private _index = 0;
hint str _index;
