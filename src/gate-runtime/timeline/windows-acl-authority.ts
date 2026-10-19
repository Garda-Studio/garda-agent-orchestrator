import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import { getWindowsNativeEnvironment, getWindowsSystemDirectory, WINDOWS_NATIVE_POWERSHELL_BOOTSTRAP } from '../../core/windows-native-environment';

const ACL_INSPECTION_TIMEOUT_MS = 1_000;
const ACL_INSPECTION_MAX_ATTEMPTS = 2;
const NATIVE_SID_LOOKUP_TIMEOUT_MS = 2_500;
let trustedPrincipalNames: ReadonlySet<string> | null = null;

const TRUSTED_PRINCIPALS_SCRIPT = WINDOWS_NATIVE_POWERSHELL_BOOTSTRAP + `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$names = @($identity.Name, $identity.User.Value, 'S-1-5-18', 'S-1-5-32-544',
    ([Security.Principal.SecurityIdentifier]'S-1-5-18').Translate([Security.Principal.NTAccount]).Value,
    ([Security.Principal.SecurityIdentifier]'S-1-5-32-544').Translate([Security.Principal.NTAccount]).Value)
Microsoft.PowerShell.Utility\\ConvertTo-Json -InputObject $names -Compress
`;

const EXPLICIT_SIDS_SCRIPT = WINDOWS_NATIVE_POWERSHELL_BOOTSTRAP + `
$ErrorActionPreference = 'Stop'
$acl = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:GARDA_ACL_TARGET
$trusted = @('S-1-5-18', 'S-1-5-32-544', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
# Write/data/attributes, delete, DACL/owner changes, and generic write/all.
$writeMask = 0x500D0156
foreach ($entry in $acl.Access) {
    if ($entry.IsInherited -or $entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        ($entry.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if (([long]$entry.FileSystemRights -band $writeMask) -eq 0) { continue }
    $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($trusted -notcontains $sid) { 'untrusted'; exit 0 }
}
'trusted'
`;

function explicitWritablePrefixes(output: string): string[] {
    const prefixes: string[] = [];
    for (const line of String(output || '').split(/\r?\n/u)) {
        const start = line.lastIndexOf(':(');
        if (start < 0) continue;
        const ace = line.slice(start + 1).toUpperCase();
        if (ace.includes('(DENY)') || ace.includes('(IO)') || ace.includes('(I)')) continue;
        if (/(?:\(|,)(?:F|M|W|GA|GW|WD|AD|WEA|WA|DC|D|WO|WDAC)(?=[,)])/u.test(ace)) {
            prefixes.push(line.slice(0, start));
        }
    }
    return prefixes;
}

export function windowsAclOutputHasExplicitWriteGrant(output: string): boolean {
    return explicitWritablePrefixes(output).length > 0;
}

export function windowsAclOutputHasOnlyTrustedExplicitGrants(
    output: string, filePath: string, trustedNames: ReadonlySet<string>
): boolean {
    const prefixes = explicitWritablePrefixes(output);
    const filePrefix = filePath + ' ';
    const indentation = ' '.repeat(filePrefix.length);
    return prefixes.length > 0 && prefixes.every(prefix => {
        const principal = prefix.toLowerCase().startsWith(filePrefix.toLowerCase()) || prefix.startsWith(indentation)
            ? prefix.slice(filePrefix.length) : '';
        // Lossy native-codepage decoding cannot establish account identity. Resolve SIDs instead.
        return /^[\x20-\x7e]+$/u.test(principal) && trustedNames.has(principal.toLowerCase());
    });
}

function inspectNativeSids(script: string, filePath?: string): string | null {
    try {
        const environment = getWindowsNativeEnvironment();
        if (filePath) environment.GARDA_ACL_TARGET = filePath;
        const result = childProcess.spawnSync(
            path.join(getWindowsSystemDirectory(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { env: environment, encoding: 'utf8', windowsHide: true, timeout: NATIVE_SID_LOOKUP_TIMEOUT_MS, maxBuffer: 256 * 1024 }
        );
        return result.status === 0 && !result.error ? String(result.stdout || '').trim() : null;
    } catch {
        return null;
    }
}

function resolveTrustedPrincipalNames(): ReadonlySet<string> | null {
    if (trustedPrincipalNames) return trustedPrincipalNames;
    const output = inspectNativeSids(TRUSTED_PRINCIPALS_SCRIPT);
    if (!output) return null;
    try {
        const names: unknown = JSON.parse(output);
        if (!Array.isArray(names) || names.length !== 6 || names.some(name => typeof name !== 'string')) return null;
        trustedPrincipalNames = new Set(names.filter(name => /^[\x20-\x7e]+$/u.test(name)).map(name => name.toLowerCase()));
        return trustedPrincipalNames;
    } catch {
        return null;
    }
}

export function inspectTrustedWindowsWriteAuthority(filePath: string): boolean {
    for (let attempt = 0; attempt < ACL_INSPECTION_MAX_ATTEMPTS; attempt += 1) {
        const result = childProcess.spawnSync(path.join(getWindowsSystemDirectory(), 'icacls.exe'), [filePath], {
            encoding: 'utf8', maxBuffer: 256 * 1024, timeout: ACL_INSPECTION_TIMEOUT_MS, windowsHide: true
        });
        const output = String(result.stdout || '');
        if (result.status !== 0 || result.error || !output.split(/\r?\n/u).some(line => line.lastIndexOf(':(') >= 0)) continue;
        if (!windowsAclOutputHasExplicitWriteGrant(output)) return true;
        const names = resolveTrustedPrincipalNames();
        if (names && windowsAclOutputHasOnlyTrustedExplicitGrants(output, filePath, names)) return true;
        return inspectNativeSids(EXPLICIT_SIDS_SCRIPT, filePath) === 'trusted';
    }
    return false;
}
