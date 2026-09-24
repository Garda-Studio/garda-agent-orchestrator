import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists } from '../core/filesystem';
import {
    bindContainedDestination,
    copyContainedFile,
    ensureContainedDirectory,
    removeContainedPath,
    writeContainedFile
} from '../core/contained-filesystem';
import { formatJson, readJsonFile } from '../core/json';

import {
    BASELINE_SKILL_DIRECTORIES,
    asObjectRecord,
    getPackTemplateRoot,
    getBuiltinSkillPackDefinition,
    listBuiltinSkillPacks,
    readBaselineSkillManifest,
    readSkillManifest,
    collectMissingReferenceIssues
} from './skill-manifest';

import {
    getSkillsIndexConfigPath,
    validateSkillsIndex
} from './skill-index';
import {
    ensureSkillsHeadlinesCurrent,
    getSkillsHeadlinesConfigPath,
    validateSkillsHeadlines,
    writeSkillsHeadlines
} from './skill-headlines';
import {
    getDefaultReviewCapabilities,
    getReviewSkillCandidates,
    hasSkillEntrypoint,
    readReviewCapabilitiesConfigFile,
    OPTIONAL_REVIEW_CAPABILITY_KEYS,
    type ReviewCapabilities
} from '../core/review-capabilities';



interface InstalledSkillPacksPayload {
    version: number;
    installed_packs: string[];
}

interface ReadInstalledSkillPacksResult {
    configPath: string;
    installedPackIds: string[];
}

interface ListedBuiltinPack {
    id: string;
    label: string;
    description: string;
    tags: string[];
    recommendedFor: string[];
    skillCount: number;
    readySkillCount: number;
    readySkillDirectories: string[];
    placeholderSkillCount: number;
    placeholderSkillDirectories: string[];
    implemented: boolean;
    collidesWithBaseline: boolean;
    skillDirectories: string[];
    installed: boolean;
}

export interface SkillPackListing {
    configPath: string;
    indexPath: string;
    headlinesPath: string;
    baselineSkillDirectories: string[];
    liveSkillDirectories: string[];
    installedPackIds: string[];
    installedOptionalSkillDirectories: string[];
    builtinPacks: ListedBuiltinPack[];
    customSkillDirectories: string[];
}

interface ListSkillPacksOptions {
    refreshHeadlines?: boolean;
}

const DEFAULT_INSTALLED_PACKS_PAYLOAD: Readonly<InstalledSkillPacksPayload> = Object.freeze({
    version: 1,
    installed_packs: []
});

export function getSkillPacksConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'skill-packs.json');
}

export function getReviewCapabilitiesConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'review-capabilities.json');
}

function getLiveSkillsRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'skills');
}

function readTemplateReviewCapabilities(bundleRoot: string): ReviewCapabilities {
    const templatePath = path.join(bundleRoot, 'template', 'config', 'review-capabilities.json');
    if (!pathExists(templatePath)) {
        return getDefaultReviewCapabilities();
    }

    try {
        return readReviewCapabilitiesConfigFile(templatePath);
    } catch {
        return getDefaultReviewCapabilities();
    }
}

