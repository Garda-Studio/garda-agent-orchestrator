import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { lstatFileIdentitySync } from '../../core/file-stat';
import { countNextStepWork } from '../../core/next-step-measurement';
import { createInvocationReadMemoKey, inheritParentInvocationLeafMemo, isInvocationReadObservationActive, memoizeInvocationRead, registerInvocationDependency } from '../../core/invocation-read-observation';
import { observeDerivationInput, fingerprintObservationData, markDerivationNonCacheable } from '../../core/derivation-observation-recorder';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import { getWindowsNativeEnvironment, getWindowsSystemDirectory, WINDOWS_NATIVE_POWERSHELL_BOOTSTRAP } from '../../core/windows-native-environment';

const ACL_INSPECTION_TIMEOUT_MS = 1_000;
const ACL_INSPECTION_MAX_ATTEMPTS = 2;
// A cold Windows PowerShell start has been measured above 3.5s on hosted runners;
// a too-short budget fails closed and rejects every trusted timeline append.
const NATIVE_SID_LOOKUP_TIMEOUT_MS = 10_000;
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


const EXPLICIT_SIDS_EVIDENCE_SCRIPT = WINDOWS_NATIVE_POWERSHELL_BOOTSTRAP + [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$acl = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:GARDA_ACL_TARGET',
    "$trusted = @('S-1-5-18', 'S-1-5-32-544', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
    '$writeMask = 0x500D0156',
    '$trustedResult = $true',
    'foreach ($entry in $acl.Access) {',
    '    if ($entry.IsInherited -or $entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or',
    '        ($entry.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }',
    '    if (([long]$entry.FileSystemRights -band $writeMask) -eq 0) { continue }',
    '    $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value',
    '    if ($trusted -notcontains $sid) { $trustedResult = $false; break }',
    '}',
    'Microsoft.PowerShell.Utility\\ConvertTo-Json -InputObject @{ trusted = $trustedResult; descriptor = $acl.Sddl } -Compress'
].join('\n');

interface WindowsAclObjectIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mode: bigint;
    readonly birthtimeNs: bigint;
    readonly realPath: string;
}

interface WindowsAclObservation {
    readonly filePath: string;
    readonly identity: WindowsAclObjectIdentity;
    readonly outputSha256: string | null;
    readonly fallbackDescriptor: string | null;
    readonly principalWitness: string | null;
    readonly trusted: boolean;
}

const INVOCATION_ACL_OBSERVATIONS = createInvocationReadMemoKey<WindowsAclObservation>('windows-acl-observations');

function aclObjectIdentity(filePath: string): WindowsAclObjectIdentity {
    const stat = lstatFileIdentitySync(filePath, { bigint: true });
    return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode, birthtimeNs: stat.birthtimeNs,
        realPath: fs.realpathSync.native(filePath) });
}

function sameAclObject(left: WindowsAclObjectIdentity, right: WindowsAclObjectIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
        && left.birthtimeNs === right.birthtimeNs && left.realPath === right.realPath;
}

