/*
 * Scratch file for trying the checker out.
 * Expected: _speed and _nearby are reported as missing-private.
 * _index is also missing private, and since examples/sample2.sqf uses the same
 * name, it is reported as a duplicate-name collision (error by default) instead
 * of a plain missing-private warning once both files have been scanned (opening
 * both, or running "SQF: Check Workspace", is enough).
 */
params ["_unit", ["_radius", 50]];

private _position = getPosATL _unit;
_speed = speed _unit;                       // not declared private

{
    private _distance = _x distance _unit;  // _x is engine supplied
    if (_distance < _radius) then {
        _nearby = _x;                       // not declared private
    };
} forEach allUnits;

for "_i" from 0 to 10 do {
    _position set [2, _i];
};

_index = 0;                                 // not declared private, and reused in sample2.sqf
hint format ["%1 at %2 (index %3)", _unit, _position, _index];
