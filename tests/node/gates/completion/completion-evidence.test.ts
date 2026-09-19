import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collectOrderedTimelineEvents,
    readJsonArtifact,
    ensurePassedArtifactStatus,
    readOptionalArtifactStringField,
    normalizeTimelineDetailString,
    getTimelineSkillId,
    getTimelineReferencePath,
    eventMatchesReviewSkill,
    eventMatchesStage,
    findLatestTimelineEvent,
    findLatestStageOccurrence,
    findLatestStageOccurrenceInRange,
    findLatestRecordedReviewContextPath
} from '../../../../src/gates/completion/completion-evidence';
import type { TimelineEventEntry } from '../../../../src/gates/completion/completion-evidence';

function isReadOnlyOpen(flags: fs.OpenMode): boolean {
    if (typeof flags === 'string') {
        return flags === 'r' || flags === 'rs' || flags === 'sr';
    }
    return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0;
}

function captureTimelineReadOpens<T>(
    timelinePath: string,
    callback: () => T
): { result: T; readSites: string[] } {
    const fsModule = require('node:fs') as typeof fs;
    const originalOpenSync = fsModule.openSync;
    const readSites: string[] = [];
    fsModule.openSync = ((targetPath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (
            path.resolve(String(targetPath)) === path.resolve(timelinePath)
            && isReadOnlyOpen(flags)
        ) {
            readSites.push(new Error().stack || 'stack unavailable');
        }
        return originalOpenSync(targetPath, flags, mode);
    }) as typeof fsModule.openSync;
    try {
        return { result: callback(), readSites };
    } finally {
        fsModule.openSync = originalOpenSync;
    }
}

