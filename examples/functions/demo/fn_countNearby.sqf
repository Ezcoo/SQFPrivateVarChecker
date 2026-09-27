/*
 * TAG_fnc_countNearby, registered in examples/description.ext.
 * "_count" is not declared private, and examples/sample4.sqf already has a "_count"
 * where it calls this function, so the assignment below overwrites the caller's
 * variable: reported as a scope leak here, and at the call in sample4.sqf.
 */
params ["_center"];

_count = {_x distance _center < 100} count allUnits;
_count
