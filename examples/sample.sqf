/*
 * Scratch file for trying the checker out.
 * Expected once only this file is open: _speed, _nearby and _index are all
 * reported as plain missing-private warnings.
 * Once examples/sample2.sqf and examples/sample3.sqf are also scanned (open both,
 * or run "SQF: Check Workspace"):
 *  - _index becomes a duplicate-name collision (error by default): sample2.sqf
 *    uses the same name, but declares it private there.
 *  - _speed becomes ultra high risk (error by default, and more severe than a
 *    plain duplicate-name): sample3.sqf uses the same name *without* private too,
 *    so neither occurrence has any scope protecting it from the other.
 */
params ["_unit", ["_radius", 50]];

private _position = getPosATL _unit;
_speed = speed _unit;                       // not declared private, also missing in sample3.sqf

{
    private _distance = _x distance _unit;  // _x is engine supplied
    if (_distance < _radius) then {
        _nearby = _x;                       // not declared private
    };
} forEach allUnits;

for "_i" from 0 to 10 do {
    _position set [2, _i];
};

_index = 0;                                 // not declared private, and reused (private) in sample2.sqf
hint format ["%1 at %2 (index %3)", _unit, _position, _index];
