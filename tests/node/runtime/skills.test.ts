import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    FUZZY_ALIAS_GROUPS,
    MATCH_CATEGORIES,
    addSkillPack,
    containsAtWordBoundary,
    dedupeSkillsByPack,
    getFuzzyAliasMap,
    getReviewCapabilitiesConfigPath,
    getSignalFuzzyVariants,
    getSkillPacksConfigPath,
    getSkillsHeadlinesConfigPath,
    getSkillsIndexConfigPath,
    hasDistinctSignalCoverage,
    listSkillPacks,
    readSkillsHeadlines,
    readSkillsHeadlinesIfPresent,
    removeSkillPack,
    suggestSkills,
    syncReviewCapabilities,
    textMatchesFuzzyVariant,
    validateSkillPacks,
    writeSkillsIndex,
    writeSkillsHeadlines,
    writeInstalledSkillPacks,
    SignalMatches,
    SkillSuggestion,
    SKILL_TELEMETRY_EVENT_TYPES,
    SKILL_TELEMETRY_ACTOR,
    buildSkillTelemetryDetails,
    emitSkillTelemetryEvent,
    emitSkillTelemetryEventAsync,
    emitSkillSuggestedEvent,
    emitSkillSelectedEvent,
    emitSkillSelectedEventAsync,
    emitSkillReferenceLoadedEvent,
    emitSkillReferenceLoadedEventAsync
} from '../../../src/runtime/skills';
import { getBuiltinSkillPackDefinition } from '../../../src/runtime/skill-manifest';
import {
    buildSkillsHeadlines,
    computeCurrentSkillsHeadlinesSourceState,
    computeSkillsHeadlinesSourceStateHintSha256,
    computeSkillsHeadlinesSourceStateSha256
} from '../../../src/runtime/skill-headlines';

import {
    emitSkillTelemetryEventAsync as directEmitSkillTelemetryEventAsync,
    emitSkillSelectedEventAsync as directEmitSkillSelectedEventAsync,
    emitSkillReferenceLoadedEventAsync as directEmitSkillReferenceLoadedEventAsync
} from '../../../src/runtime/skill-telemetry';

function findRepoRoot() {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'template')) && fs.existsSync(path.join(current, 'package.json'))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root.');
}

function copyDirRecursive(sourcePath: string, destinationPath: string) {
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
        const sourceEntryPath = path.join(sourcePath, entry.name);
        const destinationEntryPath = path.join(destinationPath, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(sourceEntryPath, destinationEntryPath);
        } else {
            fs.copyFileSync(sourceEntryPath, destinationEntryPath);
        }
    }
}

function seedBaselineSkills(repoRoot: string, bundleRoot: string) {
    copyDirRecursive(
        path.join(repoRoot, 'template', 'skills'),
        path.join(bundleRoot, 'live', 'skills')
    );
}

