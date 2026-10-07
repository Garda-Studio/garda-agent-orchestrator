import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertValidTaskId } from '../../gate-runtime/task-events';
import { assertValidProfileName } from '../../cli/commands/profile/profile-model';
import {
    isPathRealpathInsideRoot,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo,
    toStringArray
} from '../shared/helpers';
import { validateReviewFindingsValidationArtifact } from '../review/review-findings-validation-artifact';

export const STRICT_DECOMPOSITION_REVIEW_TYPES = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
] as const);

export type StrictDecompositionReviewType = (typeof STRICT_DECOMPOSITION_REVIEW_TYPES)[number];

export interface StrictDecompositionFindingObligation {
    obligation_id: string;
    review_type: StrictDecompositionReviewType;
    finding_id: string;
    validation_artifact_path: string;
    validation_artifact_sha256: string;
    validation_result_sha256: string;
    root_cause_areas: string[];
    work_package_task_ids: string[];
    downstream_review_types: StrictDecompositionReviewType[];
}

export interface StrictDecompositionWorkPackage {
    task_id: string;
    profile: string;
    root_cause_area: string;
    objective: string;
    scope_obligations: string[];
    validation_contract: string[];
    finding_obligation_ids: string[];
    required_review_types: StrictDecompositionReviewType[];
}

export interface StrictDecompositionWorkPackageContract {
    schema_version: 1 | 2;
    finding_obligations: StrictDecompositionFindingObligation[];
    work_packages: StrictDecompositionWorkPackage[];
}

const LEGACY_CONTRACT_SCHEMA_VERSION = 1;
const PARENT_PROFILE_CONTRACT_SCHEMA_VERSION = 2;
const MAX_CONTRACT_FILE_BYTES = 256 * 1024;
const MAX_FINDING_OBLIGATIONS = 256;
const MAX_WORK_PACKAGES = 64;
const MAX_ARRAY_ENTRIES = 32;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const FINDING_ID_PATTERN = /^F-[0-9]{3,}$/u;
const OBLIGATION_ID_PATTERN = /^[a-z0-9][A-Za-z0-9:._-]{2,127}$/u;
const ROOT_CAUSE_AREA_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
    const allowed = new Set(allowedKeys);
    const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknownKeys.length > 0) {
        throw new Error(`${label} contains unsupported field(s): ${unknownKeys.join(', ')}.`);
    }
}

function normalizeText(value: unknown, label: string, minimumLength = 12, maximumLength = 1000): string {
    const normalized = String(value || '').trim();
    if (normalized.length < minimumLength || normalized.length > maximumLength) {
        throw new Error(`${label} is required and must contain ${minimumLength}-${maximumLength} characters.`);
    }
    return normalized;
}

function normalizeUniqueTextArray(
    value: unknown,
    label: string,
    options: { allowEmpty?: boolean; minimumLength?: number; maximumLength?: number } = {}
): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array.`);
    }
    if (value.length > MAX_ARRAY_ENTRIES) {
        throw new Error(`${label} must contain at most ${MAX_ARRAY_ENTRIES} entries.`);
    }
    const normalized = value.map((entry, index) => normalizeText(
        entry,
        `${label}[${index}]`,
        options.minimumLength ?? 12,
        options.maximumLength ?? 1000
    ));
    if (!options.allowEmpty && normalized.length === 0) {
        const singularLabel = label.endsWith('s') ? label.slice(0, -1) : label;
        throw new Error(`${singularLabel} is required.`);
    }
    if (new Set(normalized).size !== normalized.length) {
        throw new Error(`${label} must contain unique entries.`);
    }
    return normalized;
}

function normalizeReviewTypes(
    value: unknown,
    label: string,
    options: { allowEmpty?: boolean } = {}
): StrictDecompositionReviewType[] {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array.`);
    }
    if (value.length > STRICT_DECOMPOSITION_REVIEW_TYPES.length) {
        throw new Error(`${label} contains too many entries.`);
    }
    const normalized = value.map((entry) => String(entry || '').trim().toLowerCase());
    if (!options.allowEmpty && normalized.length === 0) {
        throw new Error(`${label} is required.`);
    }
    const invalid = normalized.filter(
        (entry) => !STRICT_DECOMPOSITION_REVIEW_TYPES.includes(entry as StrictDecompositionReviewType)
    );
    if (invalid.length > 0) {
        throw new Error(`${label} contains unsupported review type(s): ${invalid.join(', ')}.`);
    }
    if (new Set(normalized).size !== normalized.length) {
        throw new Error(`${label} must contain unique entries.`);
    }
    return normalized as StrictDecompositionReviewType[];
}

