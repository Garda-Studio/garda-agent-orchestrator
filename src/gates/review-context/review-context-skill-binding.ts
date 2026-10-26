import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { bindContainedDestination, assertContainedDestination } from '../../core/contained-filesystem';
import { statFileIdentitySync } from '../../core/file-stat';
import { parseJsonText } from '../../core/json';
import {
    observedInvocationValue, readInvocationFileContent, readInvocationPathObservation
} from '../../core/invocation-file-observation';
import {
    createInvocationReadMemoKey, isInvocationReadObservationActive, memoizeInvocationRead
} from '../../core/invocation-read-observation';
import { isPlainRecord } from '../../core/records';
import { resolveBundleName } from '../../core/constants';
import { hasSkillEntrypoint } from '../../core/review-capabilities';
import {
    fileSha256,
    isPathRealpathInsideRoot,
    normalizePath
} from '../shared/helpers';
import type { ReviewSkillBinding, ReviewSkillReferenceBinding } from './review-context-artifacts';

const REVIEW_SKILL_REFERENCE_LIMITS = Object.freeze({
    max_files: 32,
    max_file_bytes: 128 * 1024,
    max_total_bytes: 512 * 1024,
    max_metadata_bytes: 64 * 1024
});

function inputVersion(stat: fs.BigIntStats): string {
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
}

interface BoundedSkillInput {
    readonly bytes: Buffer;
    readonly sha256: string;
}

const BOUNDED_SKILL_INPUTS = createInvocationReadMemoKey<BoundedSkillInput>('bounded-review-skill-inputs');
const SKILL_PATH_PREDICATES = createInvocationReadMemoKey<boolean>('review-skill-path-predicates');

function skillPathExists(filePath: string): boolean {
    return memoizeInvocationRead(SKILL_PATH_PREDICATES, 'exists:' + path.resolve(filePath), () => {
        readInvocationPathObservation(filePath);
        return fs.existsSync(filePath);
    }).value;
}

function skillPathIsFile(filePath: string): boolean {
    return memoizeInvocationRead(SKILL_PATH_PREDICATES, 'file:' + path.resolve(filePath), () => {
        readInvocationPathObservation(filePath);
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    }).value;
}

function readBoundedSkillInput(filePath: string, owningRoot: string, maximumBytes: number, label: string): BoundedSkillInput {
    if (!isInvocationReadObservationActive()) {
        return readBoundedSkillInputNative(filePath, owningRoot, maximumBytes, label);
    }
    const memoId = JSON.stringify([path.resolve(owningRoot), path.resolve(filePath), maximumBytes, label]);
    const retained = memoizeInvocationRead(BOUNDED_SKILL_INPUTS, memoId, () => {
        readInvocationPathObservation(owningRoot);
        readInvocationPathObservation(filePath);
        const input = readBoundedSkillInputNative(filePath, owningRoot, maximumBytes, label);
        const content = readInvocationFileContent(filePath, maximumBytes)!;
        if (content.sha256 !== input.sha256 || content.size !== input.bytes.length) {
            throw new Error(`${label} identity or contents changed after bounded reading.`);
        }
        // The checked bytes stay private; each parser receives an isolated copy.
        return Object.freeze(input);
    }).value;
    return { bytes: Buffer.from(retained.bytes), sha256: retained.sha256 };
}

