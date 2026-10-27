import * as fs from 'node:fs';
import * as path from 'node:path';

import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import { appendMandatoryTaskEvent } from '../../../../gate-runtime/task-events';
import {
    QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE,
    assertQualityChecklistAnswersPathHasNoSymlinks,
    assessQualityChecklistAnswersTemplate,
    buildQualityChecklistArtifact,
    formatQualityChecklistResult,
    resolveDefaultQualityChecklistArtifactPath
} from '../../../../gates/quality-checklist';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    resolveDefaultMetricsPath,
    writeJsonArtifact
} from '../../../gate-cli/gates-artifacts';
import { parseBooleanOption } from '../../../gate-cli/gates-parser';
import { requireResolvedPath } from '../../shared-command-utils';
import {
    appendMetricsIfEnabled,
    resolveOrchestratorRoot
} from '../compile/gate-flow-helpers';

export interface QualityChecklistCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    preflightPath?: unknown;
    answersJson?: unknown;
    answersPath?: unknown;
    answersStdin?: unknown;
    answersStdinText?: unknown;
    actionTaken?: unknown;
    actionsTaken?: unknown;
    actionRequired?: unknown;
    actionsRequired?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

function parseAnswersJson(value: unknown, label = 'AnswersJson'): unknown {
    const raw = String(value || '').trim();
    if (!raw) {
        return [];
    }
    try {
        return JSON.parse(raw);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label} must be valid JSON: ${message}`);
    }
}

function toArray(value: unknown): unknown[] {
    if (Array.isArray(value)) {
        return value;
    }
    return value == null ? [] : [value];
}

function resolveQualityChecklistOutputPath(pathValue: string, repoRoot: string, label: string): string {
    return requireResolvedPath(
        gateHelpers.resolvePathInsideRepo(pathValue, repoRoot, { allowMissing: true, enforceInside: true }),
        label
    );
}

function hasTextInput(value: unknown): boolean {
    return String(value ?? '').trim().length > 0;
}

function resolveAnswersPath(pathValue: unknown, repoRoot: string): string {
    const rawPath = String(pathValue || '').trim();
    if (!rawPath) {
        throw new Error('AnswersPath must not be empty.');
    }
    try {
        return requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(rawPath, repoRoot, { allowMissing: false, enforceInside: true }),
            'AnswersPath'
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('Path must resolve inside repo root')) {
            throw new Error(`AnswersPath must resolve inside repo root: ${gateHelpers.normalizePath(rawPath)}`);
        }
        throw error;
    }
}

function realpathSync(pathValue: string): string {
    return fs.realpathSync.native(pathValue);
}

function resolveRealAnswersPathInsideRepo(answersPath: string, repoRoot: string): string {
    const repoRealPath = realpathSync(repoRoot);
    const answersRealPath = realpathSync(answersPath);
    if (!gateHelpers.isPathInsideRoot(answersRealPath, repoRealPath)) {
        throw new Error(`AnswersPath must resolve inside repo root: ${gateHelpers.normalizePath(answersPath)}`);
    }
    return answersRealPath;
}

function readAnswersPath(pathValue: unknown, repoRoot: string): string {
    const answersPath = resolveAnswersPath(pathValue, repoRoot);
    assertQualityChecklistAnswersPathHasNoSymlinks(answersPath, repoRoot);
    const realAnswersPath = resolveRealAnswersPathInsideRepo(answersPath, repoRoot);
    if (!fs.existsSync(realAnswersPath) || !fs.statSync(realAnswersPath).isFile()) {
        throw new Error(`AnswersPath must be an existing file inside the repo root: ${gateHelpers.normalizePath(answersPath)}`);
    }
    return fs.readFileSync(realAnswersPath, 'utf8');
}

function readAnswersStdin(options: QualityChecklistCommandOptions): string {
    if (options.answersStdinText !== undefined) {
        return String(options.answersStdinText);
    }
    return fs.readFileSync(0, 'utf8');
}

function validateTaggedAnswersTemplate(
    value: unknown,
    options: QualityChecklistCommandOptions,
    repoRoot: string
): unknown {
    if (
        typeof value !== 'object'
        || value === null
        || Array.isArray(value)
        || (value as Record<string, unknown>).event_source !== QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE
    ) {
        return value;
    }
    const assessment = assessQualityChecklistAnswersTemplate({
        repoRoot,
        taskId: String(options.taskId || '').trim(),
        preflightPath: options.preflightPath,
        template: value
    });
    if (assessment.status !== 'current') {
        throw new Error(assessment.reason);
    }
    return value;
}

function resolveQualityChecklistAnswers(options: QualityChecklistCommandOptions, repoRoot: string): unknown {
    const inputModes = [
        hasTextInput(options.answersJson) ? '--answers-json' : null,
        hasTextInput(options.answersPath) ? '--answers-path' : null,
        parseBooleanOption(options.answersStdin, false) ? '--answers-stdin' : null
    ].filter((entry): entry is string => Boolean(entry));
    if (inputModes.length > 1) {
        throw new Error(
            `Quality checklist answers input is ambiguous; pass only one of --answers-json, --answers-path, or --answers-stdin. ` +
            `Received: ${inputModes.join(', ')}.`
        );
    }
    if (inputModes.length === 0) {
        return [];
    }
    const parsed = inputModes[0] === '--answers-path'
        ? parseAnswersJson(readAnswersPath(options.answersPath, repoRoot), 'AnswersPath')
        : inputModes[0] === '--answers-stdin'
            ? parseAnswersJson(readAnswersStdin(options), 'AnswersStdin')
            : parseAnswersJson(options.answersJson, 'AnswersJson');
    return validateTaggedAnswersTemplate(parsed, options, repoRoot);
}

export function runQualityChecklistCommand(options: QualityChecklistCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const answers = resolveQualityChecklistAnswers(options, repoRoot);
    const artifact = buildQualityChecklistArtifact({
        repoRoot,
        taskId: String(options.taskId || '').trim(),
        preflightPath: options.preflightPath,
        answers,
        actionsTaken: [
            ...toArray(options.actionTaken),
            ...toArray(options.actionsTaken)
        ],
        actionsRequired: [
            ...toArray(options.actionRequired),
            ...toArray(options.actionsRequired)
        ]
    });

    const artifactPath = options.artifactPath
        ? resolveQualityChecklistOutputPath(options.artifactPath, repoRoot, 'ArtifactPath')
        : resolveDefaultQualityChecklistArtifactPath(repoRoot, artifact.task_id);
    const metricsPath = options.metricsPath
        ? resolveQualityChecklistOutputPath(options.metricsPath, repoRoot, 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    writeJsonArtifact(artifactPath, artifact);

    const artifactHash = gateHelpers.fileSha256(artifactPath);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: artifact.timestamp_utc,
        event_type: 'quality_checklist_recorded',
        task_id: artifact.task_id,
        artifact_path: gateHelpers.normalizePath(artifactPath),
        artifact_hash: artifactHash,
        status: artifact.status,
        outcome: artifact.outcome,
        checklist_id: artifact.checklist_id,
        scope_category: artifact.scope_category,
        enabled_rule_count: artifact.enabled_rule_count,
        active_rule_count: artifact.active_rule_count,
        skipped_by_scope_rule_count: artifact.skipped_by_scope_rule_count,
        answer_count: artifact.answers.length,
        action_required_count: artifact.actions_required.length
    }, parseBooleanOption(options.emitMetrics, true));

    appendMandatoryTaskEvent(
        orchestratorRoot,
        artifact.task_id,
        'QUALITY_CHECKLIST_RECORDED',
        artifact.outcome,
        `Quality checklist recorded: ${artifact.status}.`,
        {
            artifact_path: gateHelpers.normalizePath(artifactPath),
            artifact_hash: artifactHash,
            status: artifact.status,
            outcome: artifact.outcome,
            checklist_id: artifact.checklist_id,
            preflight_path: artifact.preflight_path,
            preflight_sha256: artifact.preflight_sha256,
            workflow_config_path: artifact.workflow_config_path,
            workflow_config_sha256: artifact.workflow_config_sha256,
            changed_files_sha256: artifact.changed_file_evidence.changed_files_sha256,
            changed_files_count: artifact.changed_file_evidence.changed_files_count,
            changed_files_preview: artifact.changed_file_evidence.changed_files.slice(0, 8),
            changed_files_truncated: artifact.changed_file_evidence.changed_files.length > 8,
            scope_sha256: artifact.changed_file_evidence.scope_sha256,
            scope_content_sha256: artifact.changed_file_evidence.scope_content_sha256,
            scope_category: artifact.scope_category,
            enabled_rule_count: artifact.enabled_rule_count,
            active_rule_count: artifact.active_rule_count,
            skipped_by_scope_rule_count: artifact.skipped_by_scope_rule_count,
            answer_count: artifact.answers.length,
            action_required_count: artifact.actions_required.length,
            actions_required: artifact.actions_required,
            action_taken_count: artifact.actions_taken.length,
            actions_taken: artifact.actions_taken,
            violations: artifact.violations
        }
    );

    const outputLines = formatQualityChecklistResult(artifact);
    outputLines.push(`QualityChecklistArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`);
    outputLines.push(`QualityChecklistArtifactSha256: ${artifactHash}`);
    return {
        outputLines,
        exitCode: artifact.status === 'ACTION_REQUIRED' || artifact.status === 'CONFIG_ERROR'
            ? EXIT_GATE_FAILURE
            : 0
    };
}
