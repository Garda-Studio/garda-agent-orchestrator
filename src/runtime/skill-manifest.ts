import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists, readTextFile } from '../core/filesystem';
import { readJsonFile } from '../core/json';

type JsonObject = Record<string, unknown>;

export interface SkillPackManifestDefinition {
    id: string;
    label: string;
    description: string;
    tags: string[];
    recommendedFor: string[];
    packRoot: string;
}

export interface SkillManifestDefinition {
    id: string;
    name: string;
    pack: string;
    summary: string;
    tags: string[];
    aliases: string[];
    stackSignals: string[];
    taskSignals: string[];
    changedPathSignals: string[];
    references: string[];
    costHint: string;
    priority: number;
    autoload: string;
    deprecated: boolean;
    replacedBy: string | null;
    implemented: boolean;
    skillRoot: string;
}

export interface BaselineSkillManifestDefinition {
    id: string;
    name: string;
    summary: string;
    tags: string[];
    aliases: string[];
    references: string[];
    costHint: string;
    priority: number;
    autoload: string;
    skillRoot: string;
}

export interface ManifestWithReferences {
    references: string[];
}

export interface BuiltinSkillPackDefinition extends SkillPackManifestDefinition {
    skills: SkillManifestDefinition[];
    skillCount: number;
    skillDirectories: string[];
    readySkillCount: number;
    readySkillDirectories: string[];
    placeholderSkillCount: number;
    placeholderSkillDirectories: string[];
    implemented: boolean;
    collidesWithBaseline: boolean;
}

const OPTIONAL_SKILL_PLACEHOLDER_PATTERN = /TODO:\s*fill this optional skill\.?/i;

export const BASELINE_SKILL_DIRECTORIES = Object.freeze([
    'code-review',
    'db-review',
    'dependency-review',
    'orchestration',
    'orchestration-depth1',
    'refactor-review',
    'security-review',
    'skill-builder',
    'test-review'
]);

// Shared normalization helpers — used by manifest parsing and callers that
// need the same lightweight conversions (e.g. suggestion scoring).

export function asObjectRecord(value: unknown): JsonObject {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonObject
        : {};
}

export function normalizeStringArray(value: unknown): string[] {
    const items: unknown[] = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
    const normalized: string[] = [];
    for (const item of items) {
        const text = String(item || '').trim();
        if (!text || normalized.includes(text)) {
            continue;
        }
        normalized.push(text);
    }
    return normalized.sort();
}

export function normalizeOptionalString(value: unknown): string | null {
    const text = String(value || '').trim();
    return text || null;
}

export function normalizeRequiredString(value: unknown, fieldName: string): string {
    const text = normalizeOptionalString(value);
    if (!text) {
        throw new Error(`${fieldName} is required.`);
    }
    return text;
}

export function normalizeNonNegativeInteger(value: unknown, fallbackValue: number): number {
    if (value === undefined || value === null || value === '') {
        return fallbackValue;
    }
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 0) {
        throw new Error(`Expected a non-negative integer, got '${value}'.`);
    }
    return numeric;
}

function getTemplateSkillPacksRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'template', 'skill-packs');
}

export function getPackTemplateRoot(bundleRoot: string, packId: string): string {
    return path.join(getTemplateSkillPacksRoot(bundleRoot), packId);
}

function getPackManifestPath(packRoot: string): string {
    return path.join(packRoot, 'pack.json');
}

function getSkillManifestPath(skillRoot: string): string {
    return path.join(skillRoot, 'skill.json');
}

function isPlaceholderOptionalSkill(summary: unknown, skillRoot: string): boolean {
    if (OPTIONAL_SKILL_PLACEHOLDER_PATTERN.test(String(summary || ''))) {
        return true;
    }

    const skillPath = path.join(skillRoot, 'SKILL.md');
    if (!pathExists(skillPath)) {
        return false;
    }

    try {
        return OPTIONAL_SKILL_PLACEHOLDER_PATTERN.test(readTextFile(skillPath));
    } catch {
        return false;
    }
}

export function readPackManifest(packRoot: string): SkillPackManifestDefinition {
    const manifestPath = getPackManifestPath(packRoot);
    if (!pathExists(manifestPath)) {
        throw new Error(`Skill pack manifest is missing: ${manifestPath}`);
    }

    const manifest = asObjectRecord(readJsonFile(manifestPath));
    const fallbackPackId = path.basename(packRoot);

    return {
        id: normalizeRequiredString(manifest.id || fallbackPackId, `pack.json id (${fallbackPackId})`),
        label: normalizeRequiredString(manifest.label || fallbackPackId, `pack.json label (${fallbackPackId})`),
        description: normalizeRequiredString(manifest.description, `pack.json description (${fallbackPackId})`),
        tags: normalizeStringArray(manifest.tags),
        recommendedFor: normalizeStringArray(manifest.recommended_for),
        packRoot
    };
}

