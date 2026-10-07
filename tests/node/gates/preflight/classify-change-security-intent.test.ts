import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyChange } from '../../../../src/gates/preflight/classify-change';
import {
    classifySecurityReviewIntent,
    hasSecurityReviewIntent,
    type SecurityReviewIntentReason
} from '../../../../src/gates/preflight/classify-change-intent';
import { mergeReviewPolicy } from '../../../../src/policy/profile-resolver';
import {
    defaultCapabilities,
    makeConfig
} from './classify-change-test-support';

function classifyRuntimeIntent(
    taskIntent: string,
    reviewCapabilities = defaultCapabilities,
    normalizedFiles = ['src/workflow/recovery.ts']
) {
    return classifyChange({
        normalizedFiles,
        taskIntent,
        changedLinesTotal: 24,
        additionsTotal: 16,
        deletionsTotal: 8,
        renameCount: 0,
        detectionSource: 'explicit_changed_files',
        classificationConfig: makeConfig(),
        reviewCapabilities
    });
}

describe('security review task-intent classification', () => {
    it('keeps explicit security review intent on unfamiliar source outside runtime roots', () => {
        const result = classifyRuntimeIntent(
            'Require security review for trust boundary validation',
            defaultCapabilities,
            ['module/parser.custom']
        );

        assert.equal(result.scope_category, 'code');
        assert.equal(result.triggers.security_intent, true);
        assert.equal(result.required_reviews.security, true);
        assert.equal(result.required_reviews.code, true);
        assert.equal(result.triggers.runtime_code_changed, false);
    });

    it('rejects security review downgrade for unfamiliar source mixed with ordinary documentation', () => {
        const result = classifyRuntimeIntent(
            '[security] Follow up high F-001: Reject forged source evidence',
            defaultCapabilities,
            ['project/validator', 'README.md']
        );

        assert.equal(result.scope_category, 'mixed');
        assert.equal(result.triggers.security_intent, true);
        assert.equal(result.required_reviews.security, true);
        assert.equal(result.required_reviews.code, true);
    });

    it('recognizes the exact structured follow-up shape that created T-979-17-F1', () => {
        const taskIntent =
            '[security] Follow up medium F-001: Dirty-baseline command scope preserves outside-root paths';

        const result = classifyRuntimeIntent(taskIntent);

        assert.equal(result.triggers.security, true);
        assert.equal(result.triggers.security_intent, true);
        assert.deepEqual(result.triggers.security_intent_reasons, [
            'explicit_security_follow_up_prefix',
            'path_containment_remediation'
        ]);
        assert.equal(result.required_reviews.security, true);
    });

    it('treats a structured security prefix as explicit intent without substantive wording', () => {
        const taskIntent = '[security] Follow up low F-009: Clarify the task wording';

        const classification = classifySecurityReviewIntent(taskIntent);
        const result = classifyRuntimeIntent(taskIntent);

        assert.deepEqual(classification, {
            triggered: true,
            reasons: ['explicit_security_follow_up_prefix']
        });
        assert.equal(result.triggers.security_intent, true);
        assert.deepEqual(result.triggers.security_intent_reasons, [
            'explicit_security_follow_up_prefix'
        ]);
        assert.equal(result.required_reviews.security, true);
    });

    it('recognizes equivalent structured and localized security follow-up titles', () => {
        const cases = [
            '[SECURITY] Follow-up high F-002: Reject a forged reviewer identity',
            'Security follow-up: bind delegated reviewer identity to the current attempt',
            '[security] Исправить выход пути за корень репозитория'
        ];

        for (const taskIntent of cases) {
            const classification = classifySecurityReviewIntent(taskIntent);

            assert.equal(classification.triggered, true, taskIntent);
            assert.ok(
                classification.reasons.includes('explicit_security_follow_up_prefix'),
                taskIntent
            );
            assert.equal(hasSecurityReviewIntent(taskIntent), true, taskIntent);
        }
    });

    it('recognizes deliberate security-review requests and substantive remediation intent', () => {
        const cases = new Map<string, SecurityReviewIntentReason>([
            [
                'Require security review for explicit security follow-up intent',
                'explicit_security_review_request'
            ],
            [
                'Enforce the authorization boundary before privileged recovery',
                'authorization_boundary_remediation'
            ],
            [
                'Bind provider attestation at the delegated-review trust boundary',
                'trust_boundary_remediation'
            ],
            [
                'Reject adversarial path traversal and symlink escape inputs',
                'adversarial_path_remediation'
            ],
            [
                'Keep dirty-baseline paths contained inside the repository root',
                'path_containment_remediation'
            ]
        ]);

        for (const [taskIntent, expectedReason] of cases) {
            const classification = classifySecurityReviewIntent(taskIntent);

            assert.equal(classification.triggered, true, taskIntent);
            assert.ok(classification.reasons.includes(expectedReason), taskIntent);
            assert.equal(classifyRuntimeIntent(taskIntent).required_reviews.security, true, taskIntent);
        }
    });

    it('recognizes realpath, symlink, and junction containment remediation without broad alias matches', () => {
        const positiveCases = [
            'Recognize realpath-containment remediation as mandatory security-review intent',
            'Harden symlink boundary validation for outside-root targets',
            'Reject junction aliases that escape the workspace root',
            'Prevent repository root escape through directory junctions',
            'Validate realpath containment checks',
            'Verify symlink boundary enforcement',
            'Repair junction root escape validation',
            'Update realpath containment checks',
            'Fix realpath containment validation and update docs',
            'Update docs and fix symlink boundary validation',
            'Update docs, then fix realpath containment validation',
            'Update docs — repair junction boundary enforcement',
            'Fix realpath containment validation',
            'Fix symlink boundary validation',
            'Fix realpath containment validation with documentation updates',
            'Harden symlink boundary validation with docs updates',
            'Fix path containment validation with docs updates',
            'Update docs and harden path containment validation',
            'Fix realpath containment',
            'Update symlink containment',
            'Please fix realpath containment validation',
            'Ensure symlink boundary validation',
            'We need to repair junction containment',
            'Task: update realpath containment checks',
            'Prevent junctions from leaving the workspace root',
            'Fix symlinks that leave the project root',
            'Block realpaths beyond the repository root',
            'Update docs: fix path containment'
        ];
        const negativeCases = [
            'Document how realpath values are displayed',
            'Document realpath-containment terminology for operators',
            'Fix the realpath-containment terminology in the operator guide',
            'Fix realpath containment validation wording in the operator guide',
            'Update realpath containment terminology in the operator guide',
            'Update realpath containment terminology, labels, and guide examples',
            'Harden realpath boundary documentation',
            'Harden realpath containment validation documentation',
            'Fix documentation for realpath containment validation',
            'Document path containment terminology for operators',
            'Document path containment validation for operators',
            'Fix path containment validation wording in the operator guide',
            'Please document how to harden realpath-containment checks',
            'Ensure realpath containment documentation is updated',
            'Please ensure documentation for realpath containment is updated',
            'Document how junctions can leave the workspace root',
            'Update the operator guide for junctions leaving the workspace root',
            'Fix junction labels that leave the workspace root column',
            'Fix realpath containment in the documentation',
            'Update realpath containment within the operator guide',
            'Fix symlink boundary validation for the developer guide',
            'Update docs: realpath containment',
            'Discuss path containment options',
            'Review path containment alternatives',
            'Document how to harden realpath-containment checks',
            'Rename the junction boundary helper used by layout rendering',
            'Fix the junction boundary helper used by layout rendering',
            'Harden the symlink boundary helper',
            'Prevent junction boundary rendering regressions',
            'Update the operator guide to prevent junction root escapes',
            'Add symlink examples to the documentation',
            'Validate junction labels in the diagnostics table',
            'Update the realpath cache benchmark'
        ];

        for (const taskIntent of positiveCases) {
            const classification = classifySecurityReviewIntent(taskIntent);

            assert.equal(classification.triggered, true, taskIntent);
            assert.ok(
                classification.reasons.includes('path_containment_remediation'),
                taskIntent
            );
            assert.equal(classifyRuntimeIntent(taskIntent).required_reviews.security, true, taskIntent);
        }

        for (const taskIntent of negativeCases) {
            const classification = classifySecurityReviewIntent(taskIntent);

            assert.deepEqual(classification, {
                triggered: false,
                reasons: []
            }, taskIntent);
            assert.equal(classifyRuntimeIntent(taskIntent).required_reviews.security, false, taskIntent);
        }
    });

    it('rejects the false-positive failure path for incidental junction boundary helper wording', () => {
        const taskIntent = 'Fix the junction boundary helper used by layout rendering';

        assert.deepEqual(classifySecurityReviewIntent(taskIntent), {
            triggered: false,
            reasons: []
        });
        assert.equal(classifyRuntimeIntent(taskIntent).required_reviews.security, false);
    });

    it('rejects action-qualified realpath-containment documentation wording', () => {
        const taskIntent = 'Fix realpath containment validation wording in the operator guide';

        assert.deepEqual(classifySecurityReviewIntent(taskIntent), {
            triggered: false,
            reasons: []
        });
        assert.equal(classifyRuntimeIntent(taskIntent).required_reviews.security, false);
    });

    it('recognizes recovery, evidence-integrity, and artifact-trust intent on neutral runtime paths', () => {
        const cases = new Map<string, SecurityReviewIntentReason>([
            ['Fix recovery state replay in the catalog module', 'recovery_control_plane_change'],
            ['Recovery flow must reject stale evidence in the catalog module', 'recovery_control_plane_change'],
            ['Validate evidence integrity before catalog state is accepted', 'evidence_integrity_change'],
            ['Bind artifact trust to canonical catalog reconstruction', 'artifact_trust_change']
        ]);

        for (const [taskIntent, expectedReason] of cases) {
            const result = classifyRuntimeIntent(taskIntent, defaultCapabilities, ['src/domain/catalog.ts']);

            assert.equal(result.triggers.security_intent, true, taskIntent);
            assert.ok(result.triggers.security_intent_reasons.includes(expectedReason), taskIntent);
            assert.equal(result.required_reviews.security, true, taskIntent);
        }
    });

    it('does not trigger from vague or incidental words in unrelated runtime tasks', () => {
        const cases = [
            'Update security documentation wording in the runtime report',
            'Refactor the path formatter for shorter labels',
            'Preserve operator trust in the release notes',
            'Rename the boundary helper used by layout rendering',
            'Add a follow-up section to the task summary',
            'Restart review cycle after compile remediation',
            'Restart review cycle with API review blocked behind code'
        ];

        for (const taskIntent of cases) {
            const classification = classifySecurityReviewIntent(taskIntent);

            assert.deepEqual(classification, {
                triggered: false,
                reasons: []
            }, taskIntent);
            assert.equal(classifyRuntimeIntent(taskIntent).required_reviews.security, false, taskIntent);
        }
    });

    it('keeps intent evidence alongside stricter path-based security triggers', () => {
        const result = classifyRuntimeIntent(
            '[security] Follow up high F-003: Enforce authorization boundary checks',
            defaultCapabilities,
            ['src/security/authorization/recovery.ts']
        );

        assert.equal(result.triggers.security, true);
        assert.deepEqual(result.triggers.security_intent_reasons, [
            'explicit_security_follow_up_prefix',
            'authorization_boundary_remediation'
        ]);
        assert.equal(result.required_reviews.security, true);
    });

    it('fails closed when a custom profile tries to disable security for code-changing scope', () => {
        const { merged, floorsApplied } = mergeReviewPolicy(
            {
                code: false,
                db: false,
                security: false,
                refactor: false
            },
            { ...defaultCapabilities, security: false },
            true
        );

        assert.equal(merged.security, true);
        assert.ok(floorsApplied.some((reason) => reason.startsWith('security:')));
    });

    it('keeps an explicit security intent required when the capability catalog disables the lane', () => {
        const result = classifyRuntimeIntent(
            '[security] Follow up medium F-004: Reject an outside-root path alias',
            { ...defaultCapabilities, security: false }
        );

        assert.equal(result.metrics.review_capabilities.security, false);
        assert.equal(result.triggers.security, true);
        assert.equal(result.required_reviews.security, true);
    });
});
