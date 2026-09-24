import * as path from 'node:path';
import { pathExists } from '../core/filesystem';
import { bindContainedDestination, writeContainedFile } from '../core/contained-filesystem';
import { formatJson, readJsonFile } from '../core/json';
import { asObjectRecord, listBuiltinSkillPacks } from './skill-manifest';
import { writeSkillsHeadlines } from './skill-headlines';

export interface SkillsIndexPackEntry {
    id: string;
    label: string;
    description: string;
    tags: string[];
    recommended_for: string[];
    skill_count: number;
    ready_skill_count: number;
    placeholder_skill_count: number;
    implemented: boolean;
    collides_with_baseline: boolean;
}

export interface SkillsIndexSkillEntry {
    id: string;
    name: string;
    pack: string;
    summary: string;
    tags: string[];
    aliases: string[];
    stack_signals: string[];
    task_signals: string[];
    changed_path_signals: string[];
    references: string[];
    cost_hint: string;
    priority: number;
    autoload: string;
    deprecated: boolean;
    replaced_by: string | null;
    implemented: boolean;
    template_skill_path: string;
}

export interface SkillsIndexPayload {
    version: number;
    packs: SkillsIndexPackEntry[];
    skills: SkillsIndexSkillEntry[];
}

export interface SkillsIndexData {
    indexPath: string;
    payload: SkillsIndexPayload;
}

export const SKILLS_INDEX_VERSION = 1;

export function getSkillsIndexConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'skills-index.json');
}

function getTemplateSkillRelativePath(packId: string, skillId: string): string {
    return path.join('template', 'skill-packs', packId, 'skills', skillId, 'SKILL.md').replace(/\\/g, '/');
}

export function buildSkillsIndex(bundleRoot: string): SkillsIndexPayload {
    const builtinPacks = listBuiltinSkillPacks(bundleRoot);
    return {
        version: SKILLS_INDEX_VERSION,
        packs: builtinPacks.map((pack) => ({
            id: pack.id,
            label: pack.label,
            description: pack.description,
            tags: pack.tags,
            recommended_for: pack.recommendedFor,
            skill_count: pack.skillCount,
            ready_skill_count: pack.readySkillCount,
            placeholder_skill_count: pack.placeholderSkillCount,
            implemented: pack.implemented,
            collides_with_baseline: pack.collidesWithBaseline
        })),
        skills: builtinPacks
            .flatMap((pack) => pack.skills.map((skill) => ({
                id: skill.id,
                name: skill.name,
                pack: skill.pack,
                summary: skill.summary,
                tags: skill.tags,
                aliases: skill.aliases,
                stack_signals: skill.stackSignals,
                task_signals: skill.taskSignals,
                changed_path_signals: skill.changedPathSignals,
                references: skill.references,
                cost_hint: skill.costHint,
                priority: skill.priority,
                autoload: skill.autoload,
                deprecated: skill.deprecated,
                replaced_by: skill.replacedBy,
                implemented: skill.implemented !== false,
                template_skill_path: getTemplateSkillRelativePath(pack.id, skill.id)
            })))
            .sort((left, right) => left.id.localeCompare(right.id))
    };
}

export function writeSkillsIndex(bundleRoot: string): string {
    const indexPath = getSkillsIndexConfigPath(bundleRoot);
    bindContainedDestination(bundleRoot, indexPath);
    writeContainedFile(bundleRoot, indexPath, formatJson(buildSkillsIndex(bundleRoot)));
    writeSkillsHeadlines(bundleRoot);
    return indexPath;
}

export function readSkillsIndex(bundleRoot: string): SkillsIndexData {
    const indexPath = getSkillsIndexConfigPath(bundleRoot);
    if (!pathExists(indexPath)) {
        throw new Error(`Skills index is missing: ${indexPath}`);
    }

    const payload = asObjectRecord(readJsonFile(indexPath));
    if (!payload || !Array.isArray(payload.packs) || !Array.isArray(payload.skills)) {
        throw new Error(`Skills index has an invalid shape: ${indexPath}`);
    }

    return {
        indexPath,
        payload: payload as unknown as SkillsIndexPayload
    };
}

export function validateSkillsIndex(bundleRoot: string) {
    const indexPath = getSkillsIndexConfigPath(bundleRoot);
    const issues: string[] = [];
    const expected = buildSkillsIndex(bundleRoot);

    if (!pathExists(indexPath)) {
        issues.push(`Skills index is missing: ${indexPath}`);
        return { indexPath, expected, issues, passed: false };
    }

    let parsed: unknown = null;
    try {
        parsed = readJsonFile(indexPath);
    } catch {
        issues.push(`Skills index is not valid JSON: ${indexPath}`);
        return { indexPath, expected, issues, passed: false };
    }

    const actualSerialized = JSON.stringify(parsed);
    const expectedSerialized = JSON.stringify(expected);
    if (actualSerialized !== expectedSerialized) {
        issues.push(`Skills index is stale: ${indexPath}. Re-run init/materialization to refresh it.`);
    }

    return {
        indexPath,
        expected,
        issues,
        passed: issues.length === 0
    };
}
