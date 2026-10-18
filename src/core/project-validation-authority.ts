import * as path from 'node:path';
import { resolveBundleNameForTarget } from './constants';
import { bindContainedDestination } from './contained-filesystem';
import { parseApprovedValidationContract, readValidationFile, validationDigest } from './project-validation-identity';
import type { ApprovedValidationContract } from './project-validation-contract';
import { mergeFileRoleBindings, type FileRoleBindings } from './file-role-bindings';

const MAXIMUM_CONTROL_BYTES = 8 * 1024 * 1024;

export function readProjectValidationAuthority(repoRoot: string): { approved: ApprovedValidationContract; sha256: string } | null {
    const bundle = resolveBundleNameForTarget(repoRoot);
    const configPath = `${bundle}/live/config/workflow-config.json`;
    if (bindContainedDestination(repoRoot, path.join(repoRoot, configPath)).missingAt) return null;
    const file = readValidationFile(repoRoot, configPath, MAXIMUM_CONTROL_BYTES);
    const config = JSON.parse(file.bytes.toString('utf8')) as Record<string, unknown>;
    if (config.project_validation === undefined) return null;
    const approved = parseApprovedValidationContract(config.project_validation);
    const audit = readValidationFile(repoRoot, `${bundle}/runtime/workflow-config-audit.jsonl`, MAXIMUM_CONTROL_BYTES);
    const records = audit.bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.event_source === 'workflow-config-set' && path.resolve(repoRoot, String(entry.config_path)) === path.join(repoRoot, configPath));
    let admissionIndex = -1;
    records.forEach((entry, index) => { if (Array.isArray(entry.changed_fields) && entry.changed_fields.includes('project_validation')) admissionIndex = index; });
    if (records.at(-1)?.after_sha256 !== file.identity.sha256 || admissionIndex < 0
        || records[admissionIndex].project_validation_admission_sha256 !== validationDigest(approved)) throw new Error('Project validation authority lacks an explicit recipe admission and current audited workflow configuration mutation');
    if (records.slice(admissionIndex).some((entry) => entry.mutation_source !== 'cli' && entry.mutation_source !== 'local-ui')) throw new Error('Unsupported audited workflow configuration mutation origin');
    for (let index = admissionIndex + 1; index < records.length; index++) {
        const before = records[index].before_sha256;
        if (typeof before !== 'string' || !/^[a-f0-9]{64}$/u.test(before) || before !== records[index - 1].after_sha256) throw new Error('Project validation audited mutation chain is discontinuous');
    }
    return { approved, sha256: file.identity.sha256 };
}

export function readProjectValidationFileRoles(repoRoot: string): FileRoleBindings {
    const authority = readProjectValidationAuthority(repoRoot);
    return mergeFileRoleBindings(...(authority?.approved.contract.recipes.flatMap(recipe =>
        recipe.inputs.filter(input => input.role === 'source' || input.role === 'test')
            .map(input => ({ [input.path]: input.role as 'source' | 'test' }))) ?? []));
}