function writeCustomTelegramSkill(bundleRoot: string, directory = 'telegram-tdlight') {
    const skillRoot = path.join(bundleRoot, 'live', 'skills', directory);
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'skill.json'), JSON.stringify({
        id: 'telegram-tdlight',
        name: 'Telegram TDLight',
        summary: 'Custom Telegram TDLight specialist for session, webhook, and client runtime work.',
        tags: ['custom', 'telegram', 'tdlight'],
        aliases: ['telegram-tdlight', 'tdlight'],
        task_signals: ['telegram tdlight', 'tdlight session', 'telegram client'],
        changed_path_signals: ['src/telegram/', 'telegram/tdlight'],
        references: [],
        cost_hint: 'medium',
        priority: 75,
        autoload: 'suggest'
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Telegram TDLight\n\nUse for Telegram TDLight client runtime work.\n', 'utf8');
}

test('built-in skill pack lifecycle installs, validates, lists, and removes packs', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'review-capabilities.json'), getReviewCapabilitiesConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        const addResult = addSkillPack(bundleRoot, 'node-backend');
        assert.equal(addResult.changed, true);
        assert.ok(fs.existsSync(path.join(bundleRoot, 'live', 'skills', 'node-backend', 'SKILL.md')));

        const listing = listSkillPacks(bundleRoot);
        assert.deepEqual(listing.installedPackIds, ['node-backend']);
        assert.ok(listing.baselineSkillDirectories.includes('dependency-review'));
        assert.equal(listing.builtinPacks.find((pack: { id: string; installed: boolean }) => pack.id === 'node-backend')!.installed, true);

        const validation = validateSkillPacks(bundleRoot);
        assert.equal(validation.passed, true);
        assert.equal(validation.issues.length, 0);
        assert.ok(fs.existsSync(getSkillsIndexConfigPath(bundleRoot)));
        assert.ok(fs.existsSync(getSkillsHeadlinesConfigPath(bundleRoot)));

        const headlines = readSkillsHeadlines(bundleRoot);
        assert.ok(headlines.payload.skills.some((skill) => skill.id === 'node-backend'));
        assert.ok(headlines.payload.installed_pack_ids.includes('node-backend'));
        assert.ok(headlines.payload.installed_optional_skill_ids.includes('node-backend'));
        assert.ok(headlines.payload.optional_packs.some((pack) => pack.id === 'node-backend' && pack.installed));

        const removeResult = removeSkillPack(bundleRoot, 'node-backend');
        assert.equal(removeResult.changed, true);
        assert.ok(!fs.existsSync(path.join(bundleRoot, 'live', 'skills', 'node-backend')));
        assert.deepEqual(removeResult.installedPackIds, []);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('addSkillPack synchronizes optional review capabilities for installed specialist skills', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'review-capabilities.json'), getReviewCapabilitiesConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        const qualityResult = addSkillPack(bundleRoot, 'quality-architecture');
        assert.equal(qualityResult.reviewCapabilities!.api, true);
        assert.equal(qualityResult.reviewCapabilities!.test, true);
        assert.equal(qualityResult.reviewCapabilities!.performance, true);

        const infraResult = addSkillPack(bundleRoot, 'devops-k8s');
        assert.equal(infraResult.reviewCapabilities!.infra, true);

        const persistedCapabilities = JSON.parse(fs.readFileSync(getReviewCapabilitiesConfigPath(bundleRoot), 'utf8'));
        assert.equal(persistedCapabilities.api, true);
        assert.equal(persistedCapabilities.test, true);
        assert.equal(persistedCapabilities.performance, true);
        assert.equal(persistedCapabilities.infra, true);
        assert.equal(persistedCapabilities.dependency, true);

        const removeResult = removeSkillPack(bundleRoot, 'quality-architecture');
        assert.equal(removeResult.reviewCapabilities!.api, false);
        assert.equal(removeResult.reviewCapabilities!.test, false);
        assert.equal(removeResult.reviewCapabilities!.performance, false);
        assert.equal(removeResult.reviewCapabilities!.dependency, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('syncReviewCapabilities ignores bare matching directories without a skill entrypoint', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template', 'config'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'review-capabilities.json'), getReviewCapabilitiesConfigPath(bundleRoot));

        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills', 'performance-review'), { recursive: true });
        const readySkillRoot = path.join(bundleRoot, 'live', 'skills', 'testing-strategy');
        fs.mkdirSync(readySkillRoot, { recursive: true });
        fs.writeFileSync(path.join(readySkillRoot, 'SKILL.md'), '# testing-strategy\n', 'utf8');

        const syncResult = syncReviewCapabilities(bundleRoot);
        assert.equal(syncResult.capabilities.performance, false);
        assert.equal(syncResult.capabilities.test, true);

        const persistedCapabilities = JSON.parse(fs.readFileSync(getReviewCapabilitiesConfigPath(bundleRoot), 'utf8'));
        assert.equal(persistedCapabilities.performance, false);
        assert.equal(persistedCapabilities.test, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('syncReviewCapabilities rejects a linked live config directory', (t) => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));
    try {
        const outside = path.join(bundleRoot, 'outside');
        fs.mkdirSync(outside);
        fs.mkdirSync(path.join(bundleRoot, 'live'));
        try {
            fs.symlinkSync(outside, path.join(bundleRoot, 'live', 'config'), 'junction');
        } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code || '')) {
                t.skip(`Junctions unavailable: ${code}`);
                return;
            }
            throw error;
        }
        assert.throws(() => syncReviewCapabilities(bundleRoot), /symlink|junction/);
        assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('skill indexes reject a linked live config directory', (t) => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));
    try {
        const outside = path.join(bundleRoot, 'outside');
        fs.mkdirSync(outside);
        fs.mkdirSync(path.join(bundleRoot, 'live'));
        try {
            fs.symlinkSync(outside, path.join(bundleRoot, 'live', 'config'), 'junction');
        } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code || '')) {
                t.skip(`Junctions unavailable: ${code}`);
                return;
            }
            throw error;
        }
        assert.throws(() => writeSkillsIndex(bundleRoot), /symlink|junction/);
        assert.throws(() => writeSkillsHeadlines(bundleRoot), /symlink|junction/);
        assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('writeSkillsIndex preserves the previous index when headlines destination is hard-linked', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));
    try {
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'),
            path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        const indexPath = getSkillsIndexConfigPath(bundleRoot);
        const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
        const outside = path.join(bundleRoot, 'outside-headlines.json');
        fs.writeFileSync(indexPath, 'previous-index\n');
        fs.writeFileSync(outside, 'outside-original\n');
        fs.linkSync(outside, headlinesPath);
        assert.throws(() => writeSkillsIndex(bundleRoot), /hard-linked/);
        assert.equal(fs.readFileSync(indexPath, 'utf8'), 'previous-index\n');
        assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-original\n');
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('skill-pack add and remove reject a linked live skills directory', (t) => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));
    try {
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'),
            path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        const outside = path.join(bundleRoot, 'outside');
        fs.mkdirSync(outside);
        try {
            fs.symlinkSync(outside, path.join(bundleRoot, 'live', 'skills'), 'junction');
        } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code || '')) {
                t.skip(`Junctions unavailable: ${code}`);
                return;
            }
            throw error;
        }

        assert.throws(() => addSkillPack(bundleRoot, 'quality-architecture'), /symlink|junction/);
        assert.deepEqual(fs.readdirSync(outside), []);

        writeInstalledSkillPacks(bundleRoot, ['quality-architecture']);
        const pack = getBuiltinSkillPackDefinition(bundleRoot, 'quality-architecture');
        assert.ok(pack);
        const outsideSkill = path.join(outside, pack.skillDirectories[0]);
        fs.mkdirSync(outsideSkill);
        fs.writeFileSync(path.join(outsideSkill, 'keep.txt'), 'outside');
        assert.throws(() => removeSkillPack(bundleRoot, 'quality-architecture'), /symlink|junction/);
        assert.equal(fs.readFileSync(path.join(outsideSkill, 'keep.txt'), 'utf8'), 'outside');
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('skill-pack add rejects a hard-linked template asset before copying', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));
    try {
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'),
            path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        const pack = getBuiltinSkillPackDefinition(bundleRoot, 'quality-architecture');
        assert.ok(pack);
        const sourceSkill = path.join(bundleRoot, 'template', 'skill-packs',
            'quality-architecture', 'skills', pack.skillDirectories[0], 'SKILL.md');
        const outside = path.join(bundleRoot, 'outside.md');
        fs.writeFileSync(outside, 'outside');
        fs.unlinkSync(sourceSkill);
        fs.linkSync(outside, sourceSkill);

        assert.throws(() => addSkillPack(bundleRoot, 'quality-architecture'), /hard-linked/);
        assert.deepEqual(fs.readdirSync(path.join(bundleRoot, 'live', 'skills')), []);
        assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('suggestSkills recommends packs and skills from index, project stack, task text, and changed paths', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));
    const workspaceRoot = path.join(bundleRoot, 'workspace');

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.mkdirSync(path.join(workspaceRoot, 'src', 'api'), { recursive: true });
        fs.mkdirSync(path.join(workspaceRoot, 'migrations'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{"name":"sample-app"}', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'tsconfig.json'), '{"compilerOptions":{}}', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'src', 'api', 'users.ts'), 'export const users = true;\n', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'migrations', '001_add_users.sql'), 'create table users(id bigint);\n', 'utf8');

        const result = suggestSkills(bundleRoot, workspaceRoot, {
            taskText: 'Fix slow API endpoint and review migration safety',
            changedPaths: ['src/api/users.ts', 'migrations/001_add_users.sql']
        });

        assert.ok(result.suggestedPacks.some((pack) => pack.id === 'node-backend'));
        assert.ok(result.suggestedPacks.some((pack) => pack.id === 'data-database'));
        assert.ok(!result.suggestedPacks.some((pack) => pack.id === 'backend-polyglot'));
        assert.ok(!result.suggestedPacks.some((pack) => pack.id === 'quality-architecture'));

        assert.ok(result.suggestedSkills.some((skill) => skill.id === 'node-backend'));
        assert.ok(result.suggestedSkills.some((skill) => skill.id === 'db-migration-review'));
        assert.ok(result.suggestedSkills.some((skill) => skill.id === 'query-performance'));
        assert.ok(!result.suggestedSkills.some((skill) => skill.id === 'go-http-service'));
        assert.ok(!result.suggestedSkills.some((skill) => skill.id === 'python-service'));
        assert.deepEqual(result.availableRelevantSkills, []);
        assert.ok(fs.existsSync(getSkillsIndexConfigPath(bundleRoot)));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('suggestSkills separates already-available skills from optional additions', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));
    const workspaceRoot = path.join(bundleRoot, 'workspace');

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills', 'frontend-react'), { recursive: true });
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.mkdirSync(path.join(workspaceRoot, 'src', 'components'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{"name":"web-app","dependencies":{"react":"18.0.0"}}', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'src', 'components', 'App.tsx'), 'export function App() { return null; }\n', 'utf8');

        const result = suggestSkills(bundleRoot, workspaceRoot, {
            taskText: 'Improve component accessibility and rendering performance',
            changedPaths: ['src/components/App.tsx']
        });

        assert.ok(result.availableRelevantSkills.some((skill) => skill.id === 'frontend-react'));
        assert.ok(!result.suggestedSkills.some((skill) => skill.id === 'frontend-react'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('suggestSkills treats custom live work skills as available specialist skills', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-custom-suggest-'));
    const workspaceRoot = path.join(bundleRoot, 'workspace');

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);
        writeCustomTelegramSkill(bundleRoot);

        fs.mkdirSync(path.join(workspaceRoot, 'src', 'telegram'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'src', 'telegram', 'client.ts'), 'export const client = true;\n', 'utf8');

        const result = suggestSkills(bundleRoot, workspaceRoot, {
            taskText: 'Fix Telegram TDLight session recovery',
            changedPaths: ['src/telegram/client.ts']
        });

        const customSkill = result.availableRelevantSkills.find((skill) => skill.id === 'telegram-tdlight');
        assert.ok(customSkill, `Expected custom skill in available suggestions: ${JSON.stringify(result.availableRelevantSkills)}`);
        assert.equal(customSkill.source, 'custom_live');
        assert.equal(customSkill.pack, 'custom');
        assert.ok(!result.suggestedSkills.some((skill) => skill.id === 'telegram-tdlight'));
        assert.ok(!result.availableRelevantPacks.some((pack) => pack.id === 'custom'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('skills headlines include baseline, installed optional, and custom live skill summaries', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-headlines-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);
        addSkillPack(bundleRoot, 'node-backend');

        const customSkillRoot = path.join(bundleRoot, 'live', 'skills', 'custom-helper');
        fs.mkdirSync(customSkillRoot, { recursive: true });
        fs.writeFileSync(path.join(customSkillRoot, 'skill.json'), JSON.stringify({
            id: 'custom-helper',
            name: 'Custom Helper',
            summary: 'Local custom helper skill',
            tags: ['custom', 'local'],
            aliases: ['helper'],
            references: [],
            cost_hint: 'low',
            priority: 40,
            autoload: 'never'
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(customSkillRoot, 'SKILL.md'), '# Custom Helper\n', 'utf8');

        const architectureReviewRoot = path.join(bundleRoot, 'live', 'skills', 'architecture-review');
        fs.mkdirSync(architectureReviewRoot, { recursive: true });
        fs.writeFileSync(path.join(architectureReviewRoot, 'skill.json'), JSON.stringify({
            id: 'architecture-review',
            name: 'Architecture Review',
            summary: 'Reviews system design changes for boundary drift and coupling regressions.',
            tags: ['architecture', 'review'],
            aliases: ['arch-review'],
            references: [],
            cost_hint: 'medium',
            priority: 70,
            autoload: 'suggest'
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(architectureReviewRoot, 'SKILL.md'), '# Architecture Review\n', 'utf8');

        const listing = listSkillPacks(bundleRoot);
        assert.ok(listing.customSkillDirectories.includes('custom-helper'));
        assert.ok(listing.customSkillDirectories.includes('architecture-review'));

        const headlines = readSkillsHeadlines(bundleRoot).payload;
        const sourceState = computeCurrentSkillsHeadlinesSourceState(bundleRoot);
        assert.equal(sourceState.sourceStateSha256, headlines.source_state_sha256);
        assert.equal(sourceState.sourceStateHintSha256, headlines.source_state_hint_sha256);
        assert.ok(headlines.skills.some((skill) => skill.id === 'code-review' && skill.source === 'baseline'));
        assert.ok(headlines.skills.some((skill) => skill.id === 'node-backend' && skill.source === 'installed_optional'));
        assert.ok(headlines.skills.some((skill) => skill.id === 'custom-helper' && skill.source === 'custom_live'));
        assert.ok(headlines.skills.some((skill) => skill.id === 'architecture-review' && skill.source === 'custom_live'));
        assert.ok(headlines.skills.some((skill) => skill.id === 'code-review' && skill.review_binding === 'review_bound'));
        assert.ok(headlines.skills.some((skill) => skill.id === 'architecture-review' && skill.review_binding === 'review_bound'));
        assert.ok(headlines.skills.some((skill) => skill.id === 'orchestration' && skill.review_binding === 'general_purpose'));
        assert.ok(headlines.skills.some((skill) => skill.id === 'node-backend' && skill.review_binding === 'general_purpose'));
        assert.ok(headlines.skills.some((skill) => skill.id === 'custom-helper' && skill.review_binding === 'general_purpose'));
        assert.ok(headlines.custom_skill_ids.includes('custom-helper'));
        assert.ok(headlines.custom_skill_ids.includes('architecture-review'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('skills headlines preserve custom directory ids when a live skill manifest is missing', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-headlines-missing-manifest-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills', 'custom-missing-manifest'), { recursive: true });

        const persistedHeadlines = readSkillsHeadlines(bundleRoot).payload;
        assert.ok(persistedHeadlines.custom_skill_ids.includes('custom-missing-manifest'));
        assert.ok(!persistedHeadlines.skills.some((skill) => skill.id === 'custom-missing-manifest'));

        const explicitHashHeadlines = buildSkillsHeadlines(
            bundleRoot,
            '0'.repeat(64),
            '1'.repeat(64)
        );
        assert.ok(explicitHashHeadlines.custom_skill_ids.includes('custom-missing-manifest'));
        assert.ok(!explicitHashHeadlines.skills.some((skill) => skill.id === 'custom-missing-manifest'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('current skills headline source-state hashing does not validate manifest content', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-headlines-incomplete-manifest-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template', 'skill-packs', 'incomplete-pack'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        fs.writeFileSync(path.join(bundleRoot, 'template', 'skill-packs', 'incomplete-pack', 'pack.json'), JSON.stringify({
            id: 'incomplete-pack',
            label: 'Incomplete Pack'
        }, null, 2), 'utf8');

        const state = computeCurrentSkillsHeadlinesSourceState(bundleRoot);
        assert.match(state.sourceStateSha256, /^[a-f0-9]{64}$/);
        assert.match(state.sourceStateHintSha256, /^[a-f0-9]{64}$/);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('computeSkillsHeadlinesSourceStateSha256 changes when manifest content changes even if size and mtime are preserved', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-headlines-state-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);
        addSkillPack(bundleRoot, 'node-backend');

        const manifestPath = path.join(bundleRoot, 'live', 'skills', 'node-backend', 'skill.json');
        const originalText = fs.readFileSync(manifestPath, 'utf8');
        const originalStats = fs.statSync(manifestPath);
        const before = computeSkillsHeadlinesSourceStateSha256(bundleRoot);

        const mutatedText = originalText.replace('a', 'b');
        assert.notEqual(mutatedText, originalText);
        assert.equal(mutatedText.length, originalText.length);
        fs.writeFileSync(manifestPath, mutatedText, 'utf8');
        fs.utimesSync(manifestPath, originalStats.atime, originalStats.mtime);

        const after = computeSkillsHeadlinesSourceStateSha256(bundleRoot);
        assert.notEqual(after, before);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('computeSkillsHeadlinesSourceStateHintSha256 changes when manifest content changes even if size and mtime are preserved', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-headlines-hint-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);
        addSkillPack(bundleRoot, 'node-backend');

        const manifestPath = path.join(bundleRoot, 'live', 'skills', 'node-backend', 'skill.json');
        const originalText = fs.readFileSync(manifestPath, 'utf8');
        const originalStats = fs.statSync(manifestPath);
        const before = computeSkillsHeadlinesSourceStateHintSha256(bundleRoot);

        const mutatedText = originalText.replace('a', 'b');
        assert.notEqual(mutatedText, originalText);
        assert.equal(mutatedText.length, originalText.length);
        fs.writeFileSync(manifestPath, mutatedText, 'utf8');
        fs.utimesSync(manifestPath, originalStats.atime, originalStats.mtime);

        const after = computeSkillsHeadlinesSourceStateHintSha256(bundleRoot);
        assert.notEqual(after, before);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('readSkillsHeadlines refreshes persisted headlines when manifest content changes with the same size and mtime', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-headlines-refresh-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);
        addSkillPack(bundleRoot, 'node-backend');

        const before = readSkillsHeadlines(bundleRoot);
        const manifestPath = path.join(bundleRoot, 'live', 'skills', 'node-backend', 'skill.json');
        const originalText = fs.readFileSync(manifestPath, 'utf8');
        const originalStats = fs.statSync(manifestPath);
        const mutatedText = originalText.replace('delivery', 'shipping');
        assert.notEqual(mutatedText, originalText);
        assert.equal(mutatedText.length, originalText.length);
        fs.writeFileSync(manifestPath, mutatedText, 'utf8');
        fs.utimesSync(manifestPath, originalStats.atime, originalStats.mtime);

        const after = readSkillsHeadlines(bundleRoot);
        const beforeSummary = before.payload.skills.find((skill) => skill.id === 'node-backend')?.summary;
        const afterSummary = after.payload.skills.find((skill) => skill.id === 'node-backend')?.summary;
        assert.notEqual(after.payload.source_state_hint_sha256, before.payload.source_state_hint_sha256);
        assert.notEqual(afterSummary, beforeSummary);
        assert.match(String(afterSummary || ''), /shipping/);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('readSkillsHeadlines refreshes a forged but shape-valid persisted headlines file even when source-state hashes still match', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-headlines-forged-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);
        addSkillPack(bundleRoot, 'node-backend');

        const current = readSkillsHeadlines(bundleRoot);
        const forgedPayload = {
            ...current.payload,
            skills: [
                {
                    id: 'forged-skill',
                    directory: 'forged-skill',
                    name: 'Forged Skill',
                    summary: 'Forged summary that should not survive refresh.',
                    pack: 'node-backend',
                    source: 'installed_optional',
                    implemented: true,
                    review_binding: 'general_purpose',
                    aliases: ['forged'],
                    task_signals: ['request validation'],
                    changed_path_signals: ['src/api/'],
                    tags: ['node']
                }
            ]
        };
        fs.writeFileSync(
            getSkillsHeadlinesConfigPath(bundleRoot),
            JSON.stringify(forgedPayload, null, 2),
            'utf8'
        );

        const refreshed = readSkillsHeadlines(bundleRoot);
        assert.ok(refreshed.payload.skills.some((skill) => skill.id === 'node-backend'));
        assert.ok(!refreshed.payload.skills.some((skill) => skill.id === 'forged-skill'));
        assert.equal(
            fs.readFileSync(getSkillsHeadlinesConfigPath(bundleRoot), 'utf8').includes('forged-skill'),
            false
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('validateSkillPacks reports missing headlines without self-healing them', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-validate-headlines-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
        fs.rmSync(headlinesPath, { force: true });

        const validation = validateSkillPacks(bundleRoot);
        assert.equal(validation.passed, false);
        assert.ok(validation.issues.some((issue) => issue.includes('Skills headlines are missing')));
        assert.equal(fs.existsSync(headlinesPath), false);

        const listing = listSkillPacks(bundleRoot);
        assert.equal(fs.existsSync(headlinesPath), true);
        assert.equal(listing.headlinesPath, headlinesPath);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('skills headlines classify tag-only and special-case review bindings correctly', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-review-binding-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        const taggedAuditRoot = path.join(bundleRoot, 'live', 'skills', 'tagged-audit');
        fs.mkdirSync(taggedAuditRoot, { recursive: true });
        fs.writeFileSync(path.join(taggedAuditRoot, 'skill.json'), JSON.stringify({
            id: 'tagged-audit',
            name: 'Tagged Audit',
            summary: 'Focused correctness audit for change safety.',
            tags: ['quality', 'review'],
            aliases: ['audit'],
            references: [],
            cost_hint: 'low',
            priority: 45,
            autoload: 'suggest'
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(taggedAuditRoot, 'SKILL.md'), '# Tagged Audit\n', 'utf8');

        const testingStrategyRoot = path.join(bundleRoot, 'live', 'skills', 'testing-strategy');
        fs.mkdirSync(testingStrategyRoot, { recursive: true });
        fs.writeFileSync(path.join(testingStrategyRoot, 'skill.json'), JSON.stringify({
            id: 'testing-strategy',
            name: 'Testing Strategy',
            summary: 'Risk-based test planning without reviewer wording in the summary.',
            tags: ['testing', 'quality', 'coverage'],
            aliases: ['test-plan'],
            references: [],
            cost_hint: 'medium',
            priority: 60,
            autoload: 'suggest'
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(testingStrategyRoot, 'SKILL.md'), '# Testing Strategy\n', 'utf8');

        const devopsK8sRoot = path.join(bundleRoot, 'live', 'skills', 'devops-k8s');
        fs.mkdirSync(devopsK8sRoot, { recursive: true });
        fs.writeFileSync(path.join(devopsK8sRoot, 'skill.json'), JSON.stringify({
            id: 'devops-k8s',
            name: 'DevOps K8s',
            summary: 'Container and cluster delivery guidance without reviewer wording in the summary.',
            tags: ['kubernetes', 'docker', 'cicd'],
            aliases: ['k8s'],
            references: [],
            cost_hint: 'medium',
            priority: 60,
            autoload: 'suggest'
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(devopsK8sRoot, 'SKILL.md'), '# DevOps K8s\n', 'utf8');

        const headlines = readSkillsHeadlines(bundleRoot).payload;
        assert.ok(headlines.skills.some((skill) => skill.id === 'tagged-audit' && skill.review_binding === 'review_bound'));
        assert.ok(headlines.skills.some((skill) => skill.id === 'testing-strategy' && skill.review_binding === 'review_bound'));
        assert.ok(headlines.skills.some((skill) => skill.id === 'devops-k8s' && skill.review_binding === 'review_bound'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('validateSkillPacks reports invalid and stale headlines artifacts', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-validate-headlines-shape-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);

        fs.writeFileSync(headlinesPath, '{', 'utf8');
        const invalidValidation = validateSkillPacks(bundleRoot);
        assert.equal(invalidValidation.passed, false);
        assert.ok(invalidValidation.issues.some((issue) => issue.includes('Skills headlines are not valid JSON')));

        writeSkillsIndex(bundleRoot);
        const stalePayload = JSON.parse(fs.readFileSync(headlinesPath, 'utf8'));
        stalePayload.version = Number(stalePayload.version || 0) + 1;
        fs.writeFileSync(headlinesPath, JSON.stringify(stalePayload, null, 2), 'utf8');
        const staleValidation = validateSkillPacks(bundleRoot);
        assert.equal(staleValidation.passed, false);
        assert.ok(staleValidation.issues.some((issue) => issue.includes('Skills headlines are stale')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('readSkillsHeadlinesIfPresent ignores legacy headlines artifacts that do not include directory metadata', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-legacy-headlines-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
        fs.writeFileSync(headlinesPath, JSON.stringify({
            version: 1,
            installed_pack_ids: [],
            baseline_skill_ids: [],
            installed_optional_skill_ids: [],
            custom_skill_ids: [],
            skills: [
                {
                    id: 'legacy-skill',
                    name: 'Legacy Skill',
                    summary: 'Missing directory metadata.',
                    pack: null,
                    source: 'custom_live',
                    implemented: true,
                    review_binding: 'general_purpose',
                    aliases: [],
                    tags: []
                }
            ],
            optional_packs: []
        }, null, 2), 'utf8');

        assert.equal(readSkillsHeadlinesIfPresent(bundleRoot), null);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('readSkillsHeadlinesIfPresent ignores headlines artifacts with malformed optional_packs entries', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-headlines-invalid-packs-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.writeFileSync(
            getSkillsHeadlinesConfigPath(bundleRoot),
            JSON.stringify({
                version: 2,
                installed_pack_ids: [],
                baseline_skill_ids: [],
                installed_optional_skill_ids: [],
                custom_skill_ids: [],
                skills: [],
                optional_packs: [
                    {
                        id: 'node-backend',
                        label: 'Node Backend',
                        description: 'Broken pack entry',
                        installed: false,
                        implemented: true,
                        collides_with_baseline: false,
                        ready_skill_ids: 'node-backend'
                    }
                ]
            }, null, 2),
            'utf8'
        );

        assert.equal(readSkillsHeadlinesIfPresent(bundleRoot), null);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('suggestSkills stays deterministic across repeated identical runs', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));
    const workspaceRoot = path.join(bundleRoot, 'workspace');

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.mkdirSync(path.join(workspaceRoot, 'src', 'api'), { recursive: true });
        fs.mkdirSync(path.join(workspaceRoot, 'migrations'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{"name":"sample-app"}', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'tsconfig.json'), '{"compilerOptions":{}}', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'src', 'api', 'users.ts'), 'export const users = true;\n', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'migrations', '001_add_users.sql'), 'create table users(id bigint);\n', 'utf8');

        let baseline = null;
        for (let iteration = 0; iteration < 20; iteration += 1) {
            const result = suggestSkills(bundleRoot, workspaceRoot, {
                taskText: 'Fix slow API endpoint and review migration safety',
                changedPaths: ['src/api/users.ts', 'migrations/001_add_users.sql']
            });

            const snapshot = JSON.stringify({
                availableRelevantPacks: result.availableRelevantPacks,
                availableRelevantSkills: result.availableRelevantSkills,
                suggestedPacks: result.suggestedPacks,
                suggestedSkills: result.suggestedSkills
            });

            if (baseline === null) {
                baseline = snapshot;
                continue;
            }

            assert.equal(snapshot, baseline);
        }
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('validateSkillPacks rejects optional packs that collide with baseline skills', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template', 'skill-packs', 'security-review', 'skills', 'security-review'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'review-capabilities.json'), getReviewCapabilitiesConfigPath(bundleRoot));

        fs.writeFileSync(path.join(bundleRoot, 'template', 'skill-packs', 'security-review', 'pack.json'), JSON.stringify({
            id: 'security-review',
            label: 'Security Review Pack',
            description: 'Duplicate baseline security pack',
            tags: ['security']
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(bundleRoot, 'template', 'skill-packs', 'security-review', 'skills', 'security-review', 'skill.json'), JSON.stringify({
            id: 'security-review',
            name: 'Security Review',
            pack: 'security-review',
            summary: 'Duplicate baseline skill',
            tags: ['security'],
            aliases: [],
            stack_signals: [],
            task_signals: [],
            changed_path_signals: [],
            references: [],
            cost_hint: 'low',
            priority: 50,
            autoload: 'suggest'
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(bundleRoot, 'template', 'skill-packs', 'security-review', 'skills', 'security-review', 'SKILL.md'), '# Security Review\n', 'utf8');

        writeSkillsIndex(bundleRoot);
        const validation = validateSkillPacks(bundleRoot);

        assert.equal(validation.passed, false);
        assert.ok(validation.issues.some((issue) => issue.includes('collides with baseline skill id')));
        assert.ok(validation.issues.some((issue) => issue.includes('duplicates a baseline skill')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('validateSkillPacks reports missing baseline skill files and README', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.rmSync(path.join(bundleRoot, 'live', 'skills', 'README.md'));
        fs.rmSync(path.join(bundleRoot, 'live', 'skills', 'orchestration', 'skill.json'));

        const validation = validateSkillPacks(bundleRoot);
        assert.equal(validation.passed, false);
        assert.ok(validation.issues.some((issue) => issue.includes('Live skills README is missing')));
        assert.ok(validation.issues.some((issue) => issue.includes("Baseline skill 'orchestration' is missing 'orchestration/skill.json'.")));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});


test('FUZZY_ALIAS_GROUPS is frozen and every group has at least two entries', () => {
    assert.ok(Object.isFrozen(FUZZY_ALIAS_GROUPS));
    assert.ok(FUZZY_ALIAS_GROUPS.length > 0);
    for (const group of FUZZY_ALIAS_GROUPS) {
        assert.ok(group.length >= 2, `Group has fewer than 2 entries: ${JSON.stringify(group)}`);
    }
});

test('getFuzzyAliasMap builds symmetric mappings', () => {
    const map = getFuzzyAliasMap();
    assert.ok(map instanceof Map);
    assert.ok(map.size > 0);

    // k8s ↔ kubernetes
    assert.ok(map.get('k8s')!.includes('kubernetes'));
    assert.ok(map.get('kubernetes')!.includes('k8s'));

    // pg ↔ postgres ↔ postgresql
    assert.ok(map.get('pg')!.includes('postgres'));
    assert.ok(map.get('pg')!.includes('postgresql'));
    assert.ok(map.get('postgresql')!.includes('pg'));

    // js ↔ javascript
    assert.ok(map.get('js')!.includes('javascript'));
    assert.ok(map.get('javascript')!.includes('js'));

    // dotnet ↔ .net ↔ csharp ↔ c#
    assert.ok(map.get('dotnet')!.includes('.net'));
    assert.ok(map.get('dotnet')!.includes('csharp'));
    assert.ok(map.get('c#')!.includes('dotnet'));
});

test('containsAtWordBoundary matches terms at word boundaries only', () => {
    // positive: standalone term
    assert.equal(containsAtWordBoundary('deploy k8s pods', 'k8s'), true);
    assert.equal(containsAtWordBoundary('k8s deployment', 'k8s'), true);
    assert.equal(containsAtWordBoundary('using pg for data', 'pg'), true);
    assert.equal(containsAtWordBoundary('pg', 'pg'), true);

    // positive: term next to punctuation / path separators
    assert.equal(containsAtWordBoundary('file.js module', 'js'), true);
    assert.equal(containsAtWordBoundary('src/k8s/manifests', 'k8s'), true);
    assert.equal(containsAtWordBoundary('use .net framework', '.net'), true);

    // negative: term embedded inside a longer word
    assert.equal(containsAtWordBoundary('upgrade package', 'pg'), false);
    assert.equal(containsAtWordBoundary('flags and banners', 'js'), false);
    assert.equal(containsAtWordBoundary('tsconfig.json', 'ts'), false);
    assert.equal(containsAtWordBoundary('first thing', 'rs'), false);
});

test('getSignalFuzzyVariants returns correct variants for known aliases', () => {
    const variants = getSignalFuzzyVariants('kubernetes');
    assert.ok(variants.includes('k8s'));
    assert.ok(variants.includes('kube'));
    assert.ok(!variants.includes('kubernetes'));

    const pgVariants = getSignalFuzzyVariants('postgresql');
    assert.ok(pgVariants.includes('pg'));
    assert.ok(pgVariants.includes('postgres'));
    assert.ok(pgVariants.includes('pgsql'));

    // path-style signal: k8s/ → kubernetes/
    const pathVariants = getSignalFuzzyVariants('k8s/');
    assert.ok(pathVariants.includes('kubernetes/'));
    assert.ok(pathVariants.includes('kube/'));
});

test('getSignalFuzzyVariants returns empty for unknown terms', () => {
    assert.deepEqual(getSignalFuzzyVariants('somethingcompletelyunknown'), []);
    assert.deepEqual(getSignalFuzzyVariants(''), []);
});

test('getSignalFuzzyVariants does not expand terms embedded inside larger words', () => {
    const variants = getSignalFuzzyVariants('upgrade');
    // "pg" is inside "upgrade" but not at a word boundary
    assert.ok(!variants.some((v) => v.includes('postgres')));
    assert.ok(!variants.some((v) => v.includes('postgresql')));
});

test('textMatchesFuzzyVariant bridges abbreviation ↔ full-name in both directions', () => {
    // text has abbreviation, signal is full name
    assert.equal(textMatchesFuzzyVariant('deploy k8s pods', 'kubernetes'), true);
    assert.equal(textMatchesFuzzyVariant('optimize pg queries', 'postgresql'), true);
    assert.equal(textMatchesFuzzyVariant('vanilla js app', 'javascript'), true);
    assert.equal(textMatchesFuzzyVariant('migrate to dotnet 8', '.net'), true);

    // text has full name, signal is abbreviation
    assert.equal(textMatchesFuzzyVariant('deploy kubernetes pods', 'k8s'), true);
    assert.equal(textMatchesFuzzyVariant('optimize postgresql queries', 'pg'), true);
    assert.equal(textMatchesFuzzyVariant('use javascript modules', 'js'), true);
    assert.equal(textMatchesFuzzyVariant('the .net framework', 'dotnet'), true);
});

test('textMatchesFuzzyVariant rejects false positives for short terms inside longer words', () => {
    assert.equal(textMatchesFuzzyVariant('upgrade package manager', 'postgresql'), false);
    assert.equal(textMatchesFuzzyVariant('flags and banners for display', 'javascript'), false);
    assert.equal(textMatchesFuzzyVariant('first priority item', 'rust'), false);
    assert.equal(textMatchesFuzzyVariant('platform tools', 'terraform'), false);
});

test('fuzzy aliases improve suggestSkills recall for k8s ↔ kubernetes', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-fuzzy-'));
    const workspaceRoot = path.join(bundleRoot, 'workspace');

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.mkdirSync(path.join(workspaceRoot, 'k8s', 'manifests'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'k8s', 'manifests', 'deployment.yaml'), 'apiVersion: apps/v1\n', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'Dockerfile'), 'FROM node:20\n', 'utf8');

        // Task uses "k8s" abbreviation – should match skills with "kubernetes" signals
        const result = suggestSkills(bundleRoot, workspaceRoot, {
            taskText: 'Fix k8s deployment rollout and container health checks',
            changedPaths: ['k8s/manifests/deployment.yaml']
        });

        const allIds = [
            ...result.suggestedSkills.map((s) => s.id),
            ...result.availableRelevantSkills.map((s) => s.id)
        ];
        // devops-k8s pack skill should be matched via alias expansion
        assert.ok(
            allIds.some((id) => id.includes('k8s') || id.includes('devops') || id.includes('infra')),
            `Expected k8s/devops/infra skill in results but got: ${JSON.stringify(allIds)}`
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('fuzzy aliases are deterministic across repeated runs', () => {
    const map1 = getFuzzyAliasMap();
    // Clear the cache to force rebuild
    const map2 = getFuzzyAliasMap();
    assert.deepEqual([...map1.entries()].sort(), [...map2.entries()].sort());

    const variants1 = getSignalFuzzyVariants('postgresql');
    const variants2 = getSignalFuzzyVariants('postgresql');
    assert.deepEqual(variants1, variants2);
});


function makeSuggestion(id: string, pack: string, score: number, matches?: Partial<SignalMatches>) {
    return {
        id,
        name: id,
        pack,
        summary: `${id} summary`,
        score,
        installed: false,
        matches: Object.assign({
            stack_signals: [],
            task_signals: [],
            changed_path_signals: [],
            project_path_signals: [],
            aliases_or_tags: []
        }, matches || {})
    };
}

// -- hasDistinctSignalCoverage ------------------------------------------------

test('hasDistinctSignalCoverage returns false when candidate covers same categories', () => {
    const primary = makeSuggestion('a', 'p', 100, { stack_signals: ['react'] });
    const candidate = makeSuggestion('b', 'p', 80, { stack_signals: ['vue'] });
    assert.equal(hasDistinctSignalCoverage(primary, candidate), false);
});

test('hasDistinctSignalCoverage returns true when candidate has evidence in a new category', () => {
    const primary = makeSuggestion('a', 'p', 100, { stack_signals: ['react'] });
    const candidate = makeSuggestion('b', 'p', 80, { task_signals: ['refactor'] });
    assert.equal(hasDistinctSignalCoverage(primary, candidate), true);
});

test('hasDistinctSignalCoverage returns false when both have empty matches', () => {
    const primary = makeSuggestion('a', 'p', 100);
    const candidate = makeSuggestion('b', 'p', 80);
    assert.equal(hasDistinctSignalCoverage(primary, candidate), false);
});

test('hasDistinctSignalCoverage returns true for changed_path_signals coverage gap', () => {
    const primary = makeSuggestion('a', 'p', 100, { stack_signals: ['node'], task_signals: ['deploy'] });
    const candidate = makeSuggestion('b', 'p', 80, { stack_signals: ['node'], changed_path_signals: ['Dockerfile'] });
    assert.equal(hasDistinctSignalCoverage(primary, candidate), true);
});

test('hasDistinctSignalCoverage handles missing matches object gracefully', () => {
    const primary = { id: 'a', name: 'a', pack: 'p', summary: 'a', score: 100, installed: false, matches: { stack_signals: [], task_signals: [], changed_path_signals: [], project_path_signals: [], aliases_or_tags: [] } } as SkillSuggestion;
    const candidate = makeSuggestion('b', 'p', 80, { task_signals: ['review'] });
    assert.equal(hasDistinctSignalCoverage(primary, candidate), true);
});

// -- dedupeSkillsByPack: multi-match packs ------------------------------------

test('dedupeSkillsByPack collapses redundant same-pack skills', () => {
    const skills = [
        makeSuggestion('skill-a', 'pack-x', 100, { stack_signals: ['react'] }),
        makeSuggestion('skill-b', 'pack-x', 90, { stack_signals: ['react'] }),
        makeSuggestion('skill-c', 'pack-x', 80, { stack_signals: ['react'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 1);
    assert.equal(primary[0].id, 'skill-a');
    assert.equal(collapsed.length, 2);
    assert.deepEqual(collapsed.map((s) => s.id), ['skill-b', 'skill-c']);
});

test('dedupeSkillsByPack preserves cross-pack diversity', () => {
    const skills = [
        makeSuggestion('a1', 'pack-a', 100, { stack_signals: ['react'] }),
        makeSuggestion('b1', 'pack-b', 95, { stack_signals: ['vue'] }),
        makeSuggestion('c1', 'pack-c', 90, { stack_signals: ['angular'] }),
        makeSuggestion('a2', 'pack-a', 85, { stack_signals: ['react'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 3);
    assert.deepEqual(primary.map((s) => s.id), ['a1', 'b1', 'c1']);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].id, 'a2');
});

// -- dedupeSkillsByPack: distinct-signal preservation -------------------------

test('dedupeSkillsByPack keeps same-pack skill with genuinely different signals', () => {
    const skills = [
        makeSuggestion('skill-a', 'pack-x', 100, { stack_signals: ['react'] }),
        makeSuggestion('skill-b', 'pack-x', 80, { task_signals: ['migrate'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 2, 'both skills should stay in primary');
    assert.equal(collapsed.length, 0);
});

test('dedupeSkillsByPack collapses third same-pack skill when first two cover all its categories', () => {
    const skills = [
        makeSuggestion('a', 'pack-x', 100, { stack_signals: ['react'], task_signals: ['lint'] }),
        makeSuggestion('b', 'pack-x', 80, { changed_path_signals: ['src/'] }),
        makeSuggestion('c', 'pack-x', 60, { stack_signals: ['react'], task_signals: ['review'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 2);
    assert.deepEqual(primary.map((s) => s.id), ['a', 'b']);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].id, 'c');
});

// -- dedupeSkillsByPack: tie handling -----------------------------------------

test('dedupeSkillsByPack is deterministic with tied scores (stable input order)', () => {
    const skills = [
        makeSuggestion('alpha', 'pack-x', 100, { stack_signals: ['react'] }),
        makeSuggestion('beta', 'pack-x', 100, { stack_signals: ['react'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 1);
    assert.equal(primary[0].id, 'alpha', 'first in sorted order wins');
    assert.equal(collapsed[0].id, 'beta');
});

test('dedupeSkillsByPack tie with distinct categories keeps both', () => {
    const skills = [
        makeSuggestion('alpha', 'pack-x', 100, { stack_signals: ['node'] }),
        makeSuggestion('beta', 'pack-x', 100, { aliases_or_tags: ['express'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 2, 'both kept because signals differ');
    assert.equal(collapsed.length, 0);
});

// -- dedupeSkillsByPack: edge cases -------------------------------------------

test('dedupeSkillsByPack handles empty input', () => {
    const { primary, collapsed } = dedupeSkillsByPack([]);
    assert.equal(primary.length, 0);
    assert.equal(collapsed.length, 0);
});

test('dedupeSkillsByPack handles single skill', () => {
    const skills = [makeSuggestion('only', 'pack-a', 100, { stack_signals: ['go'] })];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 1);
    assert.equal(primary[0].id, 'only');
    assert.equal(collapsed.length, 0);
});

test('dedupeSkillsByPack does not collapse skills from different packs with same signals', () => {
    const skills = [
        makeSuggestion('a', 'pack-a', 100, { stack_signals: ['react'] }),
        makeSuggestion('b', 'pack-b', 95, { stack_signals: ['react'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 2);
    assert.equal(collapsed.length, 0);
});

// -- MATCH_CATEGORIES integrity -----------------------------------------------

test('MATCH_CATEGORIES contains the expected signal categories', () => {
    assert.deepEqual([...MATCH_CATEGORIES], [
        'stack_signals', 'task_signals', 'changed_path_signals',
        'project_path_signals', 'aliases_or_tags'
    ]);
});

// -- Barrel re-export: skill-telemetry ----------------------------------------

test('barrel re-exports SKILL_TELEMETRY_EVENT_TYPES from skill-telemetry', () => {
    assert.ok(SKILL_TELEMETRY_EVENT_TYPES);
    assert.equal(SKILL_TELEMETRY_EVENT_TYPES.SKILL_SUGGESTED, 'SKILL_SUGGESTED');
    assert.equal(SKILL_TELEMETRY_EVENT_TYPES.SKILL_SELECTED, 'SKILL_SELECTED');
    assert.equal(SKILL_TELEMETRY_EVENT_TYPES.SKILL_REFERENCE_LOADED, 'SKILL_REFERENCE_LOADED');
});

test('barrel re-exports SKILL_TELEMETRY_ACTOR from skill-telemetry', () => {
    assert.equal(SKILL_TELEMETRY_ACTOR, 'skill-telemetry');
});

test('barrel re-exports buildSkillTelemetryDetails from skill-telemetry', () => {
    assert.equal(typeof buildSkillTelemetryDetails, 'function');
    const details = buildSkillTelemetryDetails({});
    assert.equal(details.telemetry_type, 'skill_activation');
    assert.equal(details.skill_id, null);
});

test('barrel re-exports emitSkillTelemetryEvent from skill-telemetry', () => {
    assert.equal(typeof emitSkillTelemetryEvent, 'function');
    const result = emitSkillTelemetryEvent(null, null, 'SKILL_SUGGESTED', 'msg');
    assert.equal(result, null);
});

test('barrel re-exports emitSkillTelemetryEventAsync from skill-telemetry', async () => {
    assert.equal(typeof emitSkillTelemetryEventAsync, 'function');
    assert.equal(emitSkillTelemetryEventAsync, directEmitSkillTelemetryEventAsync);
    const result = await emitSkillTelemetryEventAsync(null, null, 'SKILL_SUGGESTED', 'msg');
    assert.equal(result, null);
});

test('barrel re-exports emitSkillSuggestedEvent from skill-telemetry', () => {
    assert.equal(typeof emitSkillSuggestedEvent, 'function');
    const result = emitSkillSuggestedEvent(null, null, null);
    assert.equal(result, null);
});

test('barrel re-exports emitSkillSelectedEvent from skill-telemetry', () => {
    assert.equal(typeof emitSkillSelectedEvent, 'function');
    const result = emitSkillSelectedEvent(null, null, 'test-skill');
    assert.equal(result, null);
});

test('barrel re-exports emitSkillSelectedEventAsync from skill-telemetry', async () => {
    assert.equal(typeof emitSkillSelectedEventAsync, 'function');
    assert.equal(emitSkillSelectedEventAsync, directEmitSkillSelectedEventAsync);
    const result = await emitSkillSelectedEventAsync(null, null, 'test-skill');
    assert.equal(result, null);
});

test('barrel re-exports emitSkillReferenceLoadedEvent from skill-telemetry', () => {
    assert.equal(typeof emitSkillReferenceLoadedEvent, 'function');
    const result = emitSkillReferenceLoadedEvent(null, null, 'ref.md');
    assert.equal(result, null);
});

test('barrel re-exports emitSkillReferenceLoadedEventAsync from skill-telemetry', async () => {
    assert.equal(typeof emitSkillReferenceLoadedEventAsync, 'function');
    assert.equal(emitSkillReferenceLoadedEventAsync, directEmitSkillReferenceLoadedEventAsync);
    const result = await emitSkillReferenceLoadedEventAsync(null, null, 'ref.md');
    assert.equal(result, null);
});
