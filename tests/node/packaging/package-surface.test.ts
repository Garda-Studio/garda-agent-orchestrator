import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import {
    buildPackageSurfaceArtifact,
    collectCurrentPackageSurface,
    comparePackageSurface,
    createPackageSurfaceBaseline,
    formatPackageSurfaceComparison,
    installedPackageBytes,
    parseNpmPackReport,
    parsePackageSurfaceArtifact,
    parsePackageSurfaceBaseline,
    parsePackageSurfaceCliOptions,
    updatePackageSurfaceBaseline,
    validatePackageSurface
} from '../../../scripts/node-foundation/validate-release';
import { readPackedTarball } from '../../../scripts/node-foundation/release-validation/package-surface-tar';
import type { NpmPackReport, PackageSurfaceAllowedGrowth, PackageSurfaceArtifact } from '../../../scripts/node-foundation/validate-release';

interface FixtureEntry {
    path: string;
    content: Buffer;
    mode?: number;
    type?: string;
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
    header.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii');
    header[offset + length - 1] = 0;
}

function tarBytes(entries: FixtureEntry[]): Buffer {
    const blocks: Buffer[] = [];
    for (const entry of entries) {
        const header = Buffer.alloc(512);
        header.write(entry.path, 0, 100, 'utf8');
        octal(header, 100, 8, entry.mode ?? 0o644);
        octal(header, 108, 8, 0);
        octal(header, 116, 8, 0);
        octal(header, 124, 12, entry.content.length);
        octal(header, 136, 12, 0);
        header.fill(0x20, 148, 156);
        header.write(entry.type ?? '0', 156, 1, 'ascii');
        header.write('ustar\0', 257, 6, 'ascii');
        header.write('00', 263, 2, 'ascii');
        const checksum = header.reduce((sum, byte) => sum + byte, 0);
        octal(header, 148, 8, checksum);
        blocks.push(header, entry.content, Buffer.alloc((512 - entry.content.length % 512) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
}

function fixtureEntries(manifestOverrides: Record<string, unknown> = {}): FixtureEntry[] {
    const manifest = {
        name: 'fixture-package',
        version: '1.2.3',
        description: 'Fixture package',
        author: 'Fixture Author',
        license: 'Apache-2.0',
        type: 'commonjs',
        repository: { url: 'https://github.com/example/fixture' },
        homepage: 'https://example.invalid/',
        bugs: { url: 'https://github.com/example/fixture/issues' },
        funding: 'https://example.invalid/support',
        engines: { node: '>=22' },
        bin: { fixture: 'bin/cli.js' },
        scripts: { prepack: 'node build.cjs', postpack: 'node cleanup.cjs' },
        ...manifestOverrides
    };
    return [
        { path: 'package/package.json', content: Buffer.from(JSON.stringify(manifest)) },
        { path: 'package/bin/cli.js', content: Buffer.from("#!/usr/bin/env node\nrequire('node:fs').readFileSync('input');\n"), mode: 0o755 },
        { path: 'package/dist/runtime.js', content: Buffer.from("fetch('https://api.example.invalid');\n") },
        { path: 'package/README.md', content: Buffer.from('# Fixture\n') }
    ];
}

function fixture(overrides: { entries?: FixtureEntry[]; report?: Partial<NpmPackReport> } = {}): {
    root: string;
    tarballPath: string;
    report: NpmPackReport;
    cleanup: () => void;
} {
    const entries = overrides.entries ?? fixtureEntries();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-surface-test-'));
    const tarballPath = path.join(root, 'fixture-package-1.2.3.tgz');
    fs.writeFileSync(tarballPath, tarBytes(entries));
    const files = entries.filter((entry) => entry.type === undefined || entry.type === '0')
        .map((entry) => ({ path: entry.path.replace(/^package\//u, ''), size: entry.content.length }));
    const report: NpmPackReport = {
        name: 'fixture-package',
        version: '1.2.3',
        filename: path.basename(tarballPath),
        entryCount: files.length,
        unpackedSize: files.reduce((sum, file) => sum + file.size, 0),
        files,
        ...overrides.report
    };
    return { root, tarballPath, report, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function artifact(sample: ReturnType<typeof fixture>): PackageSurfaceArtifact {
    return buildPackageSurfaceArtifact(readPackedTarball(sample.tarballPath), sample.report, sample.report.unpackedSize);
}

const ZERO_GROWTH: PackageSurfaceAllowedGrowth = {
    fileCount: 0,
    unpackedSizeBytes: 0,
    installedSizeBytes: 0,
    riskSignals: { child_process: 0, exec: 0, fetch: 0, fs: 0, readFile: 0, writeFile: 0 }
};

test('package surface reads hashes, metadata, dependencies, lifecycle, URLs, and executable signals from one tarball', () => {
    const sample = fixture();
    try {
        const measured = artifact(sample);
        assert.equal(measured.metrics.fileCount, 4);
        assert.equal(measured.metrics.productionDependencyCount, 0);
        assert.equal(measured.metrics.installedSizeBytes, measured.metrics.unpackedSizeBytes);
        assert.deepEqual(measured.metrics.unexpectedExecutablePaths, []);
        assert.deepEqual(measured.metrics.minifiedArtifactPaths, []);
        assert.deepEqual(measured.metrics.lifecycleScripts, {
            postpack: 'node cleanup.cjs', prepack: 'node build.cjs'
        });
        assert.ok(measured.metrics.urlHosts.includes('api.example.invalid'));
        assert.equal(measured.metrics.metadata.license, 'Apache-2.0');
        assert.equal(measured.metrics.riskSignals.readFile, 1);
        assert.equal(measured.tarballSha256, crypto.createHash('sha256').update(fs.readFileSync(sample.tarballPath)).digest('hex'));
        const cli = readPackedTarball(sample.tarballPath).files.find((file) => file.path === 'bin/cli.js');
        assert.equal(measured.packedFileSha256['bin/cli.js'], cli?.sha256);
        assert.deepEqual(parsePackageSurfaceArtifact(measured), measured);
    } finally {
        sample.cleanup();
    }
});

test('tarball data wins over a modified source tree, and report/tar drift fails with the affected path', () => {
    const sample = fixture();
    try {
        fs.writeFileSync(path.join(sample.root, 'package.json'), '{"name":"wrong"}');
        assert.equal(artifact(sample).package.name, 'fixture-package');
        assert.throws(
            () => buildPackageSurfaceArtifact(readPackedTarball(sample.tarballPath), {
                ...sample.report,
                files: sample.report.files.map((file) => file.path === 'bin/cli.js' ? { ...file, size: file.size + 1 } : file),
                unpackedSize: sample.report.unpackedSize + 1
            }, 100),
            /does not match tarball file bin\/cli.js/u
        );
        assert.throws(() => buildPackageSurfaceArtifact(readPackedTarball(sample.tarballPath), {
            ...sample.report, entryCount: 5
        }, 100), /entryCount=5/u);
    } finally {
        sample.cleanup();
    }
});

test('tar parser rejects traversal, symlinks, corrupt headers, and duplicate entries', () => {
    for (const [entries, expected] of [
        [[{ path: 'package/../escape.js', content: Buffer.from('bad') }], /unsafe file path/u],
        [[{ path: 'package/../outside/', content: Buffer.alloc(0), type: '5' }], /unsafe file path/u],
        [[{ path: 'package/link', content: Buffer.alloc(0), type: '2' }], /unsupported entry type/u],
        [[{ path: 'package/a.js', content: Buffer.from('1') }, { path: 'package/a.js', content: Buffer.from('2') }], /duplicate file path/u]
    ] as Array<[FixtureEntry[], RegExp]>) {
        const sample = fixture({ entries });
        try {
            assert.throws(() => readPackedTarball(sample.tarballPath), expected);
        } finally {
            sample.cleanup();
        }
    }
    const sample = fixture();
    try {
        const uncompressed = zlib.gunzipSync(fs.readFileSync(sample.tarballPath));
        uncompressed[0] ^= 1;
        fs.writeFileSync(sample.tarballPath, zlib.gzipSync(uncompressed));
        assert.throws(() => readPackedTarball(sample.tarballPath), /checksum mismatch/u);
    } finally {
        sample.cleanup();
    }
});

test('PAX path overrides are measured from the archive and cannot escape its package root', () => {
    const paxRecord = (name: string): Buffer => {
        const body = `path=${name}\n`;
        let length = Buffer.byteLength(body) + 3;
        while (true) {
            const record = `${length} ${body}`;
            const bytes = Buffer.byteLength(record);
            if (bytes === length) {
                return Buffer.from(record);
            }
            length = bytes;
        }
    };
    const sample = fixture({ entries: [
        { path: 'PaxHeader', type: 'x', content: paxRecord('package/long/file.js') },
        { path: 'package/short.js', content: Buffer.from('hello') }
    ] });
    try {
        assert.equal(readPackedTarball(sample.tarballPath).files[0].path, 'long/file.js');
        fs.writeFileSync(sample.tarballPath, tarBytes([
            { path: 'PaxHeader', type: 'x', content: paxRecord('package/../escape.js') },
            { path: 'package/short.js', content: Buffer.from('hello') }
        ]));
        assert.throws(() => readPackedTarball(sample.tarballPath), /unsafe file path/u);
    } finally {
        sample.cleanup();
    }
});

test('unexpected executable, minified file, production dependency, and URL host fail deterministically', () => {
    const original = fixture();
    const changed = fixture({ entries: [
        ...fixtureEntries({ dependencies: { unexpected: '1.0.0' } }),
        { path: 'package/dist/hidden.min.js', content: Buffer.from("#!/usr/bin/env node\nfetch('https://new.example.invalid')\n"), mode: 0o755 }
    ] });
    try {
        const baseline = createPackageSurfaceBaseline(artifact(original), { rationale: 'Reviewed fixture.', allowedGrowth: ZERO_GROWTH });
        const result = comparePackageSurface(artifact(changed), baseline, 'baseline.json');
        assert.equal(result.passed, false);
        const output = formatPackageSurfaceComparison(result);
        assert.match(output, /productionDependencyCount current=1 reference=0/u);
        assert.match(output, /unexpectedExecutablePaths added: dist\/hidden.min.js/u);
        assert.match(output, /minifiedArtifactPaths added: dist\/hidden.min.js/u);
        assert.match(output, /urlHosts added: new.example.invalid/u);
        assert.match(output, /fileCount current=5 reference=4 growth=1 allowed=0/u);
        assert.deepEqual(parsePackageSurfaceBaseline(baseline), baseline);
    } finally {
        original.cleanup();
        changed.cleanup();
    }
});

test('same-size packed file changes and archive-only changes fail SHA-256 comparison', () => {
    const original = fixture();
    const changedFile = fixture({ entries: fixtureEntries().map((entry) => entry.path === 'package/README.md'
        ? { ...entry, content: Buffer.from('# Fixture!') } : entry) });
    const changedOrder = fixture({ entries: [...fixtureEntries()].reverse() });
    const changedMode = fixture({ entries: fixtureEntries().map((entry) => entry.path === 'package/bin/cli.js'
        ? { ...entry, mode: 0o644 } : entry) });
    try {
        const baseline = createPackageSurfaceBaseline(artifact(original), { rationale: 'Reviewed fixture.', allowedGrowth: ZERO_GROWTH });
        const fileResult = comparePackageSurface(artifact(changedFile), baseline, 'baseline.json');
        assert.match(formatPackageSurfaceComparison(fileResult), /packed file SHA-256 changed \(1\): README.md/u);
        const orderResult = comparePackageSurface(artifact(changedOrder), baseline, 'baseline.json');
        assert.match(formatPackageSurfaceComparison(orderResult), /tarball SHA-256 changed despite identical packed files/u);
        assert.notEqual(baseline.tarballSha256, orderResult.current.tarballSha256);
        const modeResult = comparePackageSurface(artifact(changedMode), baseline, 'baseline.json');
        assert.deepEqual(modeResult.current.packedFileSha256, baseline.packedFileSha256);
        assert.equal(modeResult.passed, false);
        assert.match(formatPackageSurfaceComparison(modeResult), /tarball SHA-256 changed despite identical packed files/u);
    } finally {
        original.cleanup();
        changedFile.cleanup();
        changedOrder.cleanup();
        changedMode.cleanup();
    }
});

test('audited platform digests select one exact archive and reject cross-platform or unapproved archives', () => {
    const posix = fixture();
    const windows = fixture({ entries: fixtureEntries().map((entry) => entry.path === 'package/bin/cli.js'
        ? { ...entry, mode: 0o644 } : entry) });
    const reordered = fixture({ entries: [...fixtureEntries()].reverse() });
    const edited = fixture({ entries: fixtureEntries().map((entry) => entry.path === 'package/README.md'
        ? { ...entry, content: Buffer.from('# Changed\n') } : entry) });
    try {
        const posixArtifact = artifact(posix);
        const windowsArtifact = artifact(windows);
        const baseline = parsePackageSurfaceBaseline({
            ...createPackageSurfaceBaseline(posixArtifact, { rationale: 'Audited modes.', allowedGrowth: ZERO_GROWTH }),
            tarballSha256ByPlatform: { linux: posixArtifact.tarballSha256, win32: windowsArtifact.tarballSha256 }
        });
        assert.deepEqual(windowsArtifact.packedFileSha256, posixArtifact.packedFileSha256);
        for (const [platform, measured] of [['linux', posixArtifact], ['win32', windowsArtifact]] as const) {
            const result = comparePackageSurface(measured, baseline, 'baseline.json', platform);
            assert.equal(result.passed, true, formatPackageSurfaceComparison(result));
            assert.equal(result.referenceTarballSha256, measured.tarballSha256);
            assert.match(formatPackageSurfaceComparison(result), new RegExp(`Platform: ${platform}`, 'u'));
        }
        for (const [platform, measured] of [
            ['linux', windowsArtifact], ['win32', posixArtifact], ['linux', artifact(reordered)], ['win32', artifact(reordered)]
        ] as const) {
            const result = comparePackageSurface(measured, baseline, 'baseline.json', platform);
            assert.equal(result.passed, false);
            assert.match(formatPackageSurfaceComparison(result), /tarball SHA-256 changed despite identical packed files/u);
        }
        const unsupported = comparePackageSurface(posixArtifact, baseline, 'baseline.json', 'darwin');
        assert.equal(unsupported.passed, false);
        assert.match(formatPackageSurfaceComparison(unsupported), /No audited tarball SHA-256 for platform darwin/u);
        const contentChange = comparePackageSurface(artifact(edited), baseline, 'baseline.json', 'win32');
        assert.equal(contentChange.passed, false);
        assert.match(formatPackageSurfaceComparison(contentChange), /packed file SHA-256 changed \(1\): README.md/u);
    } finally {
        posix.cleanup();
        windows.cleanup();
        reordered.cleanup();
        edited.cleanup();
    }
});

test('platform digest maps reject malformed, unknown, inherited, and unbound entries', () => {
    const sample = fixture();
    try {
        const baseline = createPackageSurfaceBaseline(artifact(sample), { rationale: 'Reviewed.', allowedGrowth: ZERO_GROWTH });
        for (const map of [null, [], {}, 'linux', { linux: 'invalid' }, { windows: baseline.tarballSha256 },
            { linux: 'f'.repeat(64) }, Object.create({ linux: baseline.tarballSha256 })]) {
            assert.throws(() => parsePackageSurfaceBaseline({ ...baseline, tarballSha256ByPlatform: map }), /tarballSha256ByPlatform/u);
        }
        const parsed = parsePackageSurfaceBaseline({ ...baseline, tarballSha256ByPlatform: { linux: baseline.tarballSha256 } });
        assert.deepEqual(parsed.tarballSha256ByPlatform, { linux: baseline.tarballSha256 });
    } finally {
        sample.cleanup();
    }
});

test('legacy baselines and explicit prior artifacts retain exact archive comparison on every platform', () => {
    const sample = fixture();
    try {
        const measured = artifact(sample);
        const legacy = createPackageSurfaceBaseline(measured, { rationale: 'Legacy.', allowedGrowth: ZERO_GROWTH });
        delete legacy.tarballSha256ByPlatform;
        assert.deepEqual(parsePackageSurfaceBaseline(legacy), legacy);
        const prior = parsePackageSurfaceArtifact({ ...measured, tarballSha256ByPlatform: { win32: 'f'.repeat(64) } });
        for (const platform of ['linux', 'win32', 'darwin'] as const) {
            for (const reference of [legacy, prior]) {
                assert.equal(comparePackageSurface(measured, reference, 'reference.json', platform).passed, true);
                const altered = { ...measured, tarballSha256: 'f'.repeat(64) };
                assert.equal(comparePackageSurface(altered, reference, 'reference.json', platform).passed, false);
            }
        }
    } finally {
        sample.cleanup();
    }
});

test('an explicit baseline refresh approves only its measured platform and drops stale platform digests', () => {
    const sample = fixture();
    try {
        const measured = artifact(sample);
        const baselinePath = path.join(sample.root, 'baseline.json');
        const old = createPackageSurfaceBaseline(measured, { rationale: 'Old.', allowedGrowth: ZERO_GROWTH });
        old.tarballSha256ByPlatform = { linux: measured.tarballSha256, win32: 'f'.repeat(64) };
        fs.writeFileSync(baselinePath, JSON.stringify(old));
        const updated = updatePackageSurfaceBaseline(baselinePath, measured, {
            confirmed: true, rationale: 'Audited refresh.', allowedGrowth: ZERO_GROWTH
        });
        assert.deepEqual(updated.tarballSha256ByPlatform, { [process.platform]: measured.tarballSha256 });
        assert.deepEqual(parsePackageSurfaceBaseline(JSON.parse(fs.readFileSync(baselinePath, 'utf8'))), updated);
    } finally {
        sample.cleanup();
    }
});

test('new packed paths fail even within file and byte growth allowances', () => {
    const original = fixture();
    const changed = fixture({ entries: [
        ...fixtureEntries(),
        { path: 'package/bin/fixture', content: Buffer.from('#!/usr/bin/env node\n'), mode: 0o755 },
        { path: 'package/config/key.txt', content: Buffer.from('-----BEGIN PRIVATE KEY-----\nfixture\n') }
    ] });
    try {
        const baseline = createPackageSurfaceBaseline(artifact(original), {
            rationale: 'Reviewed fixture.',
            allowedGrowth: { ...ZERO_GROWTH, fileCount: 10, unpackedSizeBytes: 256 * 1024 }
        });
        const result = comparePackageSurface(artifact(changed), baseline, 'baseline.json');
        const output = formatPackageSurfaceComparison(result);
        assert.equal(result.passed, false);
        assert.match(output, /packed files added \(2\): bin\/fixture, config\/key.txt/u);
        assert.match(output, /unexpectedExecutablePaths added: bin\/fixture/u);
        assert.doesNotMatch(output, /fileCount current=.*growth=/u);
        assert.doesNotMatch(output, /unpackedSizeBytes current=.*growth=/u);
    } finally {
        original.cleanup();
        changed.cleanup();
    }
});

test('prepare-adjacent lifecycle scripts and optional or peer dependencies are measured from packed metadata', () => {
    const sample = fixture({ entries: fixtureEntries({
        scripts: { preprepare: 'node before.cjs', prepare: 'node build.cjs', postprepare: 'node after.cjs' },
        optionalDependencies: { optional: '1.0.0' },
        peerDependencies: { peer: '2.0.0' }
    }) });
    try {
        const measured = artifact(sample);
        assert.equal(measured.metrics.productionDependencyCount, 2);
        assert.deepEqual(measured.metrics.lifecycleScripts, {
            postprepare: 'node after.cjs', prepare: 'node build.cjs', preprepare: 'node before.cjs'
        });
    } finally {
        sample.cleanup();
    }
});

test('installed-byte measurement covers dependency siblings and generated bin shims', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-installed-bytes-'));
    try {
        fs.mkdirSync(path.join(root, 'node_modules', 'fixture-package'), { recursive: true });
        fs.mkdirSync(path.join(root, 'node_modules', 'optional'), { recursive: true });
        fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
        fs.writeFileSync(path.join(root, 'node_modules', 'fixture-package', 'a.js'), '123');
        fs.writeFileSync(path.join(root, 'node_modules', 'optional', 'b.js'), '12345');
        fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'fixture.cmd'), '1234567');
        assert.equal(installedPackageBytes(path.join(root, 'node_modules')), 15);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('URL and minification checks include shell, SVG, and ordinary CSS files', () => {
    const original = fixture();
    const changed = fixture({ entries: [
        ...fixtureEntries({ repository: { url: 'GIT+HTTPS://github.com/example/fixture' } }),
        { path: 'package/docs/logo.svg', content: Buffer.from('<svg><!-- https://svg.example.invalid --></svg>') },
        { path: 'package/scripts/check.sh', content: Buffer.from('curl HTTPS://upper.example.invalid\n') },
        { path: 'package/styles/style.css', content: Buffer.from('a'.repeat(10_001)) }
    ] });
    try {
        const baseline = createPackageSurfaceBaseline(artifact(original), { rationale: 'Reviewed fixture.', allowedGrowth: ZERO_GROWTH });
        const changedArtifact = artifact(changed);
        assert.equal(changedArtifact.metrics.metadata.repository, 'GIT+HTTPS://github.com/example/fixture');
        const output = formatPackageSurfaceComparison(comparePackageSurface(changedArtifact, baseline, 'baseline.json'));
        assert.match(output, /minifiedArtifactPaths added: styles\/style.css/u);
        assert.match(output, /svg.example.invalid/u);
        assert.match(output, /urlHosts added: .*upper.example.invalid/u);
    } finally {
        original.cleanup();
        changed.cleanup();
    }
});

test('installed byte growth, lifecycle changes, and missing metadata fail with actionable diagnostics', () => {
    const sample = fixture();
    const missing = fixture({ entries: fixtureEntries({ license: undefined }) });
    try {
        assert.throws(() => artifact(missing), /package\.json\.license/u);
        const current = artifact(sample);
        const baseline = createPackageSurfaceBaseline(current, { rationale: 'Reviewed fixture.', allowedGrowth: ZERO_GROWTH });
        const altered: PackageSurfaceArtifact = {
            ...current,
            metrics: {
                ...current.metrics,
                installedSizeBytes: current.metrics.installedSizeBytes + 1,
                lifecycleScripts: { ...current.metrics.lifecycleScripts, install: 'node install.cjs' }
            }
        };
        const output = formatPackageSurfaceComparison(comparePackageSurface(altered, baseline, 'baseline.json'));
        assert.match(output, /installedSizeBytes current=/u);
        assert.match(output, /lifecycleScripts changed: added install=/u);
        assert.match(output, /package-surface-baseline --confirm-baseline-update --rationale/u);
    } finally {
        sample.cleanup();
        missing.cleanup();
    }
});

test('unpacked-byte and lexical-risk budgets reject excess growth but accept their boundaries', () => {
    const sample = fixture();
    try {
        const measured = artifact(sample);
        const baseline = createPackageSurfaceBaseline(measured, {
            rationale: 'Reviewed fixture.',
            allowedGrowth: {
                ...ZERO_GROWTH,
                unpackedSizeBytes: 2,
                riskSignals: { ...ZERO_GROWTH.riskSignals, fetch: 1 }
            }
        });
        const atBoundary: PackageSurfaceArtifact = {
            ...measured,
            metrics: {
                ...measured.metrics,
                unpackedSizeBytes: measured.metrics.unpackedSizeBytes + 2,
                riskSignals: { ...measured.metrics.riskSignals, fetch: measured.metrics.riskSignals.fetch + 1 }
            }
        };
        assert.equal(comparePackageSurface(atBoundary, baseline, 'baseline.json').passed, true);
        const exceeded: PackageSurfaceArtifact = {
            ...atBoundary,
            metrics: {
                ...atBoundary.metrics,
                unpackedSizeBytes: atBoundary.metrics.unpackedSizeBytes + 1,
                riskSignals: { ...atBoundary.metrics.riskSignals, fetch: atBoundary.metrics.riskSignals.fetch + 1 }
            }
        };
        const output = formatPackageSurfaceComparison(comparePackageSurface(exceeded, baseline, 'baseline.json'));
        assert.match(output, /unpackedSizeBytes current=.*growth=3 allowed=2/u);
        assert.match(output, /riskSignals.fetch current=.*growth=2 allowed=1/u);
    } finally {
        sample.cleanup();
    }
});

test('failed package preparation removes its partial compatibility file', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-surface-prepare-failure-'));
    const buildScript = path.join(repoRoot, '.scripts-build', 'scripts', 'node-foundation', 'build.js');
    const compatibilityScript = path.join(repoRoot, 'scripts', 'package-legacy-entrypoint-compat.cjs');
    const compatibilityPath = path.join(repoRoot, 'template', 'CLAUDE.md');
    try {
        fs.mkdirSync(path.dirname(buildScript), { recursive: true });
        fs.mkdirSync(path.dirname(compatibilityScript), { recursive: true });
        fs.writeFileSync(buildScript, 'process.exit(0);\n');
        fs.writeFileSync(compatibilityScript, [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const output = path.join(process.cwd(), 'template', 'CLAUDE.md');",
            "if (process.argv[2] === 'create') {",
            '  fs.mkdirSync(path.dirname(output), { recursive: true });',
            "  fs.writeFileSync(output, 'partial');",
            "  process.exit(1);",
            '}',
            "if (process.argv[2] === 'remove') fs.rmSync(output, { force: true });"
        ].join('\n'));
        assert.throws(() => collectCurrentPackageSurface(repoRoot), /legacy package compatibility materialization failed/u);
        assert.equal(fs.existsSync(compatibilityPath), false);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('baseline updates require confirmation and rationale; npm report parsing stays strict', () => {
    const sample = fixture();
    try {
        const measured = artifact(sample);
        const baselinePath = path.join(sample.root, 'baseline.json');
        assert.throws(() => updatePackageSurfaceBaseline(baselinePath, measured, {
            confirmed: false, rationale: 'Reviewed.', allowedGrowth: ZERO_GROWTH
        }), /--confirm-baseline-update/u);
        assert.throws(() => createPackageSurfaceBaseline(measured, {
            rationale: ' ', allowedGrowth: ZERO_GROWTH
        }), /--rationale/u);
        const baseline = updatePackageSurfaceBaseline(baselinePath, measured, {
            confirmed: true, rationale: 'Reviewed.', allowedGrowth: ZERO_GROWTH
        });
        assert.deepEqual(JSON.parse(fs.readFileSync(baselinePath, 'utf8')), baseline);
        assert.equal(comparePackageSurface(measured, measured, 'prior.json').passed, true);
        assert.deepEqual(parseNpmPackReport(`build complete\n${JSON.stringify([sample.report])}`), sample.report);
        assert.throws(() => parseNpmPackReport('not json'), /valid npm pack JSON/u);
    } finally {
        sample.cleanup();
    }
});

test('published package files retain review defaults and public guidance', () => {
    const repoRoot = process.cwd();
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { files: string[] };
    assert.ok(manifest.files.includes('template'));
    for (const relativePath of [
        'template/config/review-catalog.json',
        'template/docs/agent-rules/80-task-workflow.md',
        'docs/configuration.md',
        'docs/cli-reference.md',
        'docs/compatibility-matrix.md'
    ]) {
        assert.ok(fs.existsSync(path.join(repoRoot, relativePath)), `${relativePath} should be package-visible`);
    }
});

test('package-surface validation reproduces real offline npm packs and cleans compatibility output', { timeout: 180_000 }, () => {
    const repoRoot = process.cwd();
    const relativeOutputPath = `garda-agent-orchestrator/runtime/release/package-surface-e2e-${process.pid}.json`;
    const relativePriorPath = `garda-agent-orchestrator/runtime/release/package-surface-e2e-prior-${process.pid}.json`;
    const outputPath = path.join(repoRoot, relativeOutputPath);
    const priorPath = path.join(repoRoot, relativePriorPath);
    const compatibilityPath = path.join(repoRoot, 'template', 'CLAUDE.md');
    assert.equal(fs.existsSync(compatibilityPath), false);
    try {
        // npm tar modes can differ across hosts. Compare two exact archives from
        // this host; the release gate separately checks the audited baseline.
        const prior = collectCurrentPackageSurface(repoRoot);
        assert.equal(fs.existsSync(compatibilityPath), false);
        fs.mkdirSync(path.dirname(priorPath), { recursive: true });
        fs.writeFileSync(priorPath, JSON.stringify(prior), 'utf8');
        const result = validatePackageSurface(repoRoot, {
            outputPath: relativeOutputPath,
            priorArtifactPath: relativePriorPath
        });
        const measured = parsePackageSurfaceArtifact(JSON.parse(fs.readFileSync(outputPath, 'utf8')));
        assert.equal(result.passed, true, formatPackageSurfaceComparison(result));
        assert.equal(result.referenceKind, 'prior-artifact');
        assert.equal(measured.tarballSha256, prior.tarballSha256);
        assert.deepEqual(measured.packedFileSha256, prior.packedFileSha256);
        assert.equal(measured.metrics.productionDependencyCount, 0);
        assert.equal(Object.keys(measured.packedFileSha256).length, measured.metrics.fileCount);
        assert.equal(fs.existsSync(compatibilityPath), false);
        const defaultResult = validatePackageSurface(repoRoot, { outputPath: relativeOutputPath });
        assert.equal(defaultResult.passed, true, formatPackageSurfaceComparison(defaultResult));
        assert.equal(defaultResult.referenceKind, 'baseline');
        assert.equal(defaultResult.platform, process.platform);
        assert.equal(defaultResult.referenceTarballSha256, measured.tarballSha256);
    } finally {
        fs.rmSync(outputPath, { force: true });
        fs.rmSync(priorPath, { force: true });
        fs.rmSync(compatibilityPath, { force: true });
    }
});

test('CLI rejects ambiguous references and output paths that overwrite repository files', () => {
    assert.throws(() => parsePackageSurfaceCliOptions(['--baseline', 'a.json', '--prior-artifact', 'b.json']), /cannot be used together/u);
    assert.throws(() => parsePackageSurfaceCliOptions(['--confirm-baseline-update']), /only valid for package-surface-baseline/u);
    assert.throws(() => validatePackageSurface(process.cwd(), { outputPath: 'package.json' }), /--output must be a JSON file inside/u);
});
