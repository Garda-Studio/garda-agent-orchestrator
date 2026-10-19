# Focused Windows Release diagnosis

The manual CI workflow accepts `release_mode=windows-native` for the existing
Windows Release variants. The default remains full validation. The diagnostic
mode builds the normal node-foundation graph and probes only timeline DACL
inspection and managed process timeout under c8, including bounded native helper output.
Coverage thresholds and all-file collection are disabled only for this partial
diagnostic command; the full validation command and its coverage thresholds are unchanged.
This avoids repeating the entire failed Release suite to discover host details.
Authorization rejects this mode unless the exact Release job and Windows OS are selected.

The probe compares PATH and absolute System32 ACL inspection, invokes the actual
timeline reader, observes the unchanged production process terminator, and compiles
the same helper with empty process targets under both environments. It changes no
ACL and terminates only its own timed child through the production API. Its
temporary fixture is contained and removed after the probe.

Diagnostic runs skip the required `Validate release` step. They cannot satisfy
complete CI evidence, even when their job summary succeeds. The normal verifier
still requires that full step; the regression explicitly rejects diagnostic-only
Windows evidence. Authorization, commit/ref identity, matrix, required steps,
permissions and the remaining jobs retain their existing contracts.