function readBoundedSkillInputNative(filePath: string, owningRoot: string, maximumBytes: number, label: string) {
    let binding;
    try {
        binding = bindContainedDestination(owningRoot, filePath);
    } catch (error) {
        throw new Error(`${label} must retain an ordinary identity inside its owning root: ${String(error)}`);
    }
    if (binding.missingAt) throw new Error(`${label} required input is missing: ${normalizePath(filePath)}.`);
    if (!isPathRealpathInsideRoot(filePath, owningRoot)) {
        throw new Error(`${label} must resolve inside its owning skill/reference root: ${normalizePath(filePath)}.`);
    }
    const before = statFileIdentitySync(filePath, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} requires a regular file: ${normalizePath(filePath)}.`);
    if (before.size > BigInt(maximumBytes)) throw new Error(`${label} exceeds its byte bound (${maximumBytes}).`);
    // A replacement FIFO must not block before the ordinary-file identity checks can run.
    const descriptor = fs.openSync(filePath,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    try {
        assertContainedDestination(binding);
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (inputVersion(opened) !== inputVersion(before)) throw new Error(`${label} identity changed before reading.`);
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
            if (count === 0) break;
            bytesRead += count;
        }
        assertContainedDestination(binding);
        if (BigInt(bytesRead) !== before.size
            || inputVersion(fs.fstatSync(descriptor, { bigint: true })) !== inputVersion(before)
            || inputVersion(statFileIdentitySync(filePath, { bigint: true })) !== inputVersion(before)) {
            throw new Error(`${label} identity or contents changed during bounded reading.`);
        }
        const bytes = buffer.subarray(0, bytesRead);
        return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    } finally {
        fs.closeSync(descriptor);
    }
}

function normalizeRequiredReferenceNames(value: unknown): string[] {
    if (!Array.isArray(value)) throw new Error('Review skill references must be a declared string array.');
    if (value.length > REVIEW_SKILL_REFERENCE_LIMITS.max_files) {
        throw new Error(`Review skill reference count exceeds its bound (${REVIEW_SKILL_REFERENCE_LIMITS.max_files}).`);
    }
    const names: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string' || !entry || entry.trim() !== entry
            || /[\u0000-\u001f\u007f:]/.test(entry) || path.isAbsolute(entry) || path.win32.isAbsolute(entry)) {
            throw new Error('Review skill reference path must be a nonempty relative path without control characters.');
        }
        const name = entry.replace(/\\/g, '/');
        if (name.split('/').some((component) => !component || component === '.' || component === '..')) {
            throw new Error('Review skill reference path cannot contain traversal or empty components.');
        }
        if (names.includes(name)) throw new Error(`Review skill reference path is duplicated: ${name}.`);
        names.push(name);
    }
    return names.sort();
}

function resolveRequiredReferences(skillRoot: string): ReviewSkillReferenceBinding | undefined {
    const metadataPath = path.join(skillRoot, 'skill.json');
    try {
        const observation = readInvocationPathObservation(metadataPath);
        if (observation) observedInvocationValue(observation.stat);
        else fs.lstatSync(metadataPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    const metadata = readBoundedSkillInput(metadataPath, skillRoot,
        REVIEW_SKILL_REFERENCE_LIMITS.max_metadata_bytes, 'Review skill metadata');
    const parsed = parseJsonText(metadata.bytes.toString('utf8'), normalizePath(metadataPath));
    if (!isPlainRecord(parsed)) throw new Error('Review skill metadata must be a JSON object.');
    if (parsed.references == null) return undefined;
    const names = normalizeRequiredReferenceNames(parsed.references);
    if (names.length === 0) return undefined;
    const referenceRoot = path.join(skillRoot, 'references');
    if (!isPathRealpathInsideRoot(referenceRoot, skillRoot)) {
        throw new Error(`Review skill reference root must stay inside the owning skill: ${normalizePath(referenceRoot)}.`);
    }
    let totalBytes = 0;
    const references = names.map((name) => {
        const referencePath = path.join(referenceRoot, name);
        const availableBytes = Math.min(REVIEW_SKILL_REFERENCE_LIMITS.max_file_bytes,
            REVIEW_SKILL_REFERENCE_LIMITS.max_total_bytes - totalBytes);
        const label = availableBytes < REVIEW_SKILL_REFERENCE_LIMITS.max_file_bytes
            ? 'Review skill reference total bytes' : 'Review skill reference';
        const input = readBoundedSkillInput(referencePath, referenceRoot,
            availableBytes, label);
        totalBytes += input.bytes.length;
        return { reference_path: normalizePath(referencePath), reference_sha256: input.sha256, reference_bytes: input.bytes.length };
    });
    return {
        schema_version: 1,
        metadata_path: normalizePath(metadataPath),
        metadata_sha256: metadata.sha256,
        reference_root_path: normalizePath(referenceRoot),
        limits: { ...REVIEW_SKILL_REFERENCE_LIMITS },
        required_references: references
    };
}

export function resolveCatalogReviewSkillBinding(
    skillIds: readonly string[],
    repoRoot: string
): ReviewSkillBinding {
    const candidates = [...skillIds];
    const resolvedRepoRoot = path.resolve(repoRoot);
    const invalidSkillId = candidates.find((candidate) => (
        candidate.length === 0
        || candidate.trim() !== candidate
        || candidate === '.'
        || candidate === '..'
        || candidate.includes('/')
        || candidate.includes('\\')
        || candidate.includes('\0')
        || path.isAbsolute(candidate)
    ));
    if (invalidSkillId !== undefined) {
        throw new Error(
            `ReviewSkillId must be a single catalog path component without traversal: ${invalidSkillId}.`
        );
    }
    const resolvedSkillsRoot = path.join(resolvedRepoRoot, resolveBundleName(), 'live', 'skills');
    if (
        skillPathExists(resolvedSkillsRoot)
        && !isPathRealpathInsideRoot(resolvedSkillsRoot, resolvedRepoRoot)
    ) {
        throw new Error(
            `ReviewSkillCatalogRoot must resolve inside repo root without symlink or junction escape: ` +
            `${normalizePath(resolvedSkillsRoot)}.`
        );
    }
    const skillId = candidates.find((candidate) => {
        const candidateRoot = path.join(resolvedSkillsRoot, candidate);
        return hasSkillEntrypoint(candidateRoot);
    }) || candidates[0] || '';
    const skillRoot = path.join(resolvedSkillsRoot, skillId);
    const skillMdPath = path.join(skillRoot, 'SKILL.md');
    const skillJsonPath = path.join(skillRoot, 'skill.json');
    const skillPath = skillPathIsFile(skillMdPath)
        ? skillMdPath
        : skillJsonPath;
    const skillExists = skillPathIsFile(skillPath);
    if (!skillExists) {
        throw new Error(
            `Review context cannot be built because immutable lane skill candidates are missing an entrypoint: ` +
            `${candidates.join(', ') || 'none'}.`
        );
    }
    if (!isPathRealpathInsideRoot(skillPath, resolvedSkillsRoot)) {
        throw new Error(
            `ReviewSkillPath must resolve inside the catalog skills root without symlink or junction escape: ` +
            `${normalizePath(skillPath)}.`
        );
    }
    const referenceBinding = resolveRequiredReferences(skillRoot);
    return {
        skill_id: skillId,
        skill_path: normalizePath(skillPath),
        skill_sha256: fileSha256(skillPath),
        skill_directory_path: normalizePath(skillRoot),
        skill_entrypoint_exists: true,
        candidate_skill_ids: candidates,
        ...(referenceBinding ? { reference_binding: referenceBinding } : {})
    };
}
