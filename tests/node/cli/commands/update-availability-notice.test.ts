import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildUpdateCommand, formatUpdateAvailabilityNotice } from '../../../../src/lifecycle/update-availability/update-availability-notice';

test('terminal notice uses English, two lines and the exact existing update command', () => {
    const target = path.resolve('workspace with spaces');
    const notice = formatUpdateAvailabilityNotice(target, {
        status: 'available', currentVersion: '1.4.3', latestVersion: '1.4.4', updateCommand: null
    });
    assert.equal(notice, `Garda update available: 1.4.3 → 1.4.4\n${buildUpdateCommand(target)}`);
    assert.ok(notice.includes('--apply'));
    assert.equal(notice.split('\n').length, 2);
});

test('terminal command safely quotes interpolation and apostrophes', () => {
    const target = path.resolve("project's $work `name");
    const command = buildUpdateCommand(target);
    assert.ok(command.includes("--target-root '"));
    assert.ok(command.endsWith("' --apply"));
    assert.ok(command.includes(process.platform === 'win32' ? "project''s" : "project'\\''s"));
});

test('ordinary and failed checks produce no terminal notification', () => {
    for (const status of ['unknown', 'checking', 'up_to_date', 'unavailable', 'disabled'] as const) {
        assert.equal(formatUpdateAvailabilityNotice('.', { status, currentVersion: '1.4.3', latestVersion: null, updateCommand: null }), '');
    }
});