describe('gates/completion-evidence', () => {
    describe('collectOrderedTimelineEvents', () => {
        it('reads valid JSONL timeline', () => {
            const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-ce-'));
            const timelinePath = path.join(tmpDir, 'test.jsonl');
            fs.writeFileSync(timelinePath, [
                JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-01-01T00:00:00Z', details: { task_id: 'T-001' } }),
                JSON.stringify({ event_type: 'COMPILE_GATE_PASSED', timestamp_utc: '2026-01-01T00:01:00Z', details: null })
            ].join('\n'), 'utf8');
            const errors: string[] = [];
            const events = collectOrderedTimelineEvents(timelinePath, errors);
            assert.equal(errors.length, 0);
            assert.equal(events.length, 2);
            assert.equal(events[0].event_type, 'TASK_MODE_ENTERED');
            assert.equal(events[0].sequence, 0);
            assert.equal(events[1].event_type, 'COMPILE_GATE_PASSED');
            assert.equal(events[1].sequence, 1);
            fs.rmSync(tmpDir, { recursive: true });
        });

        it('handles missing file', () => {
            const errors: string[] = [];
            const events = collectOrderedTimelineEvents('/nonexistent/path.jsonl', errors);
            assert.equal(events.length, 0);
            assert.equal(errors.length, 1);
            assert.ok(errors[0].includes('not found'));
        });

        it('handles invalid JSON lines gracefully', () => {
            const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-ce-'));
            const timelinePath = path.join(tmpDir, 'bad.jsonl');
            fs.writeFileSync(timelinePath, [
                JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-01-01T00:00:00Z', details: null }),
                'NOT JSON',
                JSON.stringify({ event_type: 'COMPILE_GATE_PASSED', timestamp_utc: '2026-01-01T00:02:00Z', details: null })
            ].join('\n'), 'utf8');
            const errors: string[] = [];
            const events = collectOrderedTimelineEvents(timelinePath, errors);
            assert.equal(events.length, 2);
            assert.equal(events[0].sequence, 0);
            assert.equal(events[1].sequence, 2);
            assert.equal(errors.length, 1);
            assert.ok(errors[0].includes('invalid JSON'));
            fs.rmSync(tmpDir, { recursive: true });
        });

        it('reuses one authenticated capture for repeated long-history reads', () => {
            const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-ce-snapshot-'));
            const taskId = 'T-COMP-SNAPSHOT';
            const timelinePath = path.join(tmpDir, `${taskId}.jsonl`);
            const lines = Array.from({ length: 5_000 }, (_, index) => JSON.stringify({
                event_type: index === 0 ? 'TASK_MODE_ENTERED' : 'PERFORMANCE_FIXTURE_EVENT',
                timestamp_utc: new Date(1_700_000_000_000 + index).toISOString(),
                details: { fixture_index: index }
            }));
            fs.writeFileSync(timelinePath, `${lines.join('\n')}\n`, 'utf8');

            try {
                const { result, readSites } = captureTimelineReadOpens(timelinePath, () => {
                    const firstErrors: string[] = [];
                    return {
                        first: collectOrderedTimelineEvents(timelinePath, firstErrors),
                        firstErrors
                    };
                });

                assert.equal(result.first.length, lines.length);
                assert.deepEqual(result.firstErrors, []);
                assert.equal(readSites.length, 1, readSites.join('\n\n'));
                assert.ok(readSites[0].includes('captureTaskTimelineRead'), readSites[0]);
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    });

    describe('readJsonArtifact', () => {
        it('reads valid JSON artifact', () => {
            const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-ce-'));
            const artifactPath = path.join(tmpDir, 'artifact.json');
            fs.writeFileSync(artifactPath, JSON.stringify({ status: 'PASSED', outcome: 'PASS' }), 'utf8');
            const errors: string[] = [];
            const result = readJsonArtifact(artifactPath, 'Test', errors);
            assert.deepEqual(result, { status: 'PASSED', outcome: 'PASS' });
            assert.equal(errors.length, 0);
            fs.rmSync(tmpDir, { recursive: true });
        });

        it('returns null and pushes error for missing required artifact', () => {
            const errors: string[] = [];
            const result = readJsonArtifact('/nonexistent/art.json', 'Test', errors);
            assert.equal(result, null);
            assert.equal(errors.length, 1);
            assert.ok(errors[0].includes('not found'));
        });

        it('returns null without error for missing optional artifact', () => {
            const errors: string[] = [];
            const result = readJsonArtifact('/nonexistent/art.json', 'Test', errors, { required: false });
            assert.equal(result, null);
            assert.equal(errors.length, 0);
        });

        it('returns null and pushes error for invalid JSON', () => {
            const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-ce-'));
            const artifactPath = path.join(tmpDir, 'bad.json');
            fs.writeFileSync(artifactPath, 'not json{', 'utf8');
            const errors: string[] = [];
            const result = readJsonArtifact(artifactPath, 'Test', errors);
            assert.equal(result, null);
            assert.equal(errors.length, 1);
            assert.ok(errors[0].includes('not valid JSON'));
            fs.rmSync(tmpDir, { recursive: true });
        });
    });

    describe('ensurePassedArtifactStatus', () => {
        it('does nothing for null artifact', () => {
            const errors: string[] = [];
            ensurePassedArtifactStatus(null, 'Test', errors);
            assert.equal(errors.length, 0);
        });

        it('passes for correct status and outcome', () => {
            const errors: string[] = [];
            ensurePassedArtifactStatus({ status: 'PASSED', outcome: 'PASS' }, 'Test', errors);
            assert.equal(errors.length, 0);
        });

        it('detects wrong status', () => {
            const errors: string[] = [];
            ensurePassedArtifactStatus({ status: 'FAILED', outcome: 'PASS' }, 'Test', errors);
            assert.equal(errors.length, 1);
            assert.ok(errors[0].includes('FAILED'));
        });

        it('detects wrong outcome', () => {
            const errors: string[] = [];
            ensurePassedArtifactStatus({ status: 'PASSED', outcome: 'FAIL' }, 'Test', errors);
            assert.equal(errors.length, 1);
            assert.ok(errors[0].includes('FAIL'));
        });
    });

    describe('readOptionalArtifactStringField', () => {
        it('returns null for null artifact', () => {
            assert.equal(readOptionalArtifactStringField(null, 'field'), null);
        });

        it('returns null for non-string field', () => {
            assert.equal(readOptionalArtifactStringField({ field: 42 }, 'field'), null);
        });

        it('returns null for empty string field', () => {
            assert.equal(readOptionalArtifactStringField({ field: '   ' }, 'field'), null);
        });

        it('returns trimmed value for valid string', () => {
            assert.equal(readOptionalArtifactStringField({ field: '  hello  ' }, 'field'), 'hello');
        });
    });

    describe('normalizeTimelineDetailString', () => {
        it('returns null for falsy values', () => {
            assert.equal(normalizeTimelineDetailString(null), null);
            assert.equal(normalizeTimelineDetailString(undefined), null);
            assert.equal(normalizeTimelineDetailString(''), null);
        });

        it('trims and returns non-empty string', () => {
            assert.equal(normalizeTimelineDetailString('  hello  '), 'hello');
        });

        it('converts non-string to string', () => {
            assert.equal(normalizeTimelineDetailString(42), '42');
        });
    });

    describe('getTimelineSkillId', () => {
        it('returns null when no details', () => {
            const event: TimelineEventEntry = { event_type: 'X', timestamp_utc: '', sequence: 0, details: null };
            assert.equal(getTimelineSkillId(event), null);
        });

        it('returns lowercase skill_id', () => {
            const event: TimelineEventEntry = { event_type: 'X', timestamp_utc: '', sequence: 0, details: { skill_id: 'Code-Review' } };
            assert.equal(getTimelineSkillId(event), 'code-review');
        });

        it('falls back to skillId', () => {
            const event: TimelineEventEntry = { event_type: 'X', timestamp_utc: '', sequence: 0, details: { skillId: 'Security-Review' } };
            assert.equal(getTimelineSkillId(event), 'security-review');
        });
    });

    describe('getTimelineReferencePath', () => {
        it('returns null when no details', () => {
            const event: TimelineEventEntry = { event_type: 'X', timestamp_utc: '', sequence: 0, details: null };
            assert.equal(getTimelineReferencePath(event), null);
        });

        it('returns normalized lowercase reference path', () => {
            const event: TimelineEventEntry = { event_type: 'X', timestamp_utc: '', sequence: 0, details: { reference_path: 'some/Path.md' } };
            const result = getTimelineReferencePath(event);
            assert.ok(result);
            assert.equal(result, result.toLowerCase());
        });
    });

    describe('eventMatchesStage', () => {
        it('matches exact event type', () => {
            const entry: TimelineEventEntry = { event_type: 'COMPILE_GATE_PASSED', timestamp_utc: '', sequence: 0, details: null };
            assert.equal(eventMatchesStage(entry, 'COMPILE_GATE_PASSED'), true);
            assert.equal(eventMatchesStage(entry, 'TASK_MODE_ENTERED'), false);
        });

        it('REVIEW_GATE_PASSED matches override variant', () => {
            const entry: TimelineEventEntry = { event_type: 'REVIEW_GATE_PASSED_WITH_OVERRIDE', timestamp_utc: '', sequence: 0, details: null };
            assert.equal(eventMatchesStage(entry, 'REVIEW_GATE_PASSED'), true);
        });
    });

    describe('eventMatchesReviewSkill', () => {
        it('matches by skill_id', () => {
            const event: TimelineEventEntry = { event_type: 'SKILL_SELECTED', timestamp_utc: '', sequence: 0, details: { skill_id: 'code-review' } };
            assert.equal(eventMatchesReviewSkill(event, ['code-review']), true);
            assert.equal(eventMatchesReviewSkill(event, ['db-review']), false);
        });

        it('matches by reference_path containing skill path', () => {
            const event: TimelineEventEntry = {
                event_type: 'SKILL_REFERENCE_LOADED',
                timestamp_utc: '',
                sequence: 0,
                details: { reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md' }
            };
            assert.equal(eventMatchesReviewSkill(event, ['code-review']), true);
            assert.equal(eventMatchesReviewSkill(event, ['db-review']), false);
        });
    });

    describe('findLatestTimelineEvent', () => {
        const events: TimelineEventEntry[] = [
            { event_type: 'A', timestamp_utc: '', sequence: 0, details: null },
            { event_type: 'B', timestamp_utc: '', sequence: 1, details: null },
            { event_type: 'A', timestamp_utc: '', sequence: 2, details: null }
        ];

        it('finds last matching event', () => {
            const result = findLatestTimelineEvent(events, e => e.event_type === 'A');
            assert.equal(result?.sequence, 2);
        });

        it('returns null when no match', () => {
            const result = findLatestTimelineEvent(events, e => e.event_type === 'Z');
            assert.equal(result, null);
        });
    });

    describe('findLatestStageOccurrence', () => {
        const events: TimelineEventEntry[] = [
            { event_type: 'TASK_MODE_ENTERED', timestamp_utc: '', sequence: 0, details: null },
            { event_type: 'COMPILE_GATE_PASSED', timestamp_utc: '', sequence: 1, details: null },
            { event_type: 'COMPILE_GATE_PASSED', timestamp_utc: '', sequence: 2, details: null }
        ];

        it('finds latest below upper bound', () => {
            const result = findLatestStageOccurrence(events, 'COMPILE_GATE_PASSED', 2);
            assert.equal(result?.sequence, 1);
        });

        it('returns null when no match below bound', () => {
            const result = findLatestStageOccurrence(events, 'COMPILE_GATE_PASSED', 1);
            assert.equal(result, null);
        });
    });

    describe('findLatestStageOccurrenceInRange', () => {
        const events: TimelineEventEntry[] = [
            { event_type: 'A', timestamp_utc: '', sequence: 0, details: null },
            { event_type: 'A', timestamp_utc: '', sequence: 1, details: null },
            { event_type: 'A', timestamp_utc: '', sequence: 2, details: null },
            { event_type: 'A', timestamp_utc: '', sequence: 3, details: null }
        ];

        it('finds latest in range', () => {
            const result = findLatestStageOccurrenceInRange(events, 'A', 0, 3);
            assert.equal(result?.sequence, 2);
        });

        it('returns null when range empty', () => {
            const result = findLatestStageOccurrenceInRange(events, 'A', 2, 3);
            assert.equal(result, null);
        });
    });

    describe('findLatestRecordedReviewContextPath', () => {
        it('finds latest review context path for matching key', () => {
            const events: TimelineEventEntry[] = [
                {
                    event_type: 'REVIEW_RECORDED',
                    timestamp_utc: '',
                    sequence: 0,
                    details: { review_type: 'code', review_context_path: '/first/path.json' }
                },
                {
                    event_type: 'REVIEW_RECORDED',
                    timestamp_utc: '',
                    sequence: 1,
                    details: { review_type: 'code', review_context_path: '/second/path.json' }
                }
            ];
            assert.equal(findLatestRecordedReviewContextPath(events, 'code'), '/second/path.json');
        });

        it('returns null for non-matching key', () => {
            const events: TimelineEventEntry[] = [
                {
                    event_type: 'REVIEW_RECORDED',
                    timestamp_utc: '',
                    sequence: 0,
                    details: { review_type: 'code', review_context_path: '/path.json' }
                }
            ];
            assert.equal(findLatestRecordedReviewContextPath(events, 'security'), null);
        });
    });

    describe('re-export backward compatibility', () => {
        it('completion.ts re-exports all evidence helpers', async () => {
            const completion = await import('../../../../src/gates/completion');
            assert.equal(typeof completion.collectOrderedTimelineEvents, 'function');
            assert.equal(typeof completion.readJsonArtifact, 'function');
            assert.equal(typeof completion.ensurePassedArtifactStatus, 'function');
            assert.equal(typeof completion.readOptionalArtifactStringField, 'function');
            assert.equal(typeof completion.normalizeTimelineDetailString, 'function');
            assert.equal(typeof completion.getTimelineSkillId, 'function');
            assert.equal(typeof completion.getTimelineReferencePath, 'function');
            assert.equal(typeof completion.eventMatchesReviewSkill, 'function');
            assert.equal(typeof completion.eventMatchesStage, 'function');
            assert.equal(typeof completion.findLatestTimelineEvent, 'function');
            assert.equal(typeof completion.findLatestStageOccurrence, 'function');
            assert.equal(typeof completion.findLatestStageOccurrenceInRange, 'function');
            assert.equal(typeof completion.findLatestRecordedReviewContextPath, 'function');
        });
    });
});
