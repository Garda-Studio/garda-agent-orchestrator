import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertFreshValidationReport, captureValidationReportFiles, prepareValidationReportCapture } from '../../../src/core/validation-report-capture';
import type { ValidationFileObservation } from '../../../src/core/project-validation-identity';
import { parseValidationReportFiles, MAX_VALIDATION_REPORT_BYTES } from '../../../src/core/validation-report-contract';
import { readRetainedValidationReports } from '../../../src/core/validation-report-evidence';
import { validationDigest } from '../../../src/core/project-validation-identity';

const REPORT = 'reports/购买.result';
const CONTENT = '{"case":"purchase","outcome":"PASSED","actual":125}\n';

test('retained report inspection binds the actual start and bytes without rereading mutable results', () => {
    const f = fixture();
    try {
        const start = f.prepare(); f.write();
        const capture = captureValidationReportFiles(f.root, start);
        const options = { repoRoot: f.root, capture, declarations: start.declarations, evidenceDirectory: 'evidence',
            expectedStartSha256: validationDigest(start), executionViolations: [] };
        const expected = [`[report ${JSON.stringify(REPORT)}; encoding=utf8]\n${CONTENT}`];
        assert.deepEqual(readRetainedValidationReports(options).texts, expected);
        fs.writeFileSync(path.join(f.root, REPORT), 'later unrelated output');
        assert.deepEqual(readRetainedValidationReports(options).texts, expected);
        const modified = structuredClone(capture);
        modified.reports[0].content_base64 = Buffer.from('forged').toString('base64');
        assert.throws(() => readRetainedValidationReports({ ...options, capture: modified }), /bytes changed/);
        assert.throws(() => readRetainedValidationReports({ ...options, expectedStartSha256: '0'.repeat(64) }), /native execution start/);
        assert.throws(() => readRetainedValidationReports({ ...options, declarations: [] }), /undeclared/);
        assert.throws(() => readRetainedValidationReports({ ...options, evidenceDirectory: 'other-attempt' }), /outside/);
        fs.appendFileSync(path.join(f.root, start.anchor.identity.path), 'changed');
        assert.throws(() => readRetainedValidationReports(options), /anchor changed/);
    } finally { f.clean(); }
});

