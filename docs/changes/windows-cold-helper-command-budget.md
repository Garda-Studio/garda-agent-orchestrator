# Windows cold helper command budget

The hosted Node 24 trace showed two interrupted native helper starts. The root's
actual creation time was inside the original admitted window. A read-only
diagnostic query between those starts also consumed time needed by the retry.

The asynchronous path now pools its previous two 2500 ms command slices into one
command allowance of at most 5000 ms. Every attempt still uses the remaining
shared 6000 ms shutdown deadline; at most two attempts are possible. This lets a
cold compiler complete once instead of discarding its work after 2500 ms. A
delayed-helper regression fails before the repair and requires one successful
command, nonzero child termination and no PID-only kill afterwards.

The native implementation, root creation-window admission, held handles,
descendant instance checks, protected environment and synchronous exit cleanup's
2500 ms cap are unchanged. The overall asynchronous shutdown budget is unchanged.

Diagnostic creation-time queries now run only after a successful helper reports
zero admitted processes. Timeout/error callbacks reach production immediately;
diagnostic queries cannot consume their retry deadline.

The UI fixture's survival marker follows its existing three-second command plus
six-second cleanup budget and one-second scheduling margin. It still requires
timedOut, nonzero exit, completion before that bound, descendant exit and no marker.
The old six-second absolute marker ran before the allowed cleanup deadline.

Full Windows Release acceptance remains outstanding. The next hosted diagnosis
targets only unresolved Node 24 cases; the successful Node 22 diagnosis is retained.