function normalizeHash(value: unknown, label: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (!HASH_PATTERN.test(normalized)) {
        throw new Error(`${label} must be a lowercase sha256 value.`);
    }
    return normalized;
}

function normalizeRootCauseArea(value: unknown, label: string): string {
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s_]+/gu, '-');
    if (!ROOT_CAUSE_AREA_PATTERN.test(normalized)) {
        throw new Error(`${label} must be a 3-80 character kebab-case identifier.`);
    }
    return normalized;
}

function normalizeTaskIdArray(value: unknown, label: string, parentTaskId: string): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${label} is required and must be a non-empty array.`);
    }
    if (value.length > MAX_WORK_PACKAGES) {
        throw new Error(`${label} must contain at most ${MAX_WORK_PACKAGES} entries.`);
    }
    const normalized = value.map((entry) => {
        const taskId = assertValidTaskId(String(entry || '').trim());
        if (!taskId.toLowerCase().startsWith(`${parentTaskId.toLowerCase()}-`)) {
            throw new Error(`${label} entry '${taskId}' must be parent-derived from '${parentTaskId}'.`);
        }
        return taskId;
    });
    if (new Set(normalized).size !== normalized.length) {
        throw new Error(`${label} must contain unique task ids.`);
    }
    return normalized;
}

function normalizeFindingObligation(value: unknown, parentTaskId: string, index: number): StrictDecompositionFindingObligation {
    const label = `FindingObligation[${index}]`;
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    assertExactKeys(value, [
        'obligation_id',
        'review_type',
        'finding_id',
        'validation_artifact_path',
        'validation_artifact_sha256',
        'validation_result_sha256',
        'root_cause_areas',
        'work_package_task_ids',
        'downstream_review_types'
    ], label);
    const obligationId = String(value.obligation_id || '').trim();
    if (!OBLIGATION_ID_PATTERN.test(obligationId)) {
        throw new Error(`${label}.obligation_id must be a 3-128 character lowercase identifier.`);
    }
    const findingId = String(value.finding_id || '').trim().toUpperCase();
    if (!FINDING_ID_PATTERN.test(findingId)) {
        throw new Error(`${label}.finding_id must use the F-001 form.`);
    }
    const reviewTypes = normalizeReviewTypes([value.review_type], `${label}.review_type`);
    const expectedObligationId = `${reviewTypes[0]}:${findingId}`;
    if (obligationId.toLowerCase() !== expectedObligationId.toLowerCase()) {
        throw new Error(`${label}.obligation_id must equal '${expectedObligationId}'.`);
    }
    const validationArtifactPath = normalizePath(String(value.validation_artifact_path || '').trim());
    if (!validationArtifactPath) {
        throw new Error(`${label}.validation_artifact_path is required.`);
    }
    const rootCauseAreas = normalizeUniqueTextArray(
        value.root_cause_areas,
        `${label}.root_cause_areas`,
        { minimumLength: 3, maximumLength: 80 }
    ).map((entry) => normalizeRootCauseArea(entry, `${label}.root_cause_areas`));
    const downstreamReviewTypes = normalizeReviewTypes(
        value.downstream_review_types,
        `${label}.downstream_review_types`
    );
    if (!downstreamReviewTypes.includes(reviewTypes[0])) {
        throw new Error(`${label}.downstream_review_types must preserve source review type '${reviewTypes[0]}'.`);
    }
    return {
        obligation_id: expectedObligationId,
        review_type: reviewTypes[0],
        finding_id: findingId,
        validation_artifact_path: validationArtifactPath,
        validation_artifact_sha256: normalizeHash(
            value.validation_artifact_sha256,
            `${label}.validation_artifact_sha256`
        ),
        validation_result_sha256: normalizeHash(
            value.validation_result_sha256,
            `${label}.validation_result_sha256`
        ),
        root_cause_areas: rootCauseAreas,
        work_package_task_ids: normalizeTaskIdArray(
            value.work_package_task_ids,
            `${label}.work_package_task_ids`,
            parentTaskId
        ),
        downstream_review_types: downstreamReviewTypes
    };
}

function normalizeWorkPackage(value: unknown, parentTaskId: string, index: number, expectedProfile: string): StrictDecompositionWorkPackage {
    const label = `WorkPackage[${index}]`;
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    assertExactKeys(value, [
        'task_id',
        'profile',
        'root_cause_area',
        'objective',
        'scope_obligations',
        'validation_contract',
        'finding_obligation_ids',
        'required_review_types'
    ], label);
    const profile = typeof value.profile === 'string' ? value.profile.trim().toLowerCase() : '';
    if (profile !== expectedProfile) {
        throw new Error(`${label}.profile is required and must be ${expectedProfile}.`);
    }
    const findingObligationIds = normalizeUniqueTextArray(
        value.finding_obligation_ids,
        `${label}.finding_obligation_ids`,
        { allowEmpty: true, minimumLength: 3, maximumLength: 128 }
    );
    for (const obligationId of findingObligationIds) {
        if (!OBLIGATION_ID_PATTERN.test(obligationId)) {
            throw new Error(`${label}.finding_obligation_ids contains invalid id '${obligationId}'.`);
        }
    }
    return {
        task_id: normalizeTaskIdArray([value.task_id], `${label}.task_id`, parentTaskId)[0],
        profile: expectedProfile,
        root_cause_area: normalizeRootCauseArea(value.root_cause_area, `${label}.root_cause_area`),
        objective: normalizeText(value.objective, `${label}.objective`),
        scope_obligations: normalizeUniqueTextArray(value.scope_obligations, `${label}.scope_obligations`),
        validation_contract: normalizeUniqueTextArray(value.validation_contract, `${label}.validation_contract`),
        finding_obligation_ids: findingObligationIds,
        required_review_types: normalizeReviewTypes(
            value.required_review_types,
            `${label}.required_review_types`,
            { allowEmpty: true }
        )
    };
}

function equalSets(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((entry) => right.includes(entry));
}

export function normalizeStrictDecompositionWorkPackageContract(
    parentTaskIdValue: unknown,
    value: unknown,
    expectedReviewTypesValue: unknown,
    parentProfileValue: unknown = 'strict'
): StrictDecompositionWorkPackageContract {
    const parentTaskId = assertValidTaskId(String(parentTaskIdValue || '').trim());
    if (!isRecord(value)) {
        throw new Error('Decision split-required requires a WorkPackageContract object.');
    }
    assertExactKeys(value, ['schema_version', 'finding_obligations', 'work_packages'], 'WorkPackageContract');
    const schemaVersion = value.schema_version;
    if (schemaVersion !== LEGACY_CONTRACT_SCHEMA_VERSION && schemaVersion !== PARENT_PROFILE_CONTRACT_SCHEMA_VERSION) {
        throw new Error('WorkPackageContract.schema_version must equal 1 or 2.');
    }
    const expectedProfile = schemaVersion === LEGACY_CONTRACT_SCHEMA_VERSION
        ? 'strict'
        : typeof parentProfileValue === 'string' ? parentProfileValue.trim().toLowerCase() : '';
    if (!expectedProfile) {
        throw new Error('WorkPackageContract requires a valid immutable parent profile.');
    }
    assertValidProfileName(expectedProfile);
    if (!Array.isArray(value.finding_obligations)) {
        throw new Error('WorkPackageContract.finding_obligations must be an array.');
    }
    if (value.finding_obligations.length > MAX_FINDING_OBLIGATIONS) {
        throw new Error(`WorkPackageContract.finding_obligations must contain at most ${MAX_FINDING_OBLIGATIONS} entries.`);
    }
    if (!Array.isArray(value.work_packages) || value.work_packages.length < 2) {
        throw new Error('WorkPackageContract.work_packages must contain at least two entries.');
    }
    if (value.work_packages.length > MAX_WORK_PACKAGES) {
        throw new Error(`WorkPackageContract.work_packages must contain at most ${MAX_WORK_PACKAGES} entries.`);
    }

    const findingObligations = value.finding_obligations.map(
        (entry, index) => normalizeFindingObligation(entry, parentTaskId, index)
    );
    const workPackages = value.work_packages.map(
        (entry, index) => normalizeWorkPackage(entry, parentTaskId, index, expectedProfile)
    );
    const obligationIds = findingObligations.map((entry) => entry.obligation_id);
    if (new Set(obligationIds).size !== obligationIds.length) {
        throw new Error('WorkPackageContract finding obligation ids must be unique.');
    }
    const sourceFindingKeys = findingObligations.map((entry) => `${entry.review_type}:${entry.finding_id}`);
    if (new Set(sourceFindingKeys).size !== sourceFindingKeys.length) {
        throw new Error('WorkPackageContract must reference each validated review finding exactly once.');
    }
    const packageTaskIds = workPackages.map((entry) => entry.task_id);
    if (new Set(packageTaskIds).size !== packageTaskIds.length) {
        throw new Error('WorkPackageContract work package task ids must be unique.');
    }
    const rootCauseAreas = workPackages.map((entry) => entry.root_cause_area);
    if (new Set(rootCauseAreas).size !== rootCauseAreas.length) {
        throw new Error('WorkPackageContract work packages require a unique root_cause_area so duplicate-root findings coalesce.');
    }

    for (const obligation of findingObligations) {
        const unmappedRootCauseAreas = obligation.root_cause_areas.filter(
            (rootCauseArea) => !rootCauseAreas.includes(rootCauseArea)
        );
        if (unmappedRootCauseAreas.length > 0) {
            throw new Error(
                `Finding obligation '${obligation.obligation_id}' root_cause_areas must all map to work packages: ${unmappedRootCauseAreas.join(', ')}.`
            );
        }
        const expectedPackageTaskIds = workPackages
            .filter((workPackage) => obligation.root_cause_areas.includes(workPackage.root_cause_area))
            .map((workPackage) => workPackage.task_id);
        if (!equalSets(obligation.work_package_task_ids, expectedPackageTaskIds)) {
            throw new Error(
                `Finding obligation '${obligation.obligation_id}' work_package_task_ids must exactly match its root_cause_areas packages.`
            );
        }
        for (const packageTaskId of obligation.work_package_task_ids) {
            const workPackage = workPackages.find((entry) => entry.task_id === packageTaskId);
            if (!workPackage || !obligation.downstream_review_types.every(
                (reviewType) => workPackage.required_review_types.includes(reviewType)
            )) {
                throw new Error(
                    `Finding obligation '${obligation.obligation_id}' downstream review obligations must be preserved by work package '${packageTaskId}'.`
                );
            }
        }
    }

    for (const workPackage of workPackages) {
        const expectedFindingObligationIds = findingObligations
            .filter((obligation) => obligation.work_package_task_ids.includes(workPackage.task_id))
            .map((obligation) => obligation.obligation_id);
        if (!equalSets(workPackage.finding_obligation_ids, expectedFindingObligationIds)) {
            throw new Error(
                `Work package '${workPackage.task_id}' finding_obligation_ids must exactly match mapped validated findings.`
            );
        }
    }

    const expectedReviewTypes = normalizeReviewTypes(
        toStringArray(expectedReviewTypesValue, { trimValues: true }),
        'ExpectedReviewType',
        { allowEmpty: true }
    );
    const packageReviewTypes = [...new Set(workPackages.flatMap((entry) => entry.required_review_types))];
    if (!equalSets(expectedReviewTypes, packageReviewTypes)) {
        throw new Error('ExpectedReviewType values must exactly match the union of work package required_review_types.');
    }

    return {
        schema_version: schemaVersion,
        finding_obligations: findingObligations,
        work_packages: workPackages
    };
}

export function readStrictDecompositionWorkPackageContractFile(repoRoot: string, contractPathValue: unknown): unknown {
    const contractPath = String(contractPathValue || '').trim();
    if (!contractPath) {
        return null;
    }
    const resolvedPath = resolvePathInsideRepo(contractPath, repoRoot, { allowMissing: false, enforceInside: true });
    if (!resolvedPath || !isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: false })) {
        throw new Error('WorkPackageContractPath must stay inside repo root after realpath resolution.');
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
        throw new Error('WorkPackageContractPath must reference a regular file.');
    }
    if (stat.size > MAX_CONTRACT_FILE_BYTES) {
        throw new Error(`WorkPackageContractPath must not exceed ${MAX_CONTRACT_FILE_BYTES} bytes.`);
    }
    try {
        return JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as unknown;
    } catch {
        throw new Error('WorkPackageContractPath must contain valid JSON.');
    }
}

function artifactFindings(artifact: NonNullable<ReturnType<typeof validateReviewFindingsValidationArtifact>['artifact']>) {
    const inventory = artifact.validation_result.normalized_inventory;
    return [
        ...inventory.findings_by_severity.critical,
        ...inventory.findings_by_severity.high,
        ...inventory.findings_by_severity.medium,
        ...inventory.findings_by_severity.low
    ];
}

function resolveFindingValidationSourcePath(repoRoot: string, sourcePath: string): string {
    const resolvedPath = path.isAbsolute(sourcePath)
        ? resolvePathInsideRepo(sourcePath, repoRoot, { allowMissing: false, enforceInside: true })
        : joinOrchestratorPath(repoRoot, sourcePath);
    if (!resolvedPath || !isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: false })) {
        throw new Error('Finding validation artifact path must stay inside repo root after realpath resolution.');
    }
    return resolvedPath;
}

export function validateStrictDecompositionWorkPackageFindingSources(
    repoRoot: string,
    taskId: string,
    contract: StrictDecompositionWorkPackageContract
): string[] {
    const violations: string[] = [];
    const currentFindings = new Map<string, {
        artifactPath: string;
        artifactSha256: string;
        validationResultSha256: string;
    }>();

    for (const reviewType of STRICT_DECOMPOSITION_REVIEW_TYPES) {
        const artifactPath = joinOrchestratorPath(
            repoRoot,
            path.join('runtime', 'reviews', `${taskId}-${reviewType}-findings-validation.json`)
        );
        if (!fs.existsSync(artifactPath)) {
            continue;
        }
        const validation = validateReviewFindingsValidationArtifact({
            artifactPath,
            expectedTaskId: taskId,
            expectedReviewType: reviewType,
            requireAccepted: true
        });
        if (!validation.valid || !validation.accepted || !validation.artifact || !validation.artifact_sha256) {
            violations.push(
                `current '${reviewType}' findings validation is not accepted: ${validation.violations.join(' ') || 'invalid artifact'}`
            );
            continue;
        }
        for (const finding of artifactFindings(validation.artifact)) {
            currentFindings.set(`${reviewType}:${finding.id}`, {
                artifactPath,
                artifactSha256: validation.artifact_sha256,
                validationResultSha256: validation.artifact.validation_result_sha256
            });
        }
    }

    const declaredFindingKeys = new Set<string>();
    for (const obligation of contract.finding_obligations) {
        const findingKey = `${obligation.review_type}:${obligation.finding_id}`;
        declaredFindingKeys.add(findingKey);
        const currentFinding = currentFindings.get(findingKey);
        if (!currentFinding) {
            violations.push(`declared finding obligation '${findingKey}' has no current accepted validation artifact`);
            continue;
        }
        const resolvedSourcePath = resolveFindingValidationSourcePath(
            repoRoot,
            obligation.validation_artifact_path
        );
        if (path.resolve(resolvedSourcePath) !== path.resolve(currentFinding.artifactPath)) {
            violations.push(`finding obligation '${findingKey}' must reference the current canonical validation artifact`);
            continue;
        }
        if (obligation.validation_artifact_sha256 !== currentFinding.artifactSha256) {
            violations.push(`finding obligation '${findingKey}' validation_artifact_sha256 mismatch`);
        }
        if (obligation.validation_result_sha256 !== currentFinding.validationResultSha256) {
            violations.push(`finding obligation '${findingKey}' validation_result_sha256 mismatch`);
        }
    }

    const uncoveredFindings = [...currentFindings.keys()].filter((findingKey) => !declaredFindingKeys.has(findingKey));
    if (uncoveredFindings.length > 0) {
        violations.push(`uncovered current validated findings: ${uncoveredFindings.join(', ')}`);
    }
    return violations;
}
