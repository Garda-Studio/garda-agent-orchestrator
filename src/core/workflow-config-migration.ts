import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveBundleNameForTarget, UNCONFIGURED_COMPILE_GATE_COMMAND,
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from './constants';
import { bindContainedDestination } from './contained-filesystem';
import { parseApprovedValidationContract, readValidationFile, validationDigest } from './project-validation-identity';
import { mergeWorkflowConfigWithTemplate, resolveWorkflowConfigTemplateDefaults, type WorkflowConfigData } from './workflow-config';
import { authenticateWorkflowMigration } from './auth/local-commit-availability';
import { withRecoverableFileTransaction } from './recoverable-file-transaction';
import { workflowTransactionPaths, assertWorkflowTransactionReadable } from './workflow-transaction-state';
import { bindCommittedWorkflowConfigAudit, captureWorkflowAuditTaskContext, recordWorkflowConfigAuditStage,
    workflowConfigTextDigest, type WorkflowConfigAuditBinding } from './workflow-config-audit';
import { isSourceCheckoutRoot } from '../validators/workspace-layout/source-runtime';

const MAXIMUM_CONFIG_BYTES = 8 * 1024 * 1024;
const capturedBaselines = new WeakMap<WorkflowConfigMigrationBaseline, { root: string; sha256: string }>();

interface MigrationFile {
    path: string;
    text: string;
    sha256: string;
}

export interface WorkflowConfigMigrationBaseline {
    files: MigrationFile[];
    taskContext: ReturnType<typeof captureWorkflowAuditTaskContext>;
}

export interface ProjectCommandSetupMigration {
    initializeUnconfiguredCommands: boolean;
}

function readConfig(repoRoot: string, relativePath: string): MigrationFile | null {
    if (bindContainedDestination(repoRoot, path.resolve(repoRoot, relativePath)).missingAt) return null;
    const file = readValidationFile(repoRoot, relativePath, MAXIMUM_CONFIG_BYTES);
    return { path: relativePath, text: file.bytes.toString('utf8'), sha256: file.identity.sha256 };
}

export function captureWorkflowConfigMigration(
    repoRoot: string, configurationRoot = repoRoot
): WorkflowConfigMigrationBaseline {
    const bundle = resolveBundleNameForTarget(repoRoot);
    const bundleRoot = path.join(repoRoot, bundle);
    bindContainedDestination(repoRoot, path.resolve(configurationRoot));
    assertWorkflowTransactionReadable(bundleRoot);
    const baseline = {
        files: ['live', 'template'].flatMap(surface => {
            const file = readConfig(configurationRoot, `${bundle}/${surface}/config/workflow-config.json`);
            return file ? [file] : [];
        }),
        taskContext: captureWorkflowAuditTaskContext(bundleRoot, repoRoot)
    };
    capturedBaselines.set(baseline, { root: path.resolve(repoRoot), sha256: validationDigest(baseline) });
    return baseline;
}

function assertManagedDefaultsMigration(
    repoRoot: string, before: MigrationFile, after: MigrationFile, setup?: ProjectCommandSetupMigration
): void {
    if (!before.path.includes('/live/')) return;
    const previous = JSON.parse(before.text) as WorkflowConfigData;
    const current = JSON.parse(after.text) as WorkflowConfigData;
    const bundle = resolveBundleNameForTarget(repoRoot);
    const template = readConfig(repoRoot, `${bundle}/template/config/workflow-config.json`);
    if (!template) throw new Error('Workflow migration requires the installed configuration template.');
    const installedTemplate = JSON.parse(template.text) as WorkflowConfigData;
    const effectiveTemplate = setup?.initializeUnconfiguredCommands
        ? resolveWorkflowConfigTemplateDefaults(installedTemplate) : installedTemplate;
    const expected = mergeWorkflowConfigWithTemplate(effectiveTemplate, previous, {
        preserveLegacyReviewExecutionPolicyOmission: true,
        preserveMovedProjectQualityRulesAsCustom: isSourceCheckoutRoot(repoRoot)
    });
    const previousCommand = previous.compile_gate?.command;
    if (!previousCommand || previousCommand === UNCONFIGURED_COMPILE_GATE_COMMAND) {
        expected.compile_gate = current.compile_gate;
    }
    const previousSuiteCommand = previous.full_suite_validation?.command;
    if (setup?.initializeUnconfiguredCommands
        && (!previousSuiteCommand || previousSuiteCommand === UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND)) {
        expected.full_suite_validation = { ...(expected.full_suite_validation as Record<string, unknown>),
            command: current.full_suite_validation.command };
    }
    if (!isDeepStrictEqual(expected, current)) {
        throw new Error('Workflow migration changed existing project settings outside the managed defaults merge.');
    }
    if ((previous.local_commit?.enabled === true) !== (current.local_commit?.enabled === true)
        || (previous.task_reset?.enabled === true) !== (current.task_reset?.enabled === true)
        || !isDeepStrictEqual(previous.project_validation, current.project_validation)) {
        throw new Error('Lifecycle migration cannot grant permissions or replace validation admission.');
    }
}

