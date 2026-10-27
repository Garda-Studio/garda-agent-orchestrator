import { prepareRuntimeMutationGenerationCode } from '../../gate-runtime/runtime-mutation-generation';
import { prepareTaskEventSummaryCode } from '../../gate-runtime/timeline/task-events-io-summary';
import { prepareClosedObservationPlanModules } from '../../core/derivation-observation-recorder';
import { prepareBoundarySourceEvidenceModules } from '../../core/trust-boundary-source-evidence';
import { captureLoadedCodeClosure } from '../../core/loaded-code-identity';
/** Optional materialized acceleration. Every existing checked file is still read and hashed. */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { writeFileAtomically } from '../../core/filesystem';
import { readInvocationFileContent } from '../../core/invocation-file-observation';
import { createInvocationReadMemoKey, memoizeInvocationRead, registerInvocationDependency, isInvocationReadObservationActive } from '../../core/invocation-read-observation';
import { countNextStepWork, describeProcessInputs } from '../../core/next-step-measurement';
import { getAgentReportMessages } from '../../cli/commands/cli-agent-report';
import { getReviewExecutionPreparationOrder } from '../../core/review-execution-policy';
import { cloneJson } from '../../core/immutable-json';
import { readClosedReviewBytes, resolveClosedReviewAuthentication } from '../review-attempts/review-closed-cycle-auth';
import type { FinalCloseoutArtifact, TaskAuditSummaryResult } from './task-audit-summary-types';
import { formatFinalCloseoutMarkdown, formatFinalUserReport } from './task-audit-summary-renderers';
import { isPlainRecord } from '../../core/records';