export function readSkillManifest(skillRoot: string, fallbackPackId: string): SkillManifestDefinition {
    const manifestPath = getSkillManifestPath(skillRoot);
    if (!pathExists(manifestPath)) {
        throw new Error(`Skill manifest is missing: ${manifestPath}`);
    }

    const manifest = asObjectRecord(readJsonFile(manifestPath));
    const fallbackSkillId = path.basename(skillRoot);
    const skillId = normalizeRequiredString(manifest.id || fallbackSkillId, `skill.json id (${fallbackSkillId})`);
    const packId = normalizeRequiredString(manifest.pack || fallbackPackId, `skill.json pack (${skillId})`);

    return {
        id: skillId,
        name: normalizeRequiredString(manifest.name || skillId, `skill.json name (${skillId})`),
        pack: packId,
        summary: normalizeRequiredString(manifest.summary, `skill.json summary (${skillId})`),
        tags: normalizeStringArray(manifest.tags),
        aliases: normalizeStringArray(manifest.aliases),
        stackSignals: normalizeStringArray(manifest.stack_signals),
        taskSignals: normalizeStringArray(manifest.task_signals),
        changedPathSignals: normalizeStringArray(manifest.changed_path_signals),
        references: normalizeStringArray(manifest.references),
        costHint: normalizeRequiredString(manifest.cost_hint || 'low', `skill.json cost_hint (${skillId})`),
        priority: normalizeNonNegativeInteger(manifest.priority, 50),
        autoload: normalizeRequiredString(manifest.autoload || 'never', `skill.json autoload (${skillId})`),
        deprecated: manifest.deprecated === true,
        replacedBy: normalizeOptionalString(manifest.replaced_by),
        implemented: !isPlaceholderOptionalSkill(manifest.summary, skillRoot),
        skillRoot
    };
}

export function readBaselineSkillManifest(skillRoot: string): BaselineSkillManifestDefinition {
    const manifestPath = getSkillManifestPath(skillRoot);
    if (!pathExists(manifestPath)) {
        throw new Error(`Skill manifest is missing: ${manifestPath}`);
    }

    const manifest = asObjectRecord(readJsonFile(manifestPath));
    const fallbackSkillId = path.basename(skillRoot);

    return {
        id: normalizeRequiredString(manifest.id || fallbackSkillId, `skill.json id (${fallbackSkillId})`),
        name: normalizeRequiredString(manifest.name || fallbackSkillId, `skill.json name (${fallbackSkillId})`),
        summary: normalizeRequiredString(manifest.summary, `skill.json summary (${fallbackSkillId})`),
        tags: normalizeStringArray(manifest.tags),
        aliases: normalizeStringArray(manifest.aliases),
        references: normalizeStringArray(manifest.references),
        costHint: normalizeRequiredString(manifest.cost_hint || 'low', `skill.json cost_hint (${fallbackSkillId})`),
        priority: normalizeNonNegativeInteger(manifest.priority, 50),
        autoload: normalizeRequiredString(manifest.autoload || 'never', `skill.json autoload (${fallbackSkillId})`),
        skillRoot
    };
}

export function collectMissingReferenceIssues(skillRoot: string, manifest: ManifestWithReferences, skillLabel: string): string[] {
    const issues: string[] = [];
    for (const reference of manifest.references) {
        const referencePath = path.join(skillRoot, 'references', reference);
        if (!pathExists(referencePath)) {
            issues.push(`${skillLabel} declares missing reference '${reference}'.`);
        }
    }
    return issues;
}

export function listPackSkillDefinitions(packRoot: string, packId: string): SkillManifestDefinition[] {
    const skillsRoot = path.join(packRoot, 'skills');
    if (!pathExists(skillsRoot)) {
        return [];
    }

    return fs.readdirSync(skillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => readSkillManifest(path.join(skillsRoot, entry.name), packId))
        .sort((left, right) => left.id.localeCompare(right.id));
}

export function listBuiltinSkillPacks(bundleRoot: string): BuiltinSkillPackDefinition[] {
    const templateSkillPacksRoot = getTemplateSkillPacksRoot(bundleRoot);
    if (!pathExists(templateSkillPacksRoot)) {
        return [];
    }

    return fs.readdirSync(templateSkillPacksRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const packRoot = path.join(templateSkillPacksRoot, entry.name);
            const manifest = readPackManifest(packRoot);
            const skills = listPackSkillDefinitions(packRoot, manifest.id);
            const readySkills = skills.filter((skill) => skill.implemented !== false);
            const placeholderSkills = skills.filter((skill) => skill.implemented === false);
            return {
                ...manifest,
                skills,
                skillCount: skills.length,
                skillDirectories: skills.map((skill) => skill.id),
                readySkillCount: readySkills.length,
                readySkillDirectories: readySkills.map((skill) => skill.id),
                placeholderSkillCount: placeholderSkills.length,
                placeholderSkillDirectories: placeholderSkills.map((skill) => skill.id),
                implemented: readySkills.length > 0,
                collidesWithBaseline: BASELINE_SKILL_DIRECTORIES.includes(manifest.id)
            };
        })
        .sort((left, right) => left.id.localeCompare(right.id));
}

export function getBuiltinSkillPackDefinition(bundleRoot: string, packId: string): BuiltinSkillPackDefinition | null {
    return listBuiltinSkillPacks(bundleRoot).find((pack) => pack.id === packId) || null;
}