export function recordWorkflowConfigMigration(
    repoRoot: string, baseline: WorkflowConfigMigrationBaseline, setup?: ProjectCommandSetupMigration
): void {
    const captured = capturedBaselines.get(baseline);
    if (!captured || captured.root !== path.resolve(repoRoot) || captured.sha256 !== validationDigest(baseline)) {
        throw new Error('Workflow migration baseline must be an unchanged native capture for this workspace.');
    }
    const bundleRoot = path.join(repoRoot, resolveBundleNameForTarget(repoRoot));
    // Gitless setup has no native task or workspace-local commit authority to continue.
    if (!fs.existsSync(path.join(repoRoot, '.git')) && baseline.taskContext.activeTaskIds.length === 0) return;
    const changed = baseline.files.flatMap(before => {
        const after = readConfig(repoRoot, before.path);
        if (!after) throw new Error('Lifecycle migration removed an existing workflow configuration.');
        if (before.sha256 === after.sha256) return [];
        assertManagedDefaultsMigration(repoRoot, before, after, setup);
        return [{ before, after }];
    });
    if (changed.length === 0) return;
    const currentContext = captureWorkflowAuditTaskContext(bundleRoot, repoRoot);
    if (!isDeepStrictEqual(currentContext, baseline.taskContext)) {
        throw new Error('Workflow migration cannot publish across a changed active task cycle.');
    }
    const auditPath = path.join(bundleRoot, 'runtime', 'workflow-config-audit.jsonl');
    const bindings: WorkflowConfigAuditBinding[] = [];
    withRecoverableFileTransaction({
        root: repoRoot,
        ...workflowTransactionPaths(bundleRoot),
        files: { audit: auditPath }
    }, transaction => {
        for (const { before, after } of changed) {
            if (readConfig(repoRoot, after.path)?.sha256 !== after.sha256) {
                throw new Error('Workflow configuration changed during lifecycle audit publication.');
            }
            const config = JSON.parse(after.text) as WorkflowConfigData;
            const record = authenticateWorkflowMigration(repoRoot, {
                schema_version: 1,
                event_source: 'workflow-config-set',
                command: 'lifecycle configuration migration',
                mutation_source: 'lifecycle',
                actor: 'lifecycle_migration',
                migration_version: 1,
                permissions_preserved: true,
                timestamp_utc: new Date().toISOString(),
                config_path: path.resolve(repoRoot, after.path).replace(/\\/g, '/'),
                before_sha256: before.sha256,
                after_sha256: after.sha256,
                changed_fields: ['lifecycle.managed_defaults'],
                active_task_ids: currentContext.activeTaskIds,
                active_task_id: currentContext.activeTaskIds.length === 1 ? currentContext.activeTaskIds[0] : null,
                task_entry_sha256: currentContext.taskEntryHashes,
                project_validation_preserved_sha256: config.project_validation === undefined
                    ? null : validationDigest(parseApprovedValidationContract(config.project_validation))
            });
            const line = JSON.stringify(record);
            const binding = { auditPath, configPath: path.resolve(repoRoot, after.path),
                recordSha256: workflowConfigTextDigest(line), taskEntryHashes: currentContext.taskEntryHashes };
            recordWorkflowConfigAuditStage(bundleRoot, binding, false);
            transaction.append(auditPath, line + '\n');
            bindings.push(binding);
        }
    });
    for (const binding of bindings) bindCommittedWorkflowConfigAudit(bundleRoot, binding);
}
