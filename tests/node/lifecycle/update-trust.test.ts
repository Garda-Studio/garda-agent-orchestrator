import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    assertExplicitCliTrustOverride,
    buildReleaseUpdateProvenance,
    TRUST_OVERRIDE_ENV_VAR,
    TRUSTED_GIT_REPO_URLS,
    TRUSTED_NPM_PACKAGE_NAMES,
    isGitRepoUrlTrusted,
    isNpmPackageSpecTrusted,
    isTrustOverrideActive,
    normalizeGitUrl,
    parseNpmPackageSpec,
    resolveTrustOverrideSource,
    validateGitSourceTrust,
    validateNpmSourceTrust,
    validatePathSourceTrust
} from '../../../src/lifecycle/update-trust';

import { runCheckUpdate } from '../../../src/lifecycle/check-update';
import { removePathRecursive } from '../../../src/lifecycle/common';

// ── Helpers ────────────────────────────────────────────────────────────

function findRepoRoot() {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'template'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

function setupCheckUpdateWorkspace(deployedVersion: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-trust-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'VERSION'), deployedVersion || '1.0.0');
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    return { projectRoot: tmpDir, bundleRoot: bundle };
}

// ── normalizeGitUrl ────────────────────────────────────────────────────

describe('normalizeGitUrl', () => {
    it('strips trailing slashes and .git suffix, lowercases', () => {
        assert.equal(
            normalizeGitUrl('https://github.com/Garda-Studio/garda-agent-orchestrator.git/'),
            'https://github.com/garda-studio/garda-agent-orchestrator'
        );
    });

    it('handles URL without .git suffix', () => {
        assert.equal(
            normalizeGitUrl('https://github.com/Garda-Studio/garda-agent-orchestrator'),
            'https://github.com/garda-studio/garda-agent-orchestrator'
        );
    });

    it('normalises case', () => {
        assert.equal(
            normalizeGitUrl('HTTPS://GitHub.com/GARDA-STUDIO/GARDA-AGENT-ORCHESTRATOR.GIT'),
            'https://github.com/garda-studio/garda-agent-orchestrator'
        );
    });
});

// ── parseNpmPackageSpec ────────────────────────────────────────────────

describe('parseNpmPackageSpec', () => {
    it('parses bare package name', () => {
        assert.deepEqual(parseNpmPackageSpec('garda-agent-orchestrator'), {
            name: 'garda-agent-orchestrator',
            version: null
        });
    });

    it('parses name@version', () => {
        assert.deepEqual(parseNpmPackageSpec('garda-agent-orchestrator@2.0.0'), {
            name: 'garda-agent-orchestrator',
            version: '2.0.0'
        });
    });

    it('parses name@latest', () => {
        assert.deepEqual(parseNpmPackageSpec('garda-agent-orchestrator@latest'), {
            name: 'garda-agent-orchestrator',
            version: 'latest'
        });
    });

    it('parses scoped package name', () => {
        assert.deepEqual(parseNpmPackageSpec('@scope/pkg'), {
            name: '@scope/pkg',
            version: null
        });
    });

    it('parses scoped package with version', () => {
        assert.deepEqual(parseNpmPackageSpec('@scope/pkg@1.0.0'), {
            name: '@scope/pkg',
            version: '1.0.0'
        });
    });

    it('returns null for Unix absolute paths', () => {
        assert.equal(parseNpmPackageSpec('/usr/local/lib/pkg'), null);
    });

    it('returns null for relative paths', () => {
        assert.equal(parseNpmPackageSpec('./local/pkg'), null);
        assert.equal(parseNpmPackageSpec('../parent/pkg'), null);
    });

    it('returns null for Windows absolute paths', () => {
        assert.equal(parseNpmPackageSpec('C:\\Users\\pkg'), null);
        assert.equal(parseNpmPackageSpec('D:/Projects/pkg'), null);
    });

    it('returns null for file: protocol', () => {
        assert.equal(parseNpmPackageSpec('file:../foo'), null);
    });

    it('returns null for git: protocol', () => {
        assert.equal(parseNpmPackageSpec('git://github.com/user/repo'), null);
    });

    it('returns null for tarballs', () => {
        assert.equal(parseNpmPackageSpec('package-1.0.0.tgz'), null);
        assert.equal(parseNpmPackageSpec('package-1.0.0.tar.gz'), null);
    });

    it('returns null for empty or falsy input', () => {
        assert.equal(parseNpmPackageSpec(''), null);
        assert.equal(parseNpmPackageSpec(null as unknown as string), null);
        assert.equal(parseNpmPackageSpec(undefined as unknown as string), null);
    });
});

