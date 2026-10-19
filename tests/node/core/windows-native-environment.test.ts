import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getWindowsNativeEnvironment } from '../../../src/core/windows-native-environment';

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
        assert.equal(actual.PSModulePath, path.join(powershell, 'Modules'));
        assert.equal(names.some(name => actual[name]?.includes('attacker-controlled-')), false);
    } finally {
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    }
});
