import { isDeepStrictEqual } from 'node:util';
import { isPlainRecord } from '../../core/records';
import { runGitBinary } from '../../core/git-helpers';
import { readParentAuditProofBytes } from '../task-audit/task-audit-summary-decomposed-parent-proofs';
import { parentDigest, parentRecordDigest, readParentRecord } from './parent-audit-auth';
import { assertParentReviewInputCurrent, type ParentReviewerStart } from './parent-audit-inputs';
import type { ParentAuditFinding, ParentAuditOutput, ParentAuditResult, ParentCompletionContract, ParentRecord, ParentReviewInput } from './parent-audit-types';

function text(value: unknown, name: string, maximum = 8192): string {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error('Invalid aggregate review ' + name);
    return value;
}

function texts(value: unknown, name: string): string[] {
    if (!Array.isArray(value) || !value.length || value.length > 256) throw new Error('Invalid aggregate review ' + name);
    return value.map(item => text(item, name));
}

export function parseParentAuditOutput(raw: unknown, input: ParentReviewInput): ParentAuditOutput {
    if (!isPlainRecord(raw) || raw.schema_version !== 1 || raw.task_id !== input.task_id
        || raw.attempt_id !== input.attempt_id || raw.input_sha256 !== parentRecordDigest(input)
        || !Array.isArray(raw.findings) || raw.findings.length > 256 || !Array.isArray(raw.requirements)
        || raw.requirements.length !== input.obligations.length
        || Object.keys(raw).some(key => !['schema_version', 'task_id', 'attempt_id', 'input_sha256', 'requirements', 'findings'].includes(key))) {
        throw new Error('Aggregate review output must bind the current task, input, attempt and complete obligations.');
    }
    const obligations = new Map(input.obligations.map(item => [item.id, item]));
    const findings: ParentAuditFinding[] = raw.findings.map(item => {
        if (!isPlainRecord(item) || !/^F-[0-9]{3,}$/u.test(String(item.id))
            || !['critical', 'high', 'medium', 'low'].includes(String(item.severity))) throw new Error('Invalid aggregate finding identity or severity.');
        const requirementIds = texts(item.requirement_ids, 'finding requirements');
        if (requirementIds.some(id => !obligations.has(id))) throw new Error('Finding refers to a foreign obligation.');
        return { id: String(item.id), severity: item.severity as ParentAuditFinding['severity'],
            title: text(item.title, 'finding title', 256), description: text(item.description, 'finding description'),
            remediation: text(item.remediation, 'finding remediation'), requirement_ids: requirementIds, evidence: texts(item.evidence, 'finding evidence') };
    });
    const byFinding = new Map(findings.map(finding => [finding.id, finding]));
    if (byFinding.size !== findings.length) throw new Error('Aggregate finding IDs must be unique.');
    const requirements: ParentAuditOutput['requirements'] = raw.requirements.map(item => {
        if (!isPlainRecord(item) || !obligations.has(String(item.id)) || !['satisfied', 'finding'].includes(String(item.result))
            || !Array.isArray(item.finding_ids) || item.finding_ids.some(id => typeof id !== 'string')) throw new Error('Invalid aggregate coverage row.');
        const id = String(item.id), ids = item.finding_ids as string[];
        if ((item.result === 'satisfied' && (ids.length || obligations.get(id)!.required_finding))
            || (item.result === 'finding' && (!ids.length || ids.some(finding => !byFinding.get(finding)?.requirement_ids.includes(id))))) {
            throw new Error('Aggregate coverage must link concrete findings and preserve failed native checks.');
        }
        return { id, result: item.result as 'satisfied' | 'finding', evidence: texts(item.evidence, 'coverage evidence'), finding_ids: ids };
    });
    if (new Set(requirements.map(row => row.id)).size !== obligations.size
        || findings.some(finding => finding.requirement_ids.some(id => !requirements.find(row => row.id === id)?.finding_ids.includes(finding.id)))) {
        throw new Error('Aggregate coverage contains missing, duplicate or unlinked findings.');
    }
    return { schema_version: 1, task_id: input.task_id, attempt_id: input.attempt_id,
        input_sha256: parentRecordDigest(input), requirements, findings };
}