// ── isGitRepoUrlTrusted ────────────────────────────────────────────────

describe('isGitRepoUrlTrusted', () => {
    it('accepts the canonical trusted URL with .git suffix', () => {
        assert.equal(isGitRepoUrlTrusted('https://github.com/Garda-Studio/garda-agent-orchestrator.git'), true);
    });

    it('accepts the canonical trusted URL without .git suffix', () => {
        assert.equal(isGitRepoUrlTrusted('https://github.com/Garda-Studio/garda-agent-orchestrator'), true);
    });

    it('accepts case-insensitive variations', () => {
        assert.equal(isGitRepoUrlTrusted('HTTPS://GITHUB.COM/GARDA-STUDIO/GARDA-AGENT-ORCHESTRATOR.GIT'), true);
    });

    it('accepts with trailing slash', () => {
        assert.equal(isGitRepoUrlTrusted('https://github.com/Garda-Studio/garda-agent-orchestrator/'), true);
    });

    it('rejects a different GitHub user', () => {
        assert.equal(isGitRepoUrlTrusted('https://github.com/attacker/garda-agent-orchestrator.git'), false);
    });

    it('rejects a different repo name', () => {
        assert.equal(isGitRepoUrlTrusted('https://github.com/Shubchynskyi/evil-repo.git'), false);
    });

    it('rejects file:// protocol', () => {
        assert.equal(isGitRepoUrlTrusted('file:///tmp/local-repo'), false);
    });

    it('rejects arbitrary URLs', () => {
        assert.equal(isGitRepoUrlTrusted('https://evil.com/repo.git'), false);
    });
});

// ── isNpmPackageSpecTrusted ────────────────────────────────────────────

describe('isNpmPackageSpecTrusted', () => {
    it('accepts the trusted package name', () => {
        assert.equal(isNpmPackageSpecTrusted('garda-agent-orchestrator'), true);
    });

    it('accepts the trusted package with @latest', () => {
        assert.equal(isNpmPackageSpecTrusted('garda-agent-orchestrator@latest'), true);
    });

    it('accepts the trusted package with exact version', () => {
        assert.equal(isNpmPackageSpecTrusted('garda-agent-orchestrator@2.0.0'), true);
    });

    it('accepts case-insensitive package name', () => {
        assert.equal(isNpmPackageSpecTrusted('Garda-Agent-Orchestrator@1.0.0'), true);
    });

    it('rejects an untrusted package name', () => {
        assert.equal(isNpmPackageSpecTrusted('evil-package@latest'), false);
    });

    it('rejects a local path spec', () => {
        assert.equal(isNpmPackageSpecTrusted('/some/local/path'), false);
    });

    it('rejects a file: spec', () => {
        assert.equal(isNpmPackageSpecTrusted('file:../foo'), false);
    });

    it('rejects a tarball spec', () => {
        assert.equal(isNpmPackageSpecTrusted('evil-1.0.0.tgz'), false);
    });
});

// ── isTrustOverrideActive ──────────────────────────────────────────────