const VERSION = 'garda.materialized-terminal-projection.v2';
const LIMIT = 256 * 1024;
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const scalarDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const domainMac = (key: Buffer, workspace: string, payload: string) => createHmac('sha256', key).update(JSON.stringify([VERSION, workspace, payload])).digest('hex');
export interface MaterializedTerminalProjection {
    schema_version: 1;
    event_source: 'materialized-terminal-navigation';
    task_id: string;
    workspace_sha256: string;
    renderer_semantics_sha256: string;
    cycle_binding: FinalCloseoutArtifact['cycle_binding'];
    /** Only fields actually consumed by the current drift contracts, preserving absent-vs-null. */
    implementation_summary: Record<string, unknown>;
    artifacts: { closeout_sha256: string; markdown_sha256: string; report_sha256: string; ledger_sha256: string };
}
interface ProjectionEnvelope { schema_version: 1; version: typeof VERSION; payload: string; hmac_sha256: string; }
export interface MaterializedTerminalRead { projection: MaterializedTerminalProjection; reportBody: string; }
function paths(jsonPath: string) {
    const stem = jsonPath.replace(/-final-closeout\.json$/u, '');
    if (stem === jsonPath) throw new Error('Noncanonical final closeout path.');
    return { json: jsonPath, markdown: stem + '-final-closeout.md', report: stem + '-final-user-report.md',
        projection: stem + '-final-navigation.json', ledger: path.join(path.dirname(path.dirname(jsonPath)), 'task-ledger', path.basename(stem) + '.json') };
}
function parseCounted(bytes: Buffer | string): unknown {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes, (_key, value: unknown) => {
        countNextStepWork('visit:terminal-materialized:parsed-value'); return value;
    });
}
function readHashed(file: string, keepText: boolean): { sha256: string; text: string | null } {
    const observed = readInvocationFileContent(file);
    if (observed) {
        countNextStepWork('terminal_materialized_bytes_hashed', observed.size);
        return { sha256: observed.sha256, text: keepText ? observed.copyBytes().toString('utf8') : null };
    }
    const bytes = fs.readFileSync(file);
    countNextStepWork('terminal_materialized_bytes_hashed', bytes.length);
    return { sha256: digest(bytes), text: keepText ? bytes.toString('utf8') : null };
}
/** Owner roots, not a finite dependency whitelist: all actual transitive children are bound. */
const RENDERER_MODULES = [
    './task-audit-summary-renderers', './task-audit-summary-final-report', './task-audit-summary-renderer-common',
    '../../cli/commands/cli-agent-report', '../../cli/commands/cli-format-output', '../../core/task-queue-status-contract',
    '../../core/review-execution-policy', '../shared/known-nonblocking-signals', './task-audit-materialized-terminal'
];
interface RendererSemanticsBinding { readonly sha256: string; assertCurrent(): void }
const SEMANTICS = createInvocationReadMemoKey<RendererSemanticsBinding>('materialized-terminal-renderer-semantics-v2');
function rendererParameters() {
    // The native formatters use default locale collation and Date.parse for legacy timestamps.
    // These runtime settings can change without changing any executable file.
    return describeProcessInputs([getAgentReportMessages(), getReviewExecutionPreparationOrder('strict_sequential'),
        new Intl.Collator().resolvedOptions(), new Intl.DateTimeFormat().resolvedOptions().timeZone]);
}
function rendererSemanticsBinding(): RendererSemanticsBinding {
    const parameters = rendererParameters();
    if (parameters.opaque) throw new Error('Opaque mutable renderer parameters require native rendering.');
    countNextStepWork('terminal_renderer_parameter_chars', parameters.text.length);
    return memoizeInvocationRead(SEMANTICS, parameters.text, () => {
        const assertParametersCurrent = () => {
            const current = rendererParameters();
            if (current.opaque || current.text !== parameters.text) throw new Error('Materialized renderer parameters changed during invocation.');
        };
        registerInvocationDependency(parameters, assertParametersCurrent);
        for (const id of RENDERER_MODULES) { countNextStepWork('visit:terminal-materialized:renderer-root'); require(id); }
        // Native quality acquisition can reach these fixed lazy edges after a projection miss.
        // Prepare code only; all input reads, identity checks and final validation stay live.
        prepareClosedObservationPlanModules();
        prepareBoundarySourceEvidenceModules();
        prepareRuntimeMutationGenerationCode();
        prepareTaskEventSummaryCode();
        const code = captureLoadedCodeClosure('garda.terminal-renderer-code.v1', RENDERER_MODULES.map(id => require.resolve(id)));
        return Object.freeze({ sha256: digest(JSON.stringify([VERSION, code.sha256, parameters.text])),
            assertCurrent() { code.assertCurrent(); assertParametersCurrent(); } });
    }).value;
}
function scopedImplementation(closeout: FinalCloseoutArtifact): Record<string, unknown> {
    const source = closeout.implementation_summary as unknown as Record<string, unknown>;
    const selected: Record<string, unknown> = {};
    for (const key of ['changed_files', 'changed_files_sha256', 'scope_content_sha256', 'scope_sha256',
        'worktree_scope_content_sha256', 'audited_scope_provenance']) {
        countNextStepWork('visit:terminal-materialized:scope-property');
        if (Object.hasOwn(source, key)) Object.defineProperty(selected, key, { value: cloneJson(source[key]), enumerable: true, configurable: true, writable: true });
    }
    return selected;
}
/** Exact existing ledger comparisons, at the native producer, over the bytes subsequently committed. */
function currentLedgerMatches(closeout: FinalCloseoutArtifact, rawJson: string, rawMarkdown: string, rawLedger: string): boolean {
    const ledger = parseCounted(rawLedger);
    if (!isPlainRecord(ledger) || String(ledger.task_id || '').trim() !== closeout.task_id) return false;
    const verification = isPlainRecord(ledger.verification) ? ledger.verification : null;
    const refs = isPlainRecord(ledger.artifact_refs) ? ledger.artifact_refs : null;
    const jsonRef = isPlainRecord(refs?.final_closeout_json) ? refs.final_closeout_json : null;
    const markdownRef = isPlainRecord(refs?.final_closeout_markdown) ? refs.final_closeout_markdown : null;
    const jsonSha = typeof jsonRef?.sha256 === 'string' ? jsonRef.sha256.trim().toLowerCase() : '';
    const markdownSha = typeof markdownRef?.sha256 === 'string' ? markdownRef.sha256.trim().toLowerCase() : '';
    const scope = isPlainRecord(ledger.scope) ? ledger.scope : null, timing = isPlainRecord(ledger.timing) ? ledger.timing : null;
    return String(ledger.audit_status || '').trim().toUpperCase() === 'PASS'
        && String(verification?.status || '').trim().toUpperCase() === 'VERIFIED'
        && scalarDigest(jsonSha) && scalarDigest(markdownSha)
        && digest(rawJson) === jsonSha && digest(rawMarkdown) === markdownSha
        && rawJson === JSON.stringify(closeout, null, 2) + '\n'
        && !!scope && scope.changed_files_sha256 === closeout.implementation_summary.changed_files_sha256
        && scope.scope_content_sha256 === closeout.implementation_summary.scope_content_sha256
        && scope.scope_sha256 === closeout.implementation_summary.scope_sha256
        && timing?.compile_gate_timestamp === closeout.cycle_binding?.compile_gate_timestamp;
}
/** Only native synchronizeFinalCloseoutArtifacts calls this AFTER all existing bytes/ledger exist.
 * Optional acceleration: failure removes/leaves a mismatched proof and cannot make native closeout fail.
 */
