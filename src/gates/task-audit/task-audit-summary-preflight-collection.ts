import { countNextStepWork } from '../../core/next-step-measurement';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileSha256 } from '../shared/helpers';
import type { ProfileReviewDecisionSummary } from './task-audit-summary-collectors';
import { safeReadJson } from './task-audit-summary-collectors';

export interface PreflightSummary {
    path: string;
    sha256: string | null;
    raw: Record<string, unknown> | null;
    changedFiles: string[];
    changedFilesCount: number;
    changedLinesTotal: number;
    requiredReviews: Record<string, boolean>;
    scopeCategory: string | null;
    pathMode: string | null;
}

export function readPreflightSummary(reviewsRoot: string, taskId: string): PreflightSummary {
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const preflight = safeReadJson(preflightPath);
    const requiredReviews: Record<string, boolean> = {};

    if (preflight?.required_reviews && typeof preflight.required_reviews === 'object') {
        for (const [key, value] of Object.entries(preflight.required_reviews as Record<string, unknown>)) {
            countNextStepWork('visit:task-audit-summary-preflight-collection:event:25');
            requiredReviews[key] = value === true;
        }
    }

    const changedFiles = Array.isArray(preflight?.changed_files)
        ? preflight.changed_files.map((changedFile: unknown) => String(changedFile))
        : [];
    const metrics = preflight?.metrics && typeof preflight.metrics === 'object'
        ? preflight.metrics as Record<string, unknown>
        : null;

    return {
        path: preflightPath,
        sha256: fs.existsSync(preflightPath) ? fileSha256(preflightPath) : null,
        raw: preflight,
        changedFiles,
        changedFilesCount: changedFiles.length,
        changedLinesTotal: metrics ? Number(metrics.changed_lines_total) || 0 : 0,
        requiredReviews,
        scopeCategory: typeof preflight?.scope_category === 'string' ? preflight.scope_category : null,
        pathMode: typeof preflight?.mode === 'string' && preflight.mode.trim() ? preflight.mode.trim() : null
    };
}

export function readProfileReviewDecisions(
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null,
    scopeCategory: string | null,
    requiredReviews: Record<string, boolean> = {}
): ProfileReviewDecisionSummary | null {
    if (!taskMode || typeof taskMode.active_profile !== 'string' || !taskMode.active_profile) {
        return null;
    }

    const baseSummary = {
        profile_name: String(taskMode.active_profile || ''),
        scope_category: scopeCategory
    };
    const guardrails = preflight?.profile_guardrails && typeof preflight.profile_guardrails === 'object'
        ? preflight.profile_guardrails as Record<string, unknown>
        : null;

    if (!guardrails) {
        return {
            ...baseSummary,
            guardrails_active: false,
            lightening_eligible: false,
            safety_floors_applied: [],
            decisions: []
        };
    }

    const decisions = Array.isArray(guardrails.decisions)
        ? guardrails.decisions.flatMap((decision): ProfileReviewDecisionSummary['decisions'] => {
            if (!decision || typeof decision !== 'object') {
                return [];
            }
            const record = decision as Record<string, unknown>;
            const reviewType = String(record.review_type || '');
            const isRequired = requiredReviews[reviewType] === true;
            const rawEffectiveValue = record.effective_value === true;
            const effectiveValue = isRequired;
            const rawDecision = String(record.decision || '');
            const normalizedDecision = isRequired && !rawEffectiveValue
                ? 'preflight_required'
                : rawEffectiveValue && !isRequired
                    ? 'not_required_by_preflight'
                    : rawDecision;
            const reason = isRequired && !rawEffectiveValue
                ? `${reviewType} review kept because preflight required_reviews.${reviewType}=true`
                : rawEffectiveValue && !isRequired
                    ? `${reviewType} review not required because preflight required_reviews.${reviewType}=false`
                    : undefined;
            return [{
                review_type: reviewType,
                effective_value: effectiveValue,
                decision: normalizedDecision,
                ...(reason ? { reason } : {})
            }];
        })
        : [];
    const decisionTypes = new Set(decisions.map((decision) => decision.review_type));
    for (const [reviewType, isRequired] of Object.entries(requiredReviews)) {
        countNextStepWork('visit:task-audit-summary-preflight-collection:event:108');
        if (isRequired && !decisionTypes.has(reviewType)) {
            decisions.push({
                review_type: reviewType,
                effective_value: true,
                decision: 'preflight_required',
                reason: `${reviewType} review kept because preflight required_reviews.${reviewType}=true`
            });
        }
    }
    const safetyFloorsApplied = Array.isArray(guardrails.safety_floors_applied)
        ? guardrails.safety_floors_applied.map((entry) => String(entry))
        : [];

    return {
        ...baseSummary,
        guardrails_active: guardrails.guardrails_active === true,
        lightening_eligible: guardrails.lightening_eligible === true,
        safety_floors_applied: safetyFloorsApplied,
        decisions
    };
}
