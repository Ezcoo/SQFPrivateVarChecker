/*
 * A fourth scratch file, only here to demonstrate the scope leak check:
 * TAG_fnc_countNearby (examples/functions/demo/fn_countNearby.sqf) assigns "_count"
 * without private, and since call runs it inside this scope, it silently
 * overwrites the "_count" below. The call and the assignment are both reported.
 */
private _count = 0;
private _nearby = [player] call TAG_fnc_countNearby;
hint format ["%1 / %2", _count, _nearby];