describe('isTrustOverrideActive', () => {
    const savedEnv = process.env[TRUST_OVERRIDE_ENV_VAR];
    const savedNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
        if (savedEnv === undefined) {
            delete process.env[TRUST_OVERRIDE_ENV_VAR];
        } else {
            process.env[TRUST_OVERRIDE_ENV_VAR] = savedEnv;
        }
        if (savedNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = savedNodeEnv;
        }
    });

    it('returns true when options.trustOverride is true', () => {
        delete process.env[TRUST_OVERRIDE_ENV_VAR];
        assert.equal(isTrustOverrideActive({ trustOverride: true }), true);
    });

    it('returns false when options.trustOverride is false and env not set', () => {
        delete process.env[TRUST_OVERRIDE_ENV_VAR];
        assert.equal(isTrustOverrideActive({ trustOverride: false }), false);
    });

    it('ignores env override by default in ordinary runtime flows', () => {
        process.env[TRUST_OVERRIDE_ENV_VAR] = '1';
        process.env.NODE_ENV = 'test';
        assert.equal(isTrustOverrideActive({}), false);
    });

    it('allows env override only in explicit test-only paths', () => {
        process.env[TRUST_OVERRIDE_ENV_VAR] = 'true';
        process.env.NODE_ENV = 'test';
        assert.equal(isTrustOverrideActive({ allowEnvTrustOverride: true }), true);
        assert.equal(resolveTrustOverrideSource({ allowEnvTrustOverride: true }), 'env-test-only');
    });

    it('rejects env override outside test runtime even when explicitly enabled', () => {
        process.env[TRUST_OVERRIDE_ENV_VAR] = 'yes';
        process.env.NODE_ENV = 'development';
        assert.equal(isTrustOverrideActive({ allowEnvTrustOverride: true }), false);
    });

    it('returns false when env is "0"', () => {
        process.env[TRUST_OVERRIDE_ENV_VAR] = '0';
        process.env.NODE_ENV = 'test';
        assert.equal(isTrustOverrideActive({ allowEnvTrustOverride: true }), false);
    });

    it('returns false when env is empty', () => {
        process.env[TRUST_OVERRIDE_ENV_VAR] = '';
        process.env.NODE_ENV = 'test';
        assert.equal(isTrustOverrideActive({ allowEnvTrustOverride: true }), false);
    });

    it('returns false with no options and no env', () => {
        delete process.env[TRUST_OVERRIDE_ENV_VAR];
        assert.equal(isTrustOverrideActive(null), false);
    });
});

describe('assertExplicitCliTrustOverride', () => {
    it('allows ordinary trusted-mode calls without noPrompt', () => {
        assert.doesNotThrow(() => {
            assertExplicitCliTrustOverride('update', {
                trustOverride: false,
                noPrompt: false
            });
        });
    });

    it('rejects trust override without noPrompt', () => {
        assert.throws(
            () => assertExplicitCliTrustOverride('check-update', {
                trustOverride: true,
                noPrompt: false
            }),
            /--trust-override.*--no-prompt/
        );
    });

    it('accepts trust override with noPrompt', () => {
        assert.doesNotThrow(() => {
            assertExplicitCliTrustOverride('update git', {
                trustOverride: true,
                noPrompt: true
            });
        });
    });
});

describe('buildReleaseUpdateProvenance', () => {
    it('marks npm registry integrity as preferred release provenance', () => {
        const provenance = buildReleaseUpdateProvenance({
            sourceType: 'npm',
            sourceReference: 'garda-agent-orchestrator@2.0.0',
            trustPolicy: 'enforced',
            trustOverrideUsed: false,
            requestedPackageSpec: 'garda-agent-orchestrator@latest',
            exactPackageSpec: 'garda-agent-orchestrator@2.0.0',
            resolvedPackageVersion: '2.0.0',
            resolvedPackageIntegrity: 'sha512-registry'
        });

        assert.equal(provenance.releaseProvenanceStatus, 'NPM_REGISTRY_INTEGRITY_RECORDED');
        assert.match(provenance.releaseProvenanceSummary, /registry integrity/);
        assert.match(provenance.releaseProvenanceRecommendation, /Preferred release update path/);
    });

    it('marks trusted npm sources without integrity as missing registry integrity', () => {
        const provenance = buildReleaseUpdateProvenance({
            sourceType: 'npm',
            sourceReference: 'garda-agent-orchestrator@latest',
            trustPolicy: 'enforced',
            trustOverrideUsed: false,
            requestedPackageSpec: 'garda-agent-orchestrator@latest',
            exactPackageSpec: 'garda-agent-orchestrator@latest',
            resolvedPackageVersion: null,
            resolvedPackageIntegrity: null
        });

        assert.equal(provenance.releaseProvenanceStatus, 'NPM_REGISTRY_INTEGRITY_MISSING');
        assert.match(provenance.releaseProvenanceSummary, /did not expose registry integrity/);
        assert.match(provenance.releaseProvenanceRecommendation, /exact registry package version with integrity/);
    });

    it('marks trusted git updates as no-signature provenance with dry-run recommendation', () => {
        const provenance = buildReleaseUpdateProvenance({
            sourceType: 'git',
            sourceReference: 'https://github.com/Garda-Studio/garda-agent-orchestrator.git#dev',
            trustPolicy: 'enforced',
            trustOverrideUsed: false
        });

        assert.equal(provenance.releaseProvenanceStatus, 'TRUSTED_GIT_NO_RELEASE_SIGNATURE');
        assert.match(provenance.releaseProvenanceSummary, /no release signature/i);
        assert.match(provenance.releaseProvenanceRecommendation, /--check-only|--dry-run/);
    });

    it('marks trust override updates as unverified', () => {
        const provenance = buildReleaseUpdateProvenance({
            sourceType: 'path',
            sourceReference: '/local/source',
            trustPolicy: 'overridden',
            trustOverrideUsed: true
        });

        assert.equal(provenance.releaseProvenanceStatus, 'TRUST_OVERRIDE_UNVERIFIED');
        assert.match(provenance.releaseProvenanceSummary, /Operator override/);
    });

    it('marks local source updates without registry or signature evidence as unverified', () => {
        const provenance = buildReleaseUpdateProvenance({
            sourceType: 'path',
            sourceReference: '/local/source',
            trustPolicy: 'enforced',
            trustOverrideUsed: false
        });

        assert.equal(provenance.releaseProvenanceStatus, 'LOCAL_SOURCE_UNVERIFIED');
        assert.match(provenance.releaseProvenanceSummary, /no registry integrity or release signature provenance/);
        assert.match(provenance.releaseProvenanceRecommendation, /development\/testing/);
    });
});