export interface ParentReviewObservation extends ParentRecord {
    kind: 'review-observation';
    input_sha256: string;
    attempt_id: string;
    reviewer_identity: string;
    start_sha256: string;
    output_sha256: string;
    findings: ParentAuditFinding[];
}

export function readParentReviewObservation(root: string, taskId: string, allowDescendant = false): ParentReviewObservation | null {
    const observation = readParentRecord<ParentReviewObservation>(root, taskId, 'review-observation');
    if (!observation) return null;
    const input = readParentRecord<ParentReviewInput>(root, taskId, 'review-input');
    const started = readParentRecord<ParentReviewerStart>(root, taskId, 'review-start');
    if (!input || !started || started.status !== 'STARTED' || observation.input_sha256 !== parentRecordDigest(input)
        || observation.attempt_id !== input.attempt_id || observation.start_sha256 !== parentRecordDigest(started)
        || observation.reviewer_identity !== started.reviewer_identity) throw new Error('Aggregate observation lost its actual delegated reviewer binding.');
    assertParentReviewInputCurrent(root, input, allowDescendant);
    const bytes = readParentAuditProofBytes(root, input.output_path, observation.output_sha256);
    const output = parseParentAuditOutput(JSON.parse(bytes.toString('utf8')), input);
    if (!isDeepStrictEqual(output.findings, observation.findings)) throw new Error('Aggregate findings differ from the accepted reviewer output.');
    return observation;
}

export function readAcceptedParentAuditResult(root: string, contract: ParentCompletionContract): ParentAuditResult | null {
    const result = readParentRecord<ParentAuditResult>(root, contract.task_id, 'result');
    if (!result) return null;
    const observation = readParentReviewObservation(root, contract.task_id, true);
    const input = readParentRecord<ParentReviewInput>(root, contract.task_id, 'review-input');
    if (!observation || !input || result.contract_sha256 !== parentRecordDigest(contract) || result.input_sha256 !== observation.input_sha256
        || result.attempt_id !== observation.attempt_id || result.reviewer_identity !== observation.reviewer_identity
        || result.output_sha256 !== observation.output_sha256 || result.source_commit !== input.source_commit
        || !isDeepStrictEqual(result.findings, observation.findings)
        || (result.findings.length === 0 ? result.follow_up_task_id !== null : typeof result.follow_up_task_id !== 'string')) {
        throw new Error('Aggregate result does not match its authenticated one-shot observation.');
    }
    return result;
}

export function readParentOutput(root: string, input: ParentReviewInput) {
    const bytes = readParentAuditProofBytes(root, input.output_path);
    const output = parseParentAuditOutput(JSON.parse(bytes.toString('utf8')), input);
    const references = [...new Set([...output.requirements.flatMap(row => row.evidence), ...output.findings.flatMap(row => row.evidence)])];
    if (references.length > 256) throw new Error('Aggregate review evidence exceeds its bounded reference budget.');
    const lineCounts = new Map<string, number>();
    for (const reference of references) {
        const match = /^(.*):([1-9][0-9]*)$/u.exec(reference);
        if (!match) throw new Error('Aggregate evidence must name a source or bound validation path and line.');
        const file = match[1], line = Number(match[2]);
        let count = lineCounts.get(file);
        if (count === undefined) {
            const validation = input.validation_evidence.find(proof => proof.output_path === file);
            let content: Buffer;
            if (validation?.output_sha256) content = readParentAuditProofBytes(root, file, validation.output_sha256);
            else {
                if (/^[\\/]|^[a-z]:|\\|\0/iu.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) {
                    throw new Error('Aggregate evidence source path is outside canonical repository source.');
                }
                content = runGitBinary(root, ['--no-replace-objects', 'cat-file', 'blob', `${input.source_commit}:${file}`],
                    { timeoutMs: 10000, maxBuffer: 8 * 1024 * 1024 });
            }
            count = content.toString('utf8').split('\n').length;
            lineCounts.set(file, count);
        }
        if (!Number.isSafeInteger(line) || line > count) throw new Error('Aggregate evidence source line does not exist.');
    }
    return { output, sha256: parentDigest(bytes) };
}