function inspectAclObservation(filePath: string, phase: 'initial' | 'final'): WindowsAclObservation {
    const identity = aclObjectIdentity(filePath);
    for (let attempt = 0; attempt < ACL_INSPECTION_MAX_ATTEMPTS; attempt += 1) {
        countNextStepWork('acl_probe:' + phase + ':' + filePath);
        const result = childProcess.spawnSync(path.join(getWindowsSystemDirectory(), 'icacls.exe'), [filePath], {
            maxBuffer: 256 * 1024, timeout: ACL_INSPECTION_TIMEOUT_MS, windowsHide: true
        });
        const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout || ''));
        const output = bytes.toString('utf8');
        if (result.status !== 0 || result.error || !output.split(/\r?\n/u).some(line => line.lastIndexOf(':(') >= 0)) continue;
        let trusted = !windowsAclOutputHasExplicitWriteGrant(output);
        let fallbackDescriptor: string | null = null;
        let principalWitness: string | null = null;
        if (!trusted) {
            const names = resolveTrustedPrincipalNames();
            principalWitness = captureFreshPrincipalWitness(names, phase);
            trusted = !!names && windowsAclOutputHasOnlyTrustedExplicitGrants(output, filePath, names);
            if (!trusted) {
                countNextStepWork('acl_sid_probe:' + phase + ':' + filePath);
                const evidence = inspectNativeSids(EXPLICIT_SIDS_EVIDENCE_SCRIPT, filePath);
                try {
                    const parsed: unknown = evidence ? JSON.parse(evidence) : null;
                    if (!parsed || typeof parsed !== 'object' || !('trusted' in parsed) || typeof parsed.trusted !== 'boolean'
                        || !('descriptor' in parsed) || typeof parsed.descriptor !== 'string' || !parsed.descriptor) {
                        throw new Error('Native ACL descriptor evidence is unavailable.');
                    }
                    trusted = parsed.trusted;
                    fallbackDescriptor = parsed.descriptor;
                } catch {
                    return Object.freeze({ filePath, identity, trusted: false, outputSha256: null, fallbackDescriptor: null, principalWitness: null });
                }
            }
        }
        if (!sameAclObject(identity, aclObjectIdentity(filePath))) throw new Error('Invocation Windows ACL object changed: ' + filePath);
        return Object.freeze({ filePath, identity, trusted, fallbackDescriptor, principalWitness,
            outputSha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return Object.freeze({ filePath, identity, trusted: false, outputSha256: null, fallbackDescriptor: null, principalWitness: null });
}

function inspectInvocationWindowsWriteAuthority(filePath: string): boolean {
    const absolute = path.resolve(filePath), memoId = absolute.toLowerCase();
    inheritParentInvocationLeafMemo(INVOCATION_ACL_OBSERVATIONS, memoId);
    const observation = memoizeInvocationRead(INVOCATION_ACL_OBSERVATIONS, memoId, () => {
        let environmentSha256: string | null = null;
        try { environmentSha256 = fingerprintObservationData(process.env); }
        catch { markDerivationNonCacheable('opaque-acl-environment'); }
        const original = observeDerivationInput('acl-verdict', 1, { path: absolute, platform: process.platform, environmentSha256 },
            () => inspectAclObservation(absolute, 'initial'), value => fingerprintObservationData({
                trusted: value.trusted, outputSha256: value.outputSha256, fallbackDescriptor: value.fallbackDescriptor, principalWitness: value.principalWitness,
                identity: { dev: String(value.identity.dev), ino: String(value.identity.ino), mode: String(value.identity.mode),
                    birthtimeNs: String(value.identity.birthtimeNs), realPath: value.identity.realPath }
            }), () => inspectAclObservation(absolute, 'final'));
        registerInvocationDependency(original, () => {
            if (environmentSha256 !== null && fingerprintObservationData(process.env) !== environmentSha256) throw new Error('Invocation Windows ACL environment changed.');
            const current = inspectAclObservation(original.filePath, 'final');
            // Unchanged indeterminate evidence retains the original fail-closed verdict.
            if (original.outputSha256 !== current.outputSha256
                || original.principalWitness !== current.principalWitness
                || original.fallbackDescriptor !== current.fallbackDescriptor
                || original.trusted !== current.trusted || !sameAclObject(original.identity, current.identity)) {
                throw new Error('Invocation Windows ACL observation changed: ' + original.filePath);
            }
        });
        return original;
    }).value;
    if (absolute !== observation.filePath && !sameAclObject(observation.identity, aclObjectIdentity(absolute))) {
        throw new Error('Invocation Windows ACL alias changed: ' + absolute);
    }
    return observation.trusted;
}

export function inspectTrustedWindowsWriteAuthority(filePath: string): boolean {
    if (isInvocationReadObservationActive()) return inspectInvocationWindowsWriteAuthority(filePath);
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

/** Preserve the native cached-name verdict, but never serialize it without fresh SID evidence. */
function captureFreshPrincipalWitness(cached: ReadonlySet<string> | null, phase: 'initial' | 'final'): string | null {
    countNextStepWork('acl_principal_probe:' + phase);
    const output = inspectNativeSids(TRUSTED_PRINCIPALS_SCRIPT);
    try {
        const names: unknown = output ? JSON.parse(output) : null;
        if (!Array.isArray(names) || names.length !== 6) throw new Error('Missing native principals.');
        const fresh = new Set<string>();
        for (const name of names) {
            countNextStepWork('visit:q4_acl_principal');
            if (typeof name !== 'string') throw new Error('Invalid native principal.');
            if (/^[\x20-\x7e]+$/u.test(name)) fresh.add(name.toLowerCase());
        }
        if (!cached || cached.size !== fresh.size) throw new Error('Cached principal binding differs.');
        for (const name of cached) {
            countNextStepWork('visit:q4_acl_cached_principal');
            if (!fresh.has(name)) throw new Error('Cached principal binding differs.');
        }
        return createHash('sha256').update(output!).digest('hex');
    } catch {
        markDerivationNonCacheable('acl-principal-fresh-witness-unavailable-or-different');
        return null;
    }
}