// ── validateGitSourceTrust ─────────────────────────────────────────────

describe('validateGitSourceTrust', () => {
    it('returns enforced policy for trusted repo URL', () => {
        const result = validateGitSourceTrust(
            'https://github.com/Garda-Studio/garda-agent-orchestrator.git',
            { trustOverride: false }
        );
        assert.equal(result.trusted, true);
        assert.equal(result.overridden, false);
        assert.equal(result.policy, 'enforced');
        assert.equal(result.overrideSource, null);
    });

    it('throws for untrusted repo URL without override', () => {
        assert.throws(
            () => validateGitSourceTrust('https://evil.com/repo.git', { trustOverride: false }),
            /trust policy rejected git repository/
        );
    });

    it('returns overridden policy for untrusted repo URL with override', () => {
        const result = validateGitSourceTrust('https://evil.com/repo.git', { trustOverride: true });
        assert.equal(result.trusted, false);
        assert.equal(result.overridden, true);
        assert.equal(result.policy, 'overridden');
        assert.equal(result.overrideSource, 'cli-flag');
    });

    it('error message includes the rejected URL', () => {
        try {
            validateGitSourceTrust('https://evil.com/repo.git', { trustOverride: false });
            assert.fail('Expected an error');
        } catch (err: unknown) {
            assert.ok((err as Error).message.includes('https://evil.com/repo.git'));
            assert.ok((err as Error).message.includes('--trust-override'));
            assert.ok((err as Error).message.includes('--no-prompt'));
        }
    });
});

// ── validateNpmSourceTrust ─────────────────────────────────────────────

describe('validateNpmSourceTrust', () => {
    it('returns enforced policy for trusted package spec', () => {
        const result = validateNpmSourceTrust('garda-agent-orchestrator@latest', { trustOverride: false });
        assert.equal(result.trusted, true);
        assert.equal(result.policy, 'enforced');
        assert.equal(result.overrideSource, null);
    });

    it('throws for untrusted package spec without override', () => {
        assert.throws(
            () => validateNpmSourceTrust('evil-package@latest', { trustOverride: false }),
            /trust policy rejected npm package spec/
        );
    });

    it('returns overridden policy for untrusted spec with override', () => {
        const result = validateNpmSourceTrust('evil-package@latest', { trustOverride: true });
        assert.equal(result.trusted, false);
        assert.equal(result.overridden, true);
        assert.equal(result.policy, 'overridden');
        assert.equal(result.overrideSource, 'cli-flag');
    });

    it('throws for local path used as npm spec', () => {
        assert.throws(
            () => validateNpmSourceTrust('/some/path/to/pkg', { trustOverride: false }),
            /trust policy rejected npm package spec/
        );
    });

    it('error message includes the rejected spec', () => {
        try {
            validateNpmSourceTrust('evil-package@1.0.0', { trustOverride: false });
            assert.fail('Expected an error');
        } catch (err: unknown) {
            assert.ok((err as Error).message.includes('evil-package@1.0.0'));
            assert.ok((err as Error).message.includes('--trust-override'));
            assert.ok((err as Error).message.includes('--no-prompt'));
        }
    });
});

