import { writeContainedFile } from '../../core/contained-filesystem';
import { withLifecycleRuntimeMutationGenerationForPath } from '../runtime-mutation-generation';
import type { UpdatePipelineStageResult } from './update-execution';
import type { ResolvedUpdateSources } from './update-source';
import type { UpdateAnnouncements } from './update-announcements';

interface UpdateTrustContext {
    policy: string;
    overrideUsed: boolean;
    overrideSource: string;
    sourceType: string;
    sourceReference: string;
    gitCommitSha?: string | null;
    requestedPackageSpec?: string | null;
    exactPackageSpec?: string | null;
    resolvedPackageVersion?: string | null;
    resolvedPackageIntegrity?: string | null;
    releaseProvenanceStatus?: string | null;
    releaseProvenanceSummary?: string | null;
    releaseProvenanceRecommendation?: string | null;
}

export interface UpdateReportData {
    normalizedTarget: string;
    initAnswersResolvedPath: string;
    rollbackSnapshotRelativePath: string;
    rollbackRecordsRelativePath: string;
    rollbackRecordCount: number;
    rollbackStatus: string;
    trustContext: UpdateTrustContext;
    previousVersion: string;
    previousVersionSource: string;
    bundleVersion: string;
    stageResult: UpdatePipelineStageResult & { rollbackStatus: string };
    announcements?: UpdateAnnouncements;
}

export function buildUpdateReportLines(data: UpdateReportData): string[] {
    const { trustContext, stageResult } = data;
    const announcements = data.announcements || {
        updateMessages: [],
        releaseNotes: [],
        warnings: []
    };

    const lines = [
        '# Update Report',
        '',
        `GeneratedAt: ${new Date().toISOString()}`,
        `TargetRoot: ${data.normalizedTarget}`,
        `InitAnswersPath: ${data.initAnswersResolvedPath}`,
        `RollbackSnapshotPath: ${data.rollbackSnapshotRelativePath}`,
        `RollbackRecordsPath: ${data.rollbackRecordsRelativePath}`,
        `RollbackSnapshotRecordCount: ${data.rollbackRecordCount}`,
        `RollbackStatus: ${stageResult.rollbackStatus}`,
        '',
        '## Trust',
        `SourceType: ${trustContext.sourceType}`,
        `SourceReference: ${trustContext.sourceReference}`,
        `GitCommitSha: ${trustContext.gitCommitSha || 'n/a'}`,
        `RequestedPackageSpec: ${trustContext.requestedPackageSpec || 'n/a'}`,
        `ExactPackageSpec: ${trustContext.exactPackageSpec || 'n/a'}`,
        `ResolvedPackageVersion: ${trustContext.resolvedPackageVersion || 'n/a'}`,
        `ResolvedPackageIntegrity: ${trustContext.resolvedPackageIntegrity || 'n/a'}`,
        `ReleaseProvenanceStatus: ${trustContext.releaseProvenanceStatus || 'n/a'}`,
        `ReleaseProvenanceSummary: ${trustContext.releaseProvenanceSummary || 'n/a'}`,
        `ReleaseProvenanceRecommendation: ${trustContext.releaseProvenanceRecommendation || 'n/a'}`,
        `TrustPolicy: ${trustContext.policy}`,
        `TrustOverrideUsed: ${trustContext.overrideUsed ? 'yes' : 'no'}`,
        `TrustOverrideSource: ${trustContext.overrideSource}`,
        '',
        '## Version',
        `PreviousVersion: ${data.previousVersion}`,
        `PreviousVersionSource: ${data.previousVersionSource}`,
        `BundleVersion: ${data.bundleVersion}`,
        `UpdatedVersion: ${stageResult.updatedVersion}`,
        '',
        '## CommandStatus',
        `Install: ${stageResult.installStatus}`,
        `Materialization: ${stageResult.materializationStatus}`,
        `WorkflowConfigMerge: ${stageResult.workflowConfigMergeStatus || 'n/a'}`,
        `OptionalQualityChecksNotice: ${stageResult.optionalQualityChecksNotice || 'n/a'}`,
        `ContractMigrations: ${stageResult.contractMigrationStatus}`,
        `Verify: ${stageResult.verifyStatus}`,
        `ManifestValidation: ${stageResult.manifestStatus}`,
        `InvariantCheck: ${stageResult.invariantStatus}`,
        '',
        '## ProjectMemory',
        `Maintenance: ${stageResult.projectMemoryMaintenanceSummaryLine || 'n/a'}`,
        `RefreshHandoffPrompt: ${stageResult.projectMemoryRefreshHandoffPrompt || 'n/a'}`,
        stageResult.projectMemoryDiagnostics
            ? `BootstrapReport: ${stageResult.projectMemoryDiagnostics.bootstrapReportPath || 'n/a'}`
            : 'BootstrapReport: n/a',
        stageResult.projectMemoryDiagnostics
            ? `CopiedMissingFiles: ${stageResult.projectMemoryDiagnostics.copiedFiles.length > 0 ? stageResult.projectMemoryDiagnostics.copiedFiles.join(', ') : 'none'}`
            : 'CopiedMissingFiles: n/a',
        stageResult.projectMemoryDiagnostics
            ? `PreservedUserOwnedFiles: ${stageResult.projectMemoryDiagnostics.preservedFiles.length}`
            : 'PreservedUserOwnedFiles: n/a',
        stageResult.projectMemoryDiagnostics
            ? `MissingTemplateFiles: ${stageResult.projectMemoryDiagnostics.missingTemplateFiles.length > 0 ? stageResult.projectMemoryDiagnostics.missingTemplateFiles.join(', ') : 'none'}`
            : 'MissingTemplateFiles: n/a',
        stageResult.projectMemoryDiagnostics
            ? `TemplateUpdateNotices: ${stageResult.projectMemoryDiagnostics.templateUpdateNotices.length > 0 ? stageResult.projectMemoryDiagnostics.templateUpdateNotices.join('; ') : 'none'}`
            : 'TemplateUpdateNotices: n/a',
        '',
        '## ContractMigrations',
        `AppliedCount: ${stageResult.contractMigrationCount}`,
        stageResult.contractMigrationFiles.length > 0
            ? `AppliedFiles: ${stageResult.contractMigrationFiles.join(', ')}`
            : 'AppliedFiles: none'
    ];

    if (announcements.updateMessages.length > 0) {
        lines.push('', '## UpdateMessages');
        for (const entry of announcements.updateMessages) {
            lines.push(`### ${entry.version} - ${entry.title}`);
            for (const bodyLine of entry.body) {
                lines.push(`- ${bodyLine}`);
            }
        }
    }

    if (announcements.releaseNotes.length > 0) {
        lines.push('', '## ReleaseNotes');
        for (const entry of announcements.releaseNotes) {
            lines.push(`### ${entry.version}`);
            for (const noteLine of entry.lines) {
                lines.push(noteLine);
            }
        }
    }

    if (announcements.warnings.length > 0) {
        lines.push('', '## AnnouncementWarnings');
        for (const warning of announcements.warnings) {
            lines.push(`- ${warning}`);
        }
    }

    return lines;
}