export function publishMaterializedTerminalProjection(summary: TaskAuditSummaryResult, repoRoot: string): void {
    if (summary.status !== 'PASS' || summary.final_closeout.status !== 'READY'
        || summary.final_closeout.artifact_state !== 'MATERIALIZED') return;
    const semantics = rendererSemanticsBinding();
    const closeout = summary.final_closeout, files = paths(closeout.artifact_paths.json);
    if (closeout.task_id !== summary.task_id || path.basename(files.json) !== summary.task_id + '-final-closeout.json') return;
    const rawJson = fs.readFileSync(files.json, 'utf8'), rawMarkdown = fs.readFileSync(files.markdown, 'utf8');
    const rawReport = fs.readFileSync(files.report, 'utf8'), rawLedger = fs.readFileSync(files.ledger, 'utf8');
    if (!currentLedgerMatches(closeout, rawJson, rawMarkdown, rawLedger)
        || rawMarkdown !== formatFinalCloseoutMarkdown(closeout) + '\n'
        || rawReport !== formatFinalUserReport(closeout) + '\n') return;
    const auth = resolveClosedReviewAuthentication(repoRoot, true);
    const projection: MaterializedTerminalProjection = { schema_version: 1, event_source: 'materialized-terminal-navigation',
        task_id: summary.task_id, workspace_sha256: auth.workspaceSha256, renderer_semantics_sha256: semantics.sha256, cycle_binding: cloneJson(closeout.cycle_binding),
        implementation_summary: scopedImplementation(closeout), artifacts: { closeout_sha256: digest(rawJson), markdown_sha256: digest(rawMarkdown),
            report_sha256: digest(rawReport), ledger_sha256: digest(rawLedger) } };
    const payload = JSON.stringify(projection);
    const bytes = JSON.stringify({ schema_version: 1, version: VERSION, payload,
        hmac_sha256: domainMac(auth.key, auth.workspaceSha256, payload) } satisfies ProjectionEnvelope) + '\n';
    if (Buffer.byteLength(bytes) > LIMIT) return;
    semantics.assertCurrent();
    writeFileAtomically(files.projection, bytes, { encoding: 'utf8' });
    countNextStepWork('terminal_materialized_published');
}
const READS = createInvocationReadMemoKey<MaterializedTerminalRead | null>('materialized-terminal-projection-v1');
export function readMaterializedTerminalProjection(repoRoot: string, jsonPath: string, taskId: string): MaterializedTerminalRead | null {
    let rendererBinding: RendererSemanticsBinding;
    try { rendererBinding = rendererSemanticsBinding(); } catch { return null; }
    const semantics = rendererBinding.sha256;
    const key = JSON.stringify([path.resolve(repoRoot), path.resolve(jsonPath), taskId, VERSION, semantics]);
    const retained = memoizeInvocationRead(READS, key, () => {
        try {
            const files = paths(jsonPath), auth = resolveClosedReviewAuthentication(repoRoot, false);
            const bytes = readClosedReviewBytes(path.dirname(files.json), files.projection, LIMIT);
            if (!bytes) return null;
            const envelope = parseCounted(bytes) as ProjectionEnvelope;
            if (envelope.schema_version !== 1 || envelope.version !== VERSION || typeof envelope.payload !== 'string' || !scalarDigest(envelope.hmac_sha256)) return null;
            const expected = domainMac(auth.key, auth.workspaceSha256, envelope.payload);
            if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(envelope.hmac_sha256, 'hex'))) return null;
            const projection = parseCounted(envelope.payload) as MaterializedTerminalProjection;
            if (projection.schema_version !== 1 || projection.event_source !== 'materialized-terminal-navigation'
                || projection.task_id !== taskId || projection.workspace_sha256 !== auth.workspaceSha256
                || projection.renderer_semantics_sha256 !== semantics
                || !isPlainRecord(projection.implementation_summary) || !isPlainRecord(projection.artifacts)) return null;
            // All old materialized inputs stay current; no report/ledger bytes are omitted.
            const json = readHashed(files.json, false), markdown = readHashed(files.markdown, false);
            const report = readHashed(files.report, true), ledger = readHashed(files.ledger, false);
            if (json.sha256 !== projection.artifacts.closeout_sha256 || markdown.sha256 !== projection.artifacts.markdown_sha256
                || report.sha256 !== projection.artifacts.report_sha256 || ledger.sha256 !== projection.artifacts.ledger_sha256) return null;
            countNextStepWork('terminal_materialized_projection_selected');
            return { projection, reportBody: report.text! };
        } catch { return null; }
    }).value;
    // cloneJson counts every copied object. This is bounded by scope files, not review history.
    if (retained && !isInvocationReadObservationActive()) {
        try { rendererBinding.assertCurrent(); } catch { return null; }
    }
    return retained ? cloneJson(retained) : null;
}
