/*
 * Scratch file for trying the checker out.
 * Expected: only _speed and _nearby are reported.
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

hint format ["%1 at %2", _unit, _position];