// ── validatePathSourceTrust ────────────────────────────────────────────

describe('validatePathSourceTrust', () => {
    it('always rejects without override', () => {
        assert.throws(
            () => validatePathSourceTrust('/some/path', { trustOverride: false }),
            /trust policy rejected local source path/
        );
    });

    it('returns overridden policy with override', () => {
        const result = validatePathSourceTrust('/some/path', { trustOverride: true });
        assert.equal(result.trusted, false);
        assert.equal(result.overridden, true);
        assert.equal(result.policy, 'overridden');
        assert.equal(result.overrideSource, 'cli-flag');
    });

    it('error message includes the rejected path', () => {
        try {
            validatePathSourceTrust('C:\\dev\\repo', { trustOverride: false });
            assert.fail('Expected an error');
        } catch (err: unknown) {
            assert.ok((err as Error).message.includes('C:\\dev\\repo'));
            assert.ok((err as Error).message.includes('--trust-override'));
            assert.ok((err as Error).message.includes('--no-prompt'));
        }
    });
});

// ── Integration: runCheckUpdate trust enforcement ──────────────────────

describe('runCheckUpdate trust integration', () => {
    const repoRoot = findRepoRoot();

    it('rejects sourcePath without trustOverride', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace('1.0.0');
        try {
            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    sourcePath: repoRoot,
                    dryRun: true
                }),
                /trust policy rejected local source path/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('accepts sourcePath with trustOverride', async () => {
        const currentVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(currentVersion);
        try {
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                dryRun: true,
                trustOverride: true
            });
            assert.equal(result.trustPolicy, 'overridden');
            assert.equal(result.sourceType, 'path');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rejects untrusted packageSpec without trustOverride', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace('1.0.0');
        try {
            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    packageSpec: 'evil-package@latest',
                    dryRun: true
                }),
                /trust policy rejected npm package spec/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('accepts untrusted packageSpec with trustOverride', async () => {
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace('1.0.0');
        try {
            // Trust override must pass first, then nonexistent packages fail during metadata resolution.
            await assert.rejects(
                runCheckUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    packageSpec: 'definitely-nonexistent-pkg-xyzzy@0.0.0',
                    dryRun: true,
                    trustOverride: true
                }),
                /Failed to resolve update package|NPM_METADATA_UNAVAILABLE/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('reports trustPolicy in result', async () => {
        const currentVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
        const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(currentVersion);
        try {
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: repoRoot,
                dryRun: true,
                trustOverride: true
            });
            assert.ok(['enforced', 'overridden'].includes(result.trustPolicy),
                `trustPolicy should be enforced or overridden, got: ${result.trustPolicy}`);
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});

// ── Allowlist contents ─────────────────────────────────────────────────

describe('trust allowlist contents', () => {
    it('TRUSTED_GIT_REPO_URLS is non-empty and frozen', () => {
        assert.ok(TRUSTED_GIT_REPO_URLS.length > 0);
        assert.ok(Object.isFrozen(TRUSTED_GIT_REPO_URLS));
    });

    it('TRUSTED_NPM_PACKAGE_NAMES is non-empty and frozen', () => {
        assert.ok(TRUSTED_NPM_PACKAGE_NAMES.length > 0);
        assert.ok(Object.isFrozen(TRUSTED_NPM_PACKAGE_NAMES));
    });

    it('trusted git URLs include the canonical repository', () => {
        assert.ok(TRUSTED_GIT_REPO_URLS.some(
            (url) => url.includes('Garda-Studio/garda-agent-orchestrator')
        ));
    });

    it('trusted npm names include the canonical package', () => {
        assert.ok(TRUSTED_NPM_PACKAGE_NAMES.includes('garda-agent-orchestrator'));
    });
});
