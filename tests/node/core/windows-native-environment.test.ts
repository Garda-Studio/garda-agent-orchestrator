import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { getWindowsNativeEnvironment, getWindowsSystemDirectory, WINDOWS_NATIVE_POWERSHELL_BOOTSTRAP } from '../../../src/core/windows-native-environment';

test('Windows native helpers ignore poisoned profile tool and module environment', {
    skip: process.platform !== 'win32' ? 'Windows native environment is unavailable.' : false
}, () => {
    const names = ['SystemRoot', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATH', 'PSModulePath', 'COMSPEC'];
    const saved = new Map(names.map(name => [name, process.env[name]]));
    const system32 = path.join(fs.realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot'), 'System32');
    const profile = fs.realpathSync.native(os.userInfo().homedir);
    try {
        for (const name of names) process.env[name] = 'attacker-controlled-' + name;
        const actual = getWindowsNativeEnvironment();
        assert.equal(actual.SystemRoot, path.dirname(system32));
        assert.equal(actual.WINDIR, path.dirname(system32));
        assert.equal(actual.USERPROFILE, profile);
        assert.equal(actual.LOCALAPPDATA, path.join(profile, 'AppData', 'Local'));
        assert.equal(actual.APPDATA, path.join(profile, 'AppData', 'Roaming'));
        assert.equal(actual.COMSPEC, path.join(system32, 'cmd.exe'));
        const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0');
        assert.deepEqual(actual.PATH?.split(path.delimiter), [system32, powershell]);
        assert.equal(actual.PSModulePath, powershell);
        assert.equal(names.some(name => actual[name]?.includes('attacker-controlled-')), false);
    } finally {
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    }
});

test('Windows helpers import native manifests without automatic module discovery', {
    skip: process.platform !== 'win32' ? 'Windows PowerShell is unavailable.' : false
}, () => {
    const script = WINDOWS_NATIVE_POWERSHELL_BOOTSTRAP + `
Microsoft.PowerShell.Utility\\Add-Type -TypeDefinition 'public static class NativeModuleProbe { public static int Value() { return 7; } }'
$utility = (Microsoft.PowerShell.Core\\Get-Command Add-Type).Module.Path
$security = (Microsoft.PowerShell.Core\\Get-Command Get-Acl).Module.Path
$valid = [NativeModuleProbe]::Value() -eq 7 -and $PSModuleAutoLoadingPreference -eq 'None' -and $env:PSModulePath -eq $PSHOME
$valid = $valid -and $utility.StartsWith($PSHOME, [StringComparison]::OrdinalIgnoreCase) -and $security.StartsWith($PSHOME, [StringComparison]::OrdinalIgnoreCase)
if (-not $valid) { throw 'Native module authority changed' }
[Console]::WriteLine('native-only')
`;
    const result = childProcess.spawnSync(
        path.join(getWindowsSystemDirectory(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { env: getWindowsNativeEnvironment(), encoding: 'utf8', windowsHide: true, timeout: 2_500, maxBuffer: 256 * 1024 }
    );
    assert.equal(result.status, 0, String(result.error || result.stderr));
    assert.equal(result.stdout.trim(), 'native-only');
});
