import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    prepareTaskResetOneActionAuthority, withTaskResetOneActionAuthority,
    type TaskResetAuthorityAction
} from '../../../src/core/task-reset-one-action-authority';
import { OPERATOR_CONFIRMATION_MAX_AGE_MS } from '../../../src/core/operator-confirmation';

function fixture(): { root: string; action: TaskResetAuthorityAction; storage: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-reset-authority-'));
    fs.mkdirSync(path.join(root, '.git'));
    const eventsRoot = path.join(root, 'garda-agent-orchestrator/runtime/task-events');
    const reviewsRoot = path.join(root, 'garda-agent-orchestrator/runtime/reviews');
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.mkdirSync(reviewsRoot, { recursive: true });
    return { root, action: { taskId: 'T-001', targetStatus: 'TODO', eventsRoot, reviewsRoot, scopeSha256: 'a'.repeat(64) },
        storage: path.join(root, '.git/garda-private/task-reset-authority'),
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function prepare(value: ReturnType<typeof fixture>): string {
    return prepareTaskResetOneActionAuthority({ repoRoot: value.root, action: value.action,
        operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
}

function consume<T>(value: ReturnType<typeof fixture>, authorityId: unknown, effect: () => T): T {
    return withTaskResetOneActionAuthority({ repoRoot: value.root, taskId: value.action.taskId,
        authorityId, action: () => value.action }, effect);
}

describe('native task reset one-action authority', () => {
    it('rejects missing explicit confirmation before issuing authority', () => {
        const value = fixture();
        try {
            assert.throws(() => prepareTaskResetOneActionAuthority({ repoRoot: value.root,
                action: value.action, operatorConfirmed: 'no', operatorConfirmedAtUtc: new Date().toISOString() }), /exact value/);
            assert.equal(fs.existsSync(value.storage), false);
        } finally { value.cleanup(); }
    });

    it('rejects stale and future operator confirmation before issuing authority', () => {
        const value = fixture();
        try {
            assert.throws(() => prepareTaskResetOneActionAuthority({ repoRoot: value.root,
                action: value.action, operatorConfirmed: 'yes', operatorConfirmedAtUtc:
                    new Date(Date.now() - OPERATOR_CONFIRMATION_MAX_AGE_MS - 1000).toISOString() }), /stale/);
            assert.throws(() => prepareTaskResetOneActionAuthority({ repoRoot: value.root,
                action: value.action, operatorConfirmed: 'yes', operatorConfirmedAtUtc:
                    new Date(Date.now() + 120000).toISOString() }), /future/);
            assert.equal(fs.existsSync(value.storage), false);
        } finally { value.cleanup(); }
    });

    it('consumes a native authority exactly once and rejects replay', () => {
        const value = fixture(); let effects = 0;
        try {
            const id = prepare(value);
            assert.equal(consume(value, id, () => ++effects), 1);
            assert.throws(() => consume(value, id, () => ++effects), /replay/);
            assert.equal(effects, 1);
        } finally { value.cleanup(); }
    });

    it('rejects forged authority record contents before effects', () => {
        const value = fixture(); let effects = 0;
        try {
            const id = prepare(value); const recordPath = path.join(value.storage, `${id}.json`);
            const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
            record.action_sha256 = 'b'.repeat(64); fs.writeFileSync(recordPath, JSON.stringify(record));
            assert.throws(() => consume(value, id, () => ++effects), /authentication failed/);
            assert.equal(effects, 0);
        } finally { value.cleanup(); }
    });

    it('rejects foreign workspace authority even after private files are copied', () => {
        const source = fixture(); const foreign = fixture(); let effects = 0;
        try {
            const id = prepare(source);
            fs.cpSync(source.storage, foreign.storage, { recursive: true });
            assert.throws(() => consume(foreign, id, () => ++effects), /mismatch/);
            assert.equal(effects, 0);
        } finally { source.cleanup(); foreign.cleanup(); }
    });

    it('rejects replaced action targets and changed native scope before effects', () => {
        const value = fixture(); let effects = 0;
        try {
            const id = prepare(value);
            value.action.targetStatus = 'DONE';
            assert.throws(() => consume(value, id, () => ++effects), /mismatch/);
            value.action.targetStatus = 'TODO'; value.action.scopeSha256 = 'b'.repeat(64);
            assert.throws(() => consume(value, id, () => ++effects), /mismatch/);
            assert.equal(effects, 0);
        } finally { value.cleanup(); }
    });

    it('rejects stale authority after its bounded lifetime', (context) => {
        const value = fixture(); let effects = 0;
        try {
            const issuedAt = Date.now(); const id = prepare(value);
            context.mock.method(Date, 'now', () => issuedAt + OPERATOR_CONFIRMATION_MAX_AGE_MS + 1000);
            assert.throws(() => consume(value, id, () => ++effects), /stale/);
            assert.equal(effects, 0);
        } finally { context.mock.restoreAll(); value.cleanup(); }
    });

    it('rejects replay after an interrupted effect rather than reopening authority', () => {
        const value = fixture();
        try {
            const id = prepare(value);
            assert.throws(() => consume(value, id, () => { throw new Error('interrupted'); }), /interrupted/);
            assert.throws(() => consume(value, id, () => undefined), /replay/);
        } finally { value.cleanup(); }
    });

    it('rejects restored authentic unconsumed records after interrupted effects', () => {
        const value = fixture(); let effects = 0;
        try {
            const id = prepare(value);
            const recordPath = path.join(value.storage, `${id}.json`);
            const original = fs.readFileSync(recordPath);
            assert.throws(() => consume(value, id, () => { effects += 1; throw new Error('interrupted'); }), /interrupted/);
            const claimPath = path.join(value.storage, `${id}.consumed`);
            const claim = fs.readFileSync(claimPath);
            fs.writeFileSync(recordPath, original);
            assert.equal(JSON.parse(fs.readFileSync(recordPath, 'utf8')).consumed, false);
            assert.throws(() => consume(value, id, () => ++effects), /replay/);
            assert.equal(effects, 1);
            assert.deepEqual(fs.readFileSync(claimPath), claim);
            assert.equal(consume(value, prepare(value), () => ++effects), 2);
        } finally { value.cleanup(); }
    });

    it('rejects restored authentic unconsumed records after successful effects', () => {
        const value = fixture(); let effects = 0;
        try {
            const id = prepare(value);
            const recordPath = path.join(value.storage, `${id}.json`);
            const original = fs.readFileSync(recordPath);
            assert.equal(consume(value, id, () => ++effects), 1);
            fs.writeFileSync(recordPath, original);
            assert.throws(() => consume(value, id, () => ++effects), /replay/);
            assert.equal(effects, 1);
        } finally { value.cleanup(); }
    });

    it('retains a failed consumption claim and rejects replay before effects', (context) => {
        const value = fixture(); let effects = 0;
        try {
            const id = prepare(value);
            const mutableFilesystem: typeof fs = require('node:fs');
            context.mock.method(mutableFilesystem, 'fsyncSync', () => { throw new Error('claim-sync-failed'); });
            assert.throws(() => consume(value, id, () => ++effects), /claim-sync-failed/);
            context.mock.restoreAll();
            assert.equal(fs.existsSync(path.join(value.storage, `${id}.consumed`)), true);
            assert.equal(JSON.parse(fs.readFileSync(path.join(value.storage, `${id}.json`), 'utf8')).consumed, false);
            assert.throws(() => consume(value, id, () => ++effects), /replay/);
            assert.equal(effects, 0);
        } finally { context.mock.restoreAll(); value.cleanup(); }
    });

    it('rejects concurrent same-task admission while the native reset lock is held', () => {
        const value = fixture(); let effects = 0; let concurrentError: unknown;
        try {
            const first = prepare(value); const second = prepare(value);
            consume(value, first, () => {
                effects += 1;
                try { consume(value, second, () => ++effects); } catch (error) { concurrentError = error; }
            });
            assert.match(String(concurrentError), /immediate_fail/);
            assert.equal(effects, 1);
        } finally { value.cleanup(); }
    });

    it('rejects missing and traversal authority IDs without executing effects', () => {
        const value = fixture(); let effects = 0;
        try {
            prepare(value);
            assert.throws(() => consume(value, '0'.repeat(64), () => ++effects), /ENOENT/);
            assert.throws(() => consume(value, '../key', () => ++effects), /malformed/);
            assert.equal(effects, 0);
        } finally { value.cleanup(); }
    });

    it('rejects symlink authority records before reading their destination', () => {
        const value = fixture(); let effects = 0;
        try {
            const id = prepare(value); const record = path.join(value.storage, `${id}.json`);
            fs.renameSync(record, `${record}.original`); fs.symlinkSync(`${record}.original`, record);
            assert.throws(() => consume(value, id, () => ++effects), /symlink|junction/);
            assert.equal(effects, 0);
        } finally { value.cleanup(); }
    });

    it('rejects hard-linked and oversized authority records before effects', () => {
        const value = fixture(); let effects = 0;
        try {
            const id = prepare(value); const record = path.join(value.storage, `${id}.json`);
            fs.linkSync(record, `${record}.linked`);
            assert.throws(() => consume(value, id, () => ++effects), /hard-linked/);
            fs.unlinkSync(`${record}.linked`); fs.appendFileSync(record, ' '.repeat(4097));
            assert.throws(() => consume(value, id, () => ++effects), /bounded ordinary/);
            assert.equal(effects, 0);
        } finally { value.cleanup(); }
    });

    it('rejects outside-workspace reset roots during authority preparation', () => {
        const value = fixture();
        try {
            value.action.eventsRoot = path.dirname(value.root);
            assert.throws(() => prepare(value), /outside permitted root/);
            assert.equal(fs.existsSync(value.storage), false);
        } finally { value.cleanup(); }
    });
});
