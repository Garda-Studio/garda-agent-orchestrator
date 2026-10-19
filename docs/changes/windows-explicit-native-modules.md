# Explicit native PowerShell modules

Hosted environment experiments isolated module discovery: the production helper
timed out after ten seconds with its constructed module search path, while
replacing only `PSModulePath` compiled the same empty-target script in 334 ms.
The first protected-profile environment repair therefore did not close the
hosted process-termination defect.

Native helpers now use the protected PowerShell home as the initial search path.
Their shared bootstrap disables automatic module discovery, fixes the effective
path again and imports Utility and Security manifests by absolute paths beneath
the native `$PSHOME`. The process helper qualifies Add-Type to the imported
Utility module. No inherited module path, user module or runner environment is
admitted as authority.

This avoids depending on PowerShell's startup reconstruction and autoloading.
Microsoft documents that a PSHOME Modules search entry can cause additional
AllUsers paths to be inserted during startup; explicit native imports avoid
using that reconstructed search list:
[about_PSModulePath](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath).

The C# process implementation, handles, PID creation windows, target admission,
shutdown budgets and ACL SID rules remain unchanged. A native integration check
compiles C#, verifies automatic loading is disabled and confirms both cmdlets
originate beneath the protected PowerShell home within the existing 2500 ms
budget. Hosted diagnosis and full Windows Release acceptance remain separate.