export function writeUpdateReport(updateReportPath: string, data: UpdateReportData): void {
    withLifecycleRuntimeMutationGenerationForPath(
        updateReportPath,
        'lifecycle-update-report-write',
        () => {
            const reportLines = buildUpdateReportLines(data);
            writeContainedFile(data.normalizedTarget, updateReportPath, reportLines.join('\r\n'));
        }
    );
}

export interface UpdateResultInput {
    normalizedTarget: string;
    sources: ResolvedUpdateSources;
    trustContext: UpdateTrustContext;
    rollbackSnapshotRelativePath: string;
    rollbackRecordsRelativePath: string;
    rollbackSnapshotCreated: boolean;
    rollbackRecordCount: number;
    stageResult: UpdatePipelineStageResult & { rollbackStatus: string };
    dryRun: boolean;
    updateReportRelativePath: string;
    announcements?: UpdateAnnouncements;
}

export function buildUpdateResult(input: UpdateResultInput) {
    const { sources, trustContext, stageResult } = input;
    const announcements = input.announcements || {
        updateMessages: [],
        releaseNotes: [],
        warnings: []
    };

    return {
        targetRoot: input.normalizedTarget,
        initAnswersPath: sources.initAnswersResolvedPath,
        rollbackSnapshotPath: input.rollbackSnapshotRelativePath,
        rollbackRecordsPath: input.dryRun ? 'not-generated-in-dry-run' : input.rollbackRecordsRelativePath,
        rollbackSnapshotCreated: input.rollbackSnapshotCreated,
        rollbackRecordCount: input.rollbackRecordCount,
        rollbackStatus: stageResult.rollbackStatus,
        assistantLanguage: sources.assistantLanguage,
        assistantBrevity: sources.assistantBrevity,
        sourceOfTruth: sources.sourceOfTruth,
        trustPolicy: trustContext.policy,
        trustOverrideUsed: trustContext.overrideUsed,
        trustOverrideSource: trustContext.overrideSource,
        gitCommitSha: trustContext.gitCommitSha || null,
        requestedPackageSpec: trustContext.requestedPackageSpec || null,
        exactPackageSpec: trustContext.exactPackageSpec || null,
        resolvedPackageVersion: trustContext.resolvedPackageVersion || null,
        resolvedPackageIntegrity: trustContext.resolvedPackageIntegrity || null,
        releaseProvenanceStatus: trustContext.releaseProvenanceStatus || null,
        releaseProvenanceSummary: trustContext.releaseProvenanceSummary || null,
        releaseProvenanceRecommendation: trustContext.releaseProvenanceRecommendation || null,
        previousVersion: sources.previousVersion,
        previousVersionSource: sources.previousVersionSource,
        bundleVersion: sources.bundleVersion,
        updatedVersion: stageResult.updatedVersion,
        installStatus: stageResult.installStatus,
        materializationStatus: stageResult.materializationStatus,
        workflowConfigMergeStatus: stageResult.workflowConfigMergeStatus,
        optionalQualityChecksNotice: stageResult.optionalQualityChecksNotice || null,
        projectMemoryMaintenanceSummaryLine: stageResult.projectMemoryMaintenanceSummaryLine || null,
        projectMemoryRefreshHandoffPrompt: stageResult.projectMemoryRefreshHandoffPrompt || null,
        projectMemoryDiagnostics: stageResult.projectMemoryDiagnostics || null,
        contractMigrationStatus: stageResult.contractMigrationStatus,
        contractMigrationCount: stageResult.contractMigrationCount,
        contractMigrationFiles: stageResult.contractMigrationFiles,
        verifyStatus: stageResult.verifyStatus,
        manifestValidationStatus: stageResult.manifestStatus,
        updateReportPath: input.dryRun ? 'not-generated-in-dry-run' : input.updateReportRelativePath,
        updateMessages: announcements.updateMessages,
        releaseNotes: announcements.releaseNotes,
        updateAnnouncementWarnings: announcements.warnings
    };
}