function listLiveSkillDirectories(bundleRoot: string): string[] {
    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    bindContainedDestination(bundleRoot, liveSkillsRoot);
    if (!pathExists(liveSkillsRoot)) {
        return [];
    }

    return fs.readdirSync(liveSkillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

export function syncReviewCapabilities(bundleRoot: string): { configPath: string; capabilities: ReviewCapabilities } {
    const configPath = getReviewCapabilitiesConfigPath(bundleRoot);
    bindContainedDestination(bundleRoot, configPath);
    const capabilities = readTemplateReviewCapabilities(bundleRoot);
    const readyLiveSkillDirectorySet = new Set(
        listLiveSkillDirectories(bundleRoot).filter((skillDir) => {
            return hasSkillEntrypoint(path.join(getLiveSkillsRoot(bundleRoot), skillDir));
        })
    );

    for (const capabilityKey of OPTIONAL_REVIEW_CAPABILITY_KEYS) {
        const candidateDirectories = getReviewSkillCandidates(capabilityKey);
        capabilities[capabilityKey] = candidateDirectories.some((candidate: string) => readyLiveSkillDirectorySet.has(candidate));
    }

    writeContainedFile(bundleRoot, configPath, formatJson(capabilities));

    return {
        configPath,
        capabilities
    };
}

function validateInstalledPackIds(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const normalized: string[] = [];
    for (const item of value) {
        const text = String(item || '').trim();
        if (!text || normalized.includes(text)) {
            continue;
        }
        normalized.push(text);
    }

    return normalized.sort();
}

export function readInstalledSkillPacks(bundleRoot: string): ReadInstalledSkillPacksResult {
    const configPath = getSkillPacksConfigPath(bundleRoot);
    bindContainedDestination(bundleRoot, configPath);
    if (!pathExists(configPath)) {
        return {
            configPath,
            installedPackIds: []
        };
    }

    const payload = asObjectRecord(readJsonFile(configPath));
    return {
        configPath,
        installedPackIds: validateInstalledPackIds(payload.installed_packs)
    };
}

export function writeInstalledSkillPacks(bundleRoot: string, installedPackIds: unknown): string {
    const configPath = getSkillPacksConfigPath(bundleRoot);
    writeContainedFile(bundleRoot, configPath, formatJson({
        ...DEFAULT_INSTALLED_PACKS_PAYLOAD,
        installed_packs: validateInstalledPackIds(installedPackIds)
    }));
    return configPath;
}

export function listSkillPacks(bundleRoot: string, options: ListSkillPacksOptions = {}): SkillPackListing {
    const refreshHeadlines = options.refreshHeadlines !== false;
    const headlinesPath = refreshHeadlines
        ? ensureSkillsHeadlinesCurrent(bundleRoot).headlinesPath
        : getSkillsHeadlinesConfigPath(bundleRoot);
    const installed = readInstalledSkillPacks(bundleRoot);
    const liveSkillDirectories = listLiveSkillDirectories(bundleRoot);
    const builtinPacks = listBuiltinSkillPacks(bundleRoot);
    const managedPackSkillDirs = new Set<string>();

    for (const packId of installed.installedPackIds) {
        const pack = builtinPacks.find((candidate) => candidate.id === packId);
        if (!pack) {
            continue;
        }
        for (const skillDir of pack.skillDirectories) {
            managedPackSkillDirs.add(skillDir);
        }
    }

    const customSkillDirectories = liveSkillDirectories.filter((skillDir: string) => {
        return !BASELINE_SKILL_DIRECTORIES.includes(skillDir) && !managedPackSkillDirs.has(skillDir);
    });
    const installedOptionalSkillDirectories = liveSkillDirectories.filter((skillDir: string) => managedPackSkillDirs.has(skillDir));

    return {
        configPath: installed.configPath,
        indexPath: getSkillsIndexConfigPath(bundleRoot),
        headlinesPath,
        baselineSkillDirectories: [...BASELINE_SKILL_DIRECTORIES],
        liveSkillDirectories,
        installedPackIds: installed.installedPackIds,
        installedOptionalSkillDirectories,
        builtinPacks: builtinPacks.map((pack) => ({
            id: pack.id,
            label: pack.label,
            description: pack.description,
            tags: pack.tags,
            recommendedFor: pack.recommendedFor,
            skillCount: pack.skillCount,
            readySkillCount: pack.readySkillCount,
            readySkillDirectories: [...pack.readySkillDirectories],
            placeholderSkillCount: pack.placeholderSkillCount,
            placeholderSkillDirectories: [...pack.placeholderSkillDirectories],
            implemented: pack.implemented,
            collidesWithBaseline: pack.collidesWithBaseline,
            skillDirectories: [...pack.skillDirectories],
            installed: installed.installedPackIds.includes(pack.id)
        })),
        customSkillDirectories
    };
}

function assertSkillTree(root: string, entryPath: string): void {
    bindContainedDestination(root, entryPath);
    const stat = fs.lstatSync(entryPath);
    if (stat.isFile()) return;
    if (!stat.isDirectory()) throw new Error(`Unsupported skill asset: ${entryPath}`);
    for (const entry of fs.readdirSync(entryPath)) {
        assertSkillTree(root, path.join(entryPath, entry));
    }
}

function copyDirectoryRecursive(bundleRoot: string, templateRoot: string, sourcePath: string, destinationPath: string): void {
    bindContainedDestination(templateRoot, sourcePath);
    ensureContainedDirectory(bundleRoot, destinationPath);
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
        const sourceEntryPath = path.join(sourcePath, entry.name);
        const destinationEntryPath = path.join(destinationPath, entry.name);
        bindContainedDestination(templateRoot, sourceEntryPath);
        if (entry.isDirectory()) {
            copyDirectoryRecursive(bundleRoot, templateRoot, sourceEntryPath, destinationEntryPath);
        } else if (entry.isFile()) {
            copyContainedFile(bundleRoot, sourceEntryPath, destinationEntryPath);
        } else {
            throw new Error(`Unsupported skill asset: ${sourceEntryPath}`);
        }
    }
}

function assertSkillPackOutputPaths(bundleRoot: string): void {
    for (const destination of [
        getSkillPacksConfigPath(bundleRoot),
        getReviewCapabilitiesConfigPath(bundleRoot),
        getSkillsHeadlinesConfigPath(bundleRoot)
    ]) {
        bindContainedDestination(bundleRoot, destination);
    }
}

export function addSkillPack(bundleRoot: string, packId: string) {
    const pack = getBuiltinSkillPackDefinition(bundleRoot, packId);
    if (!pack) {
        throw new Error(`Unknown skill pack '${packId}'.`);
    }

    const templateRoot = getPackTemplateRoot(bundleRoot, packId);
    if (!pathExists(templateRoot)) {
        throw new Error(`Skill pack template is missing: ${templateRoot}`);
    }

    const current = readInstalledSkillPacks(bundleRoot);
    if (current.installedPackIds.includes(packId)) {
        return {
            packId,
            changed: false,
            installedPackIds: current.installedPackIds,
            installedSkillDirectories: [...pack.skillDirectories],
            configPath: current.configPath,
            headlinesPath: getSkillsHeadlinesConfigPath(bundleRoot)
        };
    }

    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    bindContainedDestination(bundleRoot, liveSkillsRoot);
    assertSkillPackOutputPaths(bundleRoot);
    for (const skillDir of pack.skillDirectories) {
        const sourceSkillDir = path.join(templateRoot, 'skills', skillDir);
        const destinationSkillDir = path.join(liveSkillsRoot, skillDir);
        if (!pathExists(sourceSkillDir)) {
            throw new Error(`Skill pack asset is missing: ${sourceSkillDir}`);
        }
        assertSkillTree(templateRoot, sourceSkillDir);
        if (!bindContainedDestination(bundleRoot, destinationSkillDir).missingAt) {
            throw new Error(`Cannot install skill pack '${packId}' because '${destinationSkillDir}' already exists.`);
        }
    }

    for (const skillDir of pack.skillDirectories) {
        copyDirectoryRecursive(bundleRoot, templateRoot,
            path.join(templateRoot, 'skills', skillDir), path.join(liveSkillsRoot, skillDir));
    }

    const updatedPackIds = [...current.installedPackIds, packId].sort();
    const configPath = writeInstalledSkillPacks(bundleRoot, updatedPackIds);
    const reviewCapabilities = syncReviewCapabilities(bundleRoot);
    const headlinesPath = writeSkillsHeadlines(bundleRoot);

    return {
        packId,
        changed: true,
        installedPackIds: updatedPackIds,
        installedSkillDirectories: [...pack.skillDirectories],
        configPath,
        headlinesPath,
        reviewCapabilitiesPath: reviewCapabilities.configPath,
        reviewCapabilities: reviewCapabilities.capabilities
    };
}

export function removeSkillPack(bundleRoot: string, packId: string) {
    const pack = getBuiltinSkillPackDefinition(bundleRoot, packId);
    if (!pack) {
        throw new Error(`Unknown skill pack '${packId}'.`);
    }

    const current = readInstalledSkillPacks(bundleRoot);
    if (!current.installedPackIds.includes(packId)) {
        return {
            packId,
            changed: false,
            removedSkillDirectories: [],
            installedPackIds: current.installedPackIds,
            configPath: current.configPath,
            headlinesPath: getSkillsHeadlinesConfigPath(bundleRoot)
        };
    }

    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    bindContainedDestination(bundleRoot, liveSkillsRoot);
    assertSkillPackOutputPaths(bundleRoot);
    const removedSkillDirectories: string[] = [];
    for (const skillDir of pack.skillDirectories) {
        const destinationSkillDir = path.join(liveSkillsRoot, skillDir);
        if (!bindContainedDestination(bundleRoot, destinationSkillDir).missingAt) {
            assertSkillTree(bundleRoot, destinationSkillDir);
        }
    }
    for (const skillDir of pack.skillDirectories) {
        const destinationSkillDir = path.join(liveSkillsRoot, skillDir);
        if (!bindContainedDestination(bundleRoot, destinationSkillDir).missingAt) {
            removeContainedPath(bundleRoot, destinationSkillDir, true);
            removedSkillDirectories.push(skillDir);
        }
    }

    const updatedPackIds = current.installedPackIds.filter((candidate: string) => candidate !== packId);
    const configPath = writeInstalledSkillPacks(bundleRoot, updatedPackIds);
    const reviewCapabilities = syncReviewCapabilities(bundleRoot);
    const headlinesPath = writeSkillsHeadlines(bundleRoot);

    return {
        packId,
        changed: true,
        removedSkillDirectories,
        installedPackIds: updatedPackIds,
        configPath,
        headlinesPath,
        reviewCapabilitiesPath: reviewCapabilities.configPath,
        reviewCapabilities: reviewCapabilities.capabilities
    };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function validateSkillPacks(bundleRoot: string) {
    const listing = listSkillPacks(bundleRoot, { refreshHeadlines: false });
    const issues: string[] = [];
    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    const liveSkillsReadmePath = path.join(liveSkillsRoot, 'README.md');

    if (!pathExists(liveSkillsReadmePath)) {
        issues.push(`Live skills README is missing: ${liveSkillsReadmePath}`);
    }

    for (const skillDir of BASELINE_SKILL_DIRECTORIES) {
        const skillRoot = path.join(liveSkillsRoot, skillDir);
        const skillPath = path.join(skillRoot, 'SKILL.md');
        const skillManifestPath = path.join(skillRoot, 'skill.json');

        if (!pathExists(skillRoot)) {
            issues.push(`Baseline skill directory is missing: ${skillRoot}`);
            continue;
        }

        if (!pathExists(skillManifestPath)) {
            issues.push(`Baseline skill '${skillDir}' is missing '${skillDir}/skill.json'.`);
        } else {
            try {
                const manifest = readBaselineSkillManifest(skillRoot);
                if (manifest.id !== skillDir) {
                    issues.push(`Baseline skill '${skillDir}' declares id '${manifest.id}' instead of '${skillDir}'.`);
                }
                issues.push(...collectMissingReferenceIssues(skillRoot, manifest, `Baseline skill '${skillDir}'`));
            } catch (error) {
                issues.push(`Baseline skill '${skillDir}' has an invalid manifest: ${getErrorMessage(error)}`);
            }
        }

        if (!pathExists(skillPath)) {
            issues.push(`Baseline skill '${skillDir}' is missing '${skillDir}/SKILL.md'.`);
        }
    }

    for (const pack of listing.builtinPacks) {
        if (pack.collidesWithBaseline) {
            issues.push(`Optional skill pack '${pack.id}' collides with baseline skill id '${pack.id}'. Optional packs must not duplicate baseline skills.`);
        }
        for (const skillDir of pack.skillDirectories) {
            if (BASELINE_SKILL_DIRECTORIES.includes(skillDir)) {
                issues.push(`Optional skill pack '${pack.id}' includes skill directory '${skillDir}' that duplicates a baseline skill.`);
            }
        }
    }

    for (const packId of listing.installedPackIds) {
        const pack = getBuiltinSkillPackDefinition(bundleRoot, packId);
        if (!pack) {
            issues.push(`Installed skill pack '${packId}' is not a known built-in pack.`);
            continue;
        }

        for (const skillDir of pack.skillDirectories) {
            const skillRoot = path.join(getLiveSkillsRoot(bundleRoot), skillDir);
            const skillPath = path.join(skillRoot, 'SKILL.md');
            const skillManifestPath = path.join(skillRoot, 'skill.json');

            if (!pathExists(skillRoot)) {
                issues.push(`Installed skill pack '${packId}' is missing live skill directory '${skillDir}'.`);
                continue;
            }

            if (!pathExists(skillManifestPath)) {
                issues.push(`Installed skill pack '${packId}' is missing '${skillDir}/skill.json'.`);
            } else {
                try {
                    const manifest = readSkillManifest(skillRoot, packId);
                    if (manifest.id !== skillDir) {
                        issues.push(`Installed skill '${skillDir}' declares id '${manifest.id}' instead of '${skillDir}'.`);
                    }
                    if (manifest.pack !== packId) {
                        issues.push(`Installed skill '${skillDir}' declares pack '${manifest.pack}' instead of '${packId}'.`);
                    }
                    issues.push(...collectMissingReferenceIssues(skillRoot, manifest, `Installed skill '${skillDir}'`));
                } catch (error) {
                    issues.push(`Installed skill '${skillDir}' has an invalid manifest: ${getErrorMessage(error)}`);
                }
            }

            if (!pathExists(skillPath)) {
                issues.push(`Installed skill pack '${packId}' is missing '${skillDir}/SKILL.md'.`);
            }
        }
    }

    const skillsIndexValidation = validateSkillsIndex(bundleRoot);
    issues.push(...skillsIndexValidation.issues);
    const skillsHeadlinesValidation = validateSkillsHeadlines(bundleRoot);
    issues.push(...skillsHeadlinesValidation.issues);

    return {
        ...listing,
        issues,
        passed: issues.length === 0
    };
}