test('incomplete report capture retains failure and cannot be laundered into successful output', () => {
    const f = fixture();
    try {
        const start = f.prepare(), capture = captureValidationReportFiles(f.root, start);
        assert.equal(capture.violations.length, 1);
        const options = { repoRoot: f.root, capture, declarations: start.declarations, evidenceDirectory: 'evidence',
            expectedStartSha256: validationDigest(start), executionViolations: capture.violations };
        assert.deepEqual(readRetainedValidationReports(options), { texts: [], violations: capture.violations });
        assert.throws(() => readRetainedValidationReports({ ...options, executionViolations: [] }), /absent from execution/);
        assert.throws(() => readRetainedValidationReports({ ...options, capture: { ...capture, violations: [] } }), /report is missing/);
        assert.throws(() => f.prepare([{ path: 'evidence/output.json', max_bytes: 1024 }]), /owned evidence/);
        assert.throws(() => prepareValidationReportCapture(f.root,
            [{ path: 'control/timeline.jsonl', max_bytes: 1024 }],
            { evidenceDirectory: 'evidence', excludedRoots: ['control'] }), /owned evidence/);
    } finally { f.clean(); }
});

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-report-capture-'));
    fs.mkdirSync(path.join(root, 'reports'));
    fs.writeFileSync(path.join(root, 'driver.cjs'), [
        'const fs=require("node:fs"),path=require("node:path");',
        'const [mode,file,content]=process.argv.slice(2);',
        'if(mode==="rebuild"){fs.renameSync("reports","reports.prior");fs.mkdirSync("reports");}',
        'if(mode==="atomic"){fs.writeFileSync(file+".new",content);fs.renameSync(file+".new",file);}',
        'else fs.writeFileSync(file,mode==="binary"?Buffer.from(content,"base64"):content);'
    ].join('\n'));
    return { root,
        prepare: (files: unknown = [{ path: REPORT, max_bytes: 1024 }]) => prepareValidationReportCapture(root, files,
            { evidenceDirectory: 'evidence', excludedPaths: ['driver.cjs'] })!,
        write(mode = 'write', content = CONTENT) {
            const result = spawnSync(process.execPath, ['driver.cjs', mode, REPORT, content],
                { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
            assert.equal(result.error, undefined);
            assert.equal(result.status, 0, result.stderr);
        },
        clean: () => fs.rmSync(root, { recursive: true, force: true })
    };
}

test('declared report capture retains fresh bytes from a real child and is single-use', () => {
    const f = fixture();
    try {
        const start = f.prepare();
        assert.equal(start.before[0], null);
        f.write();
        const captured = captureValidationReportFiles(f.root, start);
        assert.deepEqual(captured.violations, []);
        assert.equal(captured.reports.length, 1);
        assert.equal(captured.reports[0].observation.identity.path, REPORT);
        assert.equal(Buffer.from(captured.reports[0].content_base64, 'base64').toString('utf8'), CONTENT);
        assert.throws(() => captureValidationReportFiles(f.root, start), /native start observation/);
        const again = f.prepare();
        f.write('atomic');
        assert.deepEqual(captureValidationReportFiles(f.root, again).violations, [], 'identical results must be freshly observable');
    } finally { f.clean(); }
});

test('non-UTF-8 reports retain exact binary bytes and expose canonical base64 for interpretation', () => {
    const f = fixture();
    try {
        const start = f.prepare(), bytes = Buffer.from([0, 255, 254, 1, 128]);
        f.write('binary', bytes.toString('base64'));
        const capture = captureValidationReportFiles(f.root, start);
        assert.deepEqual(capture.violations, []);
        const result = readRetainedValidationReports({ repoRoot: f.root, capture, declarations: start.declarations,
            evidenceDirectory: 'evidence', expectedStartSha256: validationDigest(start), executionViolations: [] });
        assert.deepEqual(result.texts, [`[report ${JSON.stringify(REPORT)}; encoding=base64]\n${bytes.toString('base64')}`]);
    } finally { f.clean(); }
});

for (const mode of ['atomic', 'rebuild']) test(`report capture supports fresh ${mode} output without a builder adapter`, () => {
    const f = fixture();
    try {
        fs.writeFileSync(path.join(f.root, REPORT), 'old result');
        const start = f.prepare();
        f.write(mode);
        const captured = captureValidationReportFiles(f.root, start);
        assert.deepEqual(captured.violations, []);
        assert.equal(captured.reports[0].observation.identity.size, Buffer.byteLength(CONTENT));
    } finally { f.clean(); }
});

test('missing, stale, oversized and foreign old reports cannot become captured evidence', () => {
    const f = fixture();
    try {
        assert.equal(captureValidationReportFiles(f.root, f.prepare()).reports.length, 0);
        f.write();
        const stale = captureValidationReportFiles(f.root, f.prepare());
        assert.equal(stale.reports.length, 0);
        assert.match(stale.violations.join('\n'), /freshly written|stale/);
        const large = f.prepare();
        f.write('write', 'x'.repeat(1025));
        const oversized = captureValidationReportFiles(f.root, large);
        assert.equal(oversized.reports.length, 0);
        assert.match(oversized.violations.join('\n'), /byte bound/);
        fs.writeFileSync(path.join(f.root, REPORT), 'before');
        fs.writeFileSync(path.join(f.root, 'foreign.result'), CONTENT);
        const foreign = f.prepare();
        fs.renameSync(path.join(f.root, 'foreign.result'), path.join(f.root, REPORT));
        const replaced = captureValidationReportFiles(f.root, foreign);
        assert.equal(replaced.reports.length, 0);
        assert.match(replaced.violations.join('\n'), /freshly written|foreign/);
    } finally { f.clean(); }
});

test('report observations reject forged, foreign and modified anchors and preserve containment', () => {
    const f = fixture(), other = fixture();
    try {
        const start = f.prepare();
        assert.throws(() => captureValidationReportFiles(f.root, JSON.parse(JSON.stringify(start))), /native start observation/);
        assert.throws(() => captureValidationReportFiles(other.root, start), /native start observation/);
        fs.appendFileSync(path.join(f.root, start.anchor.identity.path), 'changed');
        assert.throws(() => captureValidationReportFiles(f.root, start), /anchor changed/);
        const linked = f.prepare();
        fs.writeFileSync(path.join(other.root, 'outside.result'), CONTENT);
        fs.symlinkSync(path.join(other.root, 'outside.result'), path.join(f.root, REPORT), 'file');
        const escaped = captureValidationReportFiles(f.root, linked);
        assert.equal(escaped.reports.length, 0);
        assert.match(escaped.violations.join('\n'), /symlink|junction/);
        fs.unlinkSync(path.join(f.root, REPORT));
        const hardlinked = f.prepare();
        fs.linkSync(path.join(other.root, 'outside.result'), path.join(f.root, REPORT));
        assert.match(captureValidationReportFiles(f.root, hardlinked).violations.join('\n'), /hard.link/);
    } finally { f.clean(); other.clean(); }
});

test('report declarations reject traversal, ambiguity, source overwrite and unbounded capture', () => {
    const f = fixture();
    try {
        assert.equal(f.prepare([]), null);
        for (const file of ['../outside.result', '/outside.result', 'a/../x', '.git/config'])
            assert.throws(() => parseValidationReportFiles([{ path: file, max_bytes: 32 }]));
        assert.throws(() => parseValidationReportFiles([{path: REPORT, max_bytes: 1}, {path: REPORT, max_bytes: 1}]), /duplicate/);
        assert.throws(() => f.prepare([{ path: 'driver.cjs', max_bytes: 1024 }]), /observed inputs/);
        assert.throws(() => parseValidationReportFiles([{path: REPORT, max_bytes: MAX_VALIDATION_REPORT_BYTES + 1}]), /aggregate/);
        assert.throws(() => parseValidationReportFiles([{path: REPORT, max_bytes: 0}]), /positive/);
        assert.throws(() => parseValidationReportFiles([{path: REPORT, max_bytes: 4, trusted: true}]), /unsupported/);
    } finally { f.clean(); }
});

function reportObservation(identity: string, hash: string, modified: string, created = '1'): ValidationFileObservation {
    return { identity: { path: REPORT, identity, sha256: hash.repeat(64), size: 1 },
        modified_ns: modified, changed_ns: modified, created_ns: created };
}

test('T-404 accepts a rewritten pre-existing report with retained creation time and new identity', () => {
    const before = reportObservation('1:10:1', 'a', '2');
    const rewritten = reportObservation('1:11:1', 'b', '11');
    assert.doesNotThrow(() => assertFreshValidationReport(rewritten, before, 10n, '1970-01-01T00:00:00.001Z'));
    assert.throws(() => assertFreshValidationReport(rewritten, null, 10n, '1970-01-01T00:00:00.001Z'), /foreign|freshly written/);
});

test('T-404 refuses a merely touched old report and names the directory to clear', () => {
    const before = reportObservation('1:10:1', 'a', '2');
    assert.throws(() => assertFreshValidationReport(reportObservation('1:10:1', 'a', '11'), before, 10n,
        '1970-01-01T00:00:00.001Z'), /[Cc]lear.*reports/);
    assert.doesNotThrow(() => assertFreshValidationReport(reportObservation('1:10:1', 'b', '11'), before, 10n,
        '1970-01-01T00:00:00.001Z'));
});
