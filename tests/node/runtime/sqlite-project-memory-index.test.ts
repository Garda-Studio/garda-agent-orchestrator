import test from 'node:test';
import assert from 'node:assert/strict';
import mutableFs from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PROJECT_MEMORY_FILE_DEFINITIONS } from '../../../src/core/project-memory';
import {
    type DerivedSqliteCatalog,
    openDerivedSqliteCatalog,
    openDerivedSqliteCatalogReadOnly,
    probeSqliteCatalogCapability,
    resolveDerivedSqliteCatalogPath
} from '../../../src/runtime/sqlite-catalog';

const INDEXED_AT_UTC = '2026-08-04T10:00:00.000Z';
const LOAD_TEST_SOURCE_BYTES = 768 * 1024;
const LOAD_TEST_REFRESH_BUDGET_MS = 20_000;
const SQLITE_CATALOG_CAPABILITY = probeSqliteCatalogCapability();
const sqliteCatalogTest = SQLITE_CATALOG_CAPABILITY.available ? test : test.skip;

function createWorkspace(prefix: string): string {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.writeFileSync(path.join(workspaceRoot, 'MANIFEST.md'), '# Test bundle\n', 'utf8');
    fs.writeFileSync(path.join(workspaceRoot, 'VERSION'), '1.2.0-test\n', 'utf8');
    fs.mkdirSync(path.join(workspaceRoot, 'runtime'), { recursive: true });
    const memoryRoot = path.join(workspaceRoot, 'live', 'docs', 'project-memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    for (const definition of PROJECT_MEMORY_FILE_DEFINITIONS) {
        let content = `# ${definition.fileName}\n\nCanonical ${definition.purpose}\n`;
        if (definition.fileName === 'README.md') {
            content += '\nSee [architecture](architecture.md) for durable boundaries.\n';
        }
        if (definition.fileName === 'architecture.md') {
            content += [
                '\n## Catalog boundary',
                '',
                'The bounded orchestration catalog is derived and deterministic.',
                'API_TOKEN=fixture-sensitive-value',
                '',
                '```md',
                '[example-only link](README.md)',
                '```',
                '',
                '````md',
                '```',
                '[long-fence-example-only link](README.md)',
                '```',
                '````',
                '',
                '## Heading-only terminus',
                ''
            ].join('\n');
        }
        fs.writeFileSync(path.join(memoryRoot, definition.fileName), content, 'utf8');
    }
    return workspaceRoot;
}

function removeWorkspace(workspaceRoot: string): void {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

function requireCatalog(workspaceRoot: string): DerivedSqliteCatalog {
    const opened = openDerivedSqliteCatalog(workspaceRoot, {
        appVersion: '1.2.0-test',
        clock: () => INDEXED_AT_UTC
    });
    if (opened.status !== 'available') {
        assert.fail(`Expected available catalog, got ${opened.reason}: ${opened.diagnostic}`);
    }
    return opened.catalog;
}

sqliteCatalogTest('project-memory refresh authenticates missing Windows source device identities', () => {
    const workspaceRoot = createWorkspace('garda-project-memory-missing-device-');
    const memoryRoot = path.join(workspaceRoot, 'live', 'docs', 'project-memory');
    const statFs = mutableFs as { -readonly [Key in keyof typeof fs]: typeof fs[Key] };
    const original = statFs.lstatSync;
    const originalOpen = statFs.openSync;
    const originalClose = statFs.closeSync;
    const originalRead = statFs.readSync;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const catalog = requireCatalog(workspaceRoot);
    statFs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
        const stat = Reflect.apply(original, statFs, args);
        return stat?.isFile() && String(args[0]).startsWith(memoryRoot)
            ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: 0 }) : stat;
    }) as typeof fs.lstatSync;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
        const result = catalog.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC });
        assert.equal(result.outcome, 'applied');
        assert.equal(result.status, 'ready');
        assert.equal(result.sourceCount, PROJECT_MEMORY_FILE_DEFINITIONS.length);

        const sourceDescriptors = new Set<number>();
        let sourcePayloadReads = 0;
        statFs.openSync = (filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null): number => {
            const descriptor = mode === undefined
                ? originalOpen(filePath, flags) : originalOpen(filePath, flags, mode);
            if (path.dirname(path.resolve(String(filePath))) === path.resolve(memoryRoot)) {
                sourceDescriptors.add(descriptor);
            }
            return descriptor;
        };
        statFs.closeSync = (descriptor: number): void => {
            sourceDescriptors.delete(descriptor);
            originalClose(descriptor);
        };
        statFs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
            if (sourceDescriptors.has(args[0])) sourcePayloadReads += 1;
            return Reflect.apply(originalRead, statFs, args);
        }) as typeof fs.readSync;

        const firstSearch = catalog.searchProjectMemory('bounded deterministic');
        const secondSearch = catalog.searchProjectMemory('bounded deterministic');
        assert.equal(firstSearch.status, 'ready');
        assert.equal(firstSearch.hits[0]?.sourcePath, 'live/docs/project-memory/architecture.md');
        assert.deepEqual(secondSearch, firstSearch);
        const sourcePath = 'live/docs/project-memory/README.md';
        const firstRelationships = catalog.queryProjectMemoryRelationships(sourcePath);
        assert.equal(firstRelationships.status, 'ready');
        assert.ok(firstRelationships.relationships.some((relationship) => (
            relationship.kind === 'links_to'
            && relationship.targetSourcePath === 'live/docs/project-memory/architecture.md'
        )));
        assert.deepEqual(catalog.queryProjectMemoryRelationships(sourcePath), firstRelationships);
        assert.equal(sourcePayloadReads, 0, 'ready queries must reuse the cache without rereading source payloads');
        assert.equal(sourceDescriptors.size, 0, 'query identity descriptors must be closed');

        fs.appendFileSync(path.join(memoryRoot, 'architecture.md'), '\nChanged source invalidates the cache.\n');
        const staleSearch = catalog.searchProjectMemory('bounded deterministic');
        assert.equal(staleSearch.status, 'stale');
        assert.deepEqual(staleSearch.hits, []);
        assert.deepEqual(staleSearch.changedSources, ['live/docs/project-memory/architecture.md']);
        assert.equal(catalog.queryProjectMemoryRelationships(sourcePath).status, 'stale');
        assert.ok(sourcePayloadReads > 0, 'changed source fingerprints must trigger payload validation');
        assert.equal(sourceDescriptors.size, 0);

        assert.equal(catalog.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC }).status, 'ready');
        sourcePayloadReads = 0;
        assert.equal(catalog.searchProjectMemory('bounded deterministic').status, 'ready');
        assert.equal(catalog.queryProjectMemoryRelationships(sourcePath).status, 'ready');
        assert.equal(sourcePayloadReads, 0, 'explicit refresh must restore ready-cache reuse');
        assert.equal(sourceDescriptors.size, 0);
    } finally {
        statFs.lstatSync = original;
        statFs.openSync = originalOpen;
        statFs.closeSync = originalClose;
        statFs.readSync = originalRead;
        Object.defineProperty(process, 'platform', platform);
        catalog.close();
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('bounded multi-megabyte project-memory refresh stays within the runtime latency budget', {
    timeout: LOAD_TEST_REFRESH_BUDGET_MS + 10_000
}, () => {
    const workspaceRoot = createWorkspace('garda-project-memory-load-');
    const memoryRoot = path.join(workspaceRoot, 'live', 'docs', 'project-memory');
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        let workloadBytes = 0;
        for (const definition of PROJECT_MEMORY_FILE_DEFINITIONS) {
            const header = `# ${definition.fileName}\n\n## Load boundary\n\n`;
            const payloadLine = 'bounded refresh measurement payload\n';
            const repeats = Math.ceil(
                (LOAD_TEST_SOURCE_BYTES - Buffer.byteLength(header))
                / Buffer.byteLength(payloadLine)
            );
            const content = `${header}${payloadLine.repeat(repeats)}`.slice(
                0,
                LOAD_TEST_SOURCE_BYTES
            );
            workloadBytes += Buffer.byteLength(content);
            fs.writeFileSync(path.join(memoryRoot, definition.fileName), content, 'utf8');
        }
        assert.ok(workloadBytes >= 7 * 1024 * 1024);

        catalog = requireCatalog(workspaceRoot);
        const startedAt = process.hrtime.bigint();
        const refreshed = catalog.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC });
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

        assert.equal(refreshed.outcome, 'applied');
        assert.equal(refreshed.status, 'ready');
        assert.equal(refreshed.sourceCount, PROJECT_MEMORY_FILE_DEFINITIONS.length);
        assert.ok(
            elapsedMs < LOAD_TEST_REFRESH_BUDGET_MS,
            `Expected ${workloadBytes} byte refresh below ${LOAD_TEST_REFRESH_BUDGET_MS}ms, got ${elapsedMs.toFixed(1)}ms`
        );
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('project-memory refresh rejects an approved source above the per-file size limit', () => {
    const workspaceRoot = createWorkspace('garda-project-memory-oversized-');
    const oversizedSourcePath = 'live/docs/project-memory/architecture.md';
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        fs.writeFileSync(path.join(workspaceRoot, oversizedSourcePath), Buffer.alloc((1024 * 1024) + 1, 0x61));
        catalog = requireCatalog(workspaceRoot);

        const refreshed = catalog.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC });

        assert.equal(refreshed.outcome, 'deferred');
        assert.equal(refreshed.status, 'unavailable');
        assert.deepEqual(refreshed.changedSources, [oversizedSourcePath]);
        assert.match(refreshed.diagnostic, /exceeds 1048576 bytes/u);
        assert.equal(catalog.inspectProjectMemoryIndex().status, 'unavailable');
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

for (const boundary of [
    {
        name: 'section',
        content: Array.from({ length: 129 }, (_, index) => `## Section ${index}`).join('\n'),
        diagnostic: /exceeds 128 sections/u
    },
    {
        name: 'approved-link',
        content: `# Links\n\n${'[target](README.md)\n'.repeat(257)}`,
        diagnostic: /exceeds 256 approved links/u
    }
]) {
    sqliteCatalogTest(`project-memory refresh rejects an approved source above the ${boundary.name} limit`, () => {
        const workspaceRoot = createWorkspace(`garda-project-memory-${boundary.name}-overflow-`);
        const sourcePath = 'live/docs/project-memory/architecture.md';
        let catalog: DerivedSqliteCatalog | null = null;
        try {
            fs.writeFileSync(path.join(workspaceRoot, sourcePath), boundary.content, 'utf8');
            catalog = requireCatalog(workspaceRoot);
            const refreshed = catalog.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC });
            assert.equal(refreshed.outcome, 'deferred');
            assert.equal(refreshed.status, 'unavailable');
            assert.deepEqual(refreshed.changedSources, [sourcePath]);
            assert.match(refreshed.diagnostic, boundary.diagnostic);
        } finally {
            catalog?.close();
            removeWorkspace(workspaceRoot);
        }
    });
}

sqliteCatalogTest('project-memory search enforces query token, character, and result limits', () => {
    const workspaceRoot = createWorkspace('garda-project-memory-query-bounds-');
    const memoryRoot = path.join(workspaceRoot, 'live', 'docs', 'project-memory');
    const tokenMarker = Array.from({ length: 12 }, (_, index) => `querytoken${index}`).join(' ');
    const characterMarker = 'q'.repeat(256);
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        for (const definition of PROJECT_MEMORY_FILE_DEFINITIONS) {
            const sections = Array.from({ length: 6 }, (_, index) => (
                `## Boundary ${index}\nlimit-marker${index === 0 && definition.fileName === 'architecture.md'
                    ? ` ${tokenMarker} ${characterMarker}`
                    : ''}`
            )).join('\n\n');
            fs.writeFileSync(path.join(memoryRoot, definition.fileName), `# ${definition.fileName}\n\n${sections}\n`, 'utf8');
        }
        catalog = requireCatalog(workspaceRoot);
        assert.equal(catalog.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC }).status, 'ready');
        assert.equal(catalog.searchProjectMemory(`${tokenMarker} omitted-thirteenth`).hits.length, 1);
        assert.equal(catalog.searchProjectMemory(`${characterMarker} omitted-after-character-limit`).hits.length, 1);
        assert.equal(catalog.searchProjectMemory('limit-marker', { limit: 999 }).hits.length, 50);
        assert.equal(catalog.searchProjectMemory('limit-marker', { limit: 0 }).hits.length, 1);
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('project-memory refresh indexes only approved Markdown with redacted FTS content and bounded relationships', (context) => {
    const workspaceRoot = createWorkspace('garda-project-memory-index-');
    const memoryRoot = path.join(workspaceRoot, 'live', 'docs', 'project-memory');
    fs.writeFileSync(path.join(memoryRoot, 'unapproved.md'), '# Unapproved\nforbidden-index-marker\n', 'utf8');
    fs.mkdirSync(path.join(workspaceRoot, 'runtime', 'project-memory'), { recursive: true });
    fs.writeFileSync(
        path.join(workspaceRoot, 'runtime', 'project-memory', 'T-999-evidence.md'),
        '# Transient evidence\ntransient-index-marker\n',
        'utf8'
    );
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        assert.equal(catalog.inspectProjectMemoryIndex().status, 'empty');

        const refreshed = catalog.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC });
        assert.equal(refreshed.outcome, 'applied');
        assert.equal(refreshed.status, 'ready');
        assert.equal(refreshed.sourceCount, PROJECT_MEMORY_FILE_DEFINITIONS.length);
        assert.ok(refreshed.entityCount > refreshed.sourceCount);
        assert.ok(refreshed.relationshipCount >= refreshed.entityCount - refreshed.sourceCount + 1);

        const originalOpenSync = mutableFs.openSync;
        let approvedSourceOpens = 0;
        context.mock.method(mutableFs, 'openSync', (
            filePath: fs.PathLike,
            flags: fs.OpenMode,
            mode?: fs.Mode
        ): number => {
            if (
                path.dirname(path.resolve(String(filePath))) === path.resolve(memoryRoot)
                && PROJECT_MEMORY_FILE_DEFINITIONS.some((definition) => (
                    definition.fileName === path.basename(String(filePath))
                ))
            ) {
                approvedSourceOpens += 1;
            }
            return mode === undefined
                ? originalOpenSync(filePath, flags)
                : originalOpenSync(filePath, flags, mode);
        });

        const firstSearch = catalog.searchProjectMemory('bounded deterministic');
        const secondSearch = catalog.searchProjectMemory('bounded deterministic');
        assert.equal(firstSearch.status, 'ready');
        assert.deepEqual(secondSearch, firstSearch);
        assert.equal(firstSearch.hits[0]?.sourcePath, 'live/docs/project-memory/architecture.md');
        assert.equal(firstSearch.hits[0]?.heading, 'Catalog boundary');
        const headingOnlySearch = catalog.searchProjectMemory('heading-only terminus');
        assert.equal(headingOnlySearch.status, 'ready');
        assert.equal(headingOnlySearch.hits[0]?.heading, 'Heading-only terminus');
        assert.equal(catalog.searchProjectMemory('fixture-sensitive-value').hits.length, 0);
        assert.equal(catalog.searchProjectMemory('forbidden-index-marker').hits.length, 0);
        assert.equal(catalog.searchProjectMemory('transient-index-marker').hits.length, 0);
        assert.equal(catalog.searchProjectMemory('---').status, 'invalid_query');

        const relationships = catalog.queryProjectMemoryRelationships(
            'live/docs/project-memory/README.md'
        );
        assert.equal(relationships.status, 'ready');
        assert.ok(relationships.relationships.some((relationship) => (
            relationship.kind === 'links_to'
            && relationship.targetSourcePath === 'live/docs/project-memory/architecture.md'
        )));
        const architectureRelationships = catalog.queryProjectMemoryRelationships(
            'live/docs/project-memory/architecture.md'
        );
        assert.ok(!architectureRelationships.relationships.some((relationship) => (
            relationship.kind === 'links_to'
            && relationship.targetSourcePath === 'live/docs/project-memory/README.md'
        )));
        assert.equal(approvedSourceOpens, 0);

        const current = catalog.refreshProjectMemoryIndex({ clock: () => '2026-08-04T11:00:00.000Z' });
        assert.equal(current.outcome, 'current');
        assert.equal(current.indexedAtUtc, INDEXED_AT_UTC);
        catalog.close();
        catalog = null;

        const database = new DatabaseSync(resolveDerivedSqliteCatalogPath(workspaceRoot), { readOnly: true });
        try {
            const indexedBodies = database.prepare('SELECT body FROM project_memory_fts').all()
                .map((row) => String((row as Record<string, unknown>).body))
                .join('\n');
            assert.ok(!indexedBodies.includes('fixture-sensitive-value'));
            assert.ok(indexedBodies.includes('<redacted>'));
            const redacted = database.prepare(`
                SELECT redaction_applied FROM project_memory_documents WHERE file_name = 'architecture.md'
            `).get() as Record<string, unknown> | undefined;
            assert.equal(Number(redacted?.redaction_applied), 1);
        } finally {
            database.close();
        }
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('project-memory refresh stays bound to the catalog workspace when unknown options name another root', () => {
    const workspaceRoot = createWorkspace('garda-project-memory-bound-root-');
    const foreignRoot = createWorkspace('garda-project-memory-foreign-root-');
    fs.appendFileSync(
        path.join(foreignRoot, 'live', 'docs', 'project-memory', 'architecture.md'),
        '\nforeign-workspace-only-marker\n',
        'utf8'
    );
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        const untrustedOptions = {
            sourceRepoRoot: foreignRoot,
            clock: () => INDEXED_AT_UTC
        };
        const refreshed = catalog.refreshProjectMemoryIndex(untrustedOptions);
        assert.equal(refreshed.status, 'ready');
        assert.equal(catalog.searchProjectMemory('foreign-workspace-only-marker').hits.length, 0);
        assert.ok(catalog.searchProjectMemory('bounded orchestration').hits.length > 0);
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
        removeWorkspace(foreignRoot);
    }
});

sqliteCatalogTest('project-memory refresh rejects a pathname replacement after opening the approved source', (context) => {
    const workspaceRoot = createWorkspace('garda-project-memory-replaced-source-');
    const architecturePath = path.join(
        workspaceRoot,
        'live',
        'docs',
        'project-memory',
        'architecture.md'
    );
    const replacementPath = path.join(workspaceRoot, 'replacement.md');
    fs.writeFileSync(replacementPath, '# Replacement\nreplacement-only-marker\n', 'utf8');
    const replacementStat = fs.lstatSync(replacementPath);
    const originalOpenSync = mutableFs.openSync;
    const originalLstatSync = mutableFs.lstatSync;
    let architectureOpened = false;
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        context.mock.method(mutableFs, 'openSync', (
            filePath: fs.PathLike,
            flags: fs.OpenMode,
            mode?: fs.Mode
        ): number => {
            const fileDescriptor = mode === undefined
                ? originalOpenSync(filePath, flags)
                : originalOpenSync(filePath, flags, mode);
            if (path.resolve(String(filePath)) === path.resolve(architecturePath)) {
                architectureOpened = true;
            }
            return fileDescriptor;
        });
        context.mock.method(mutableFs, 'lstatSync', (filePath: fs.PathLike): fs.Stats => {
            if (
                architectureOpened
                && path.resolve(String(filePath)) === path.resolve(architecturePath)
            ) {
                return replacementStat;
            }
            return originalLstatSync(filePath);
        });

        const refreshed = catalog.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC });
        assert.equal(architectureOpened, true);
        assert.equal(refreshed.outcome, 'deferred');
        assert.equal(refreshed.status, 'unavailable');
        assert.deepEqual(refreshed.changedSources, ['live/docs/project-memory/architecture.md']);
        assert.match(refreshed.diagnostic, /changed while being opened/u);
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('project-memory refresh rejects a symlink or junction in the canonical directory path', (context) => {
    const workspaceRoot = createWorkspace('garda-project-memory-linked-root-');
    const memoryRoot = path.join(workspaceRoot, 'live', 'docs', 'project-memory');
    const redirectedRoot = path.join(workspaceRoot, 'runtime', 'redirected-project-memory');
    fs.cpSync(memoryRoot, redirectedRoot, { recursive: true });
    fs.rmSync(memoryRoot, { recursive: true });
    try {
        fs.symlinkSync(redirectedRoot, memoryRoot, 'junction');
    } catch (error: unknown) {
        context.skip(`Directory links are unavailable: ${error instanceof Error ? error.message : String(error)}`);
        removeWorkspace(workspaceRoot);
        return;
    }
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        const refreshed = catalog.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC });
        assert.equal(refreshed.outcome, 'deferred');
        assert.equal(refreshed.status, 'unavailable');
        assert.deepEqual(refreshed.changedSources, ['live/docs/project-memory']);
        assert.match(refreshed.diagnostic, /must not contain symlink or junction components/u);
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('project-memory search fails closed on stale source hashes until an explicit refresh', () => {
    const workspaceRoot = createWorkspace('garda-project-memory-stale-');
    const architecturePath = path.join(
        workspaceRoot,
        'live',
        'docs',
        'project-memory',
        'architecture.md'
    );
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        assert.equal(catalog.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC }).outcome, 'applied');
        const original = fs.readFileSync(architecturePath, 'utf8');
        fs.writeFileSync(architecturePath, `${original}\nFresh canonical topology marker.\n`, 'utf8');

        const staleSearch = catalog.searchProjectMemory('bounded');
        assert.equal(staleSearch.status, 'stale');
        assert.deepEqual(staleSearch.hits, []);
        assert.deepEqual(staleSearch.changedSources, ['live/docs/project-memory/architecture.md']);

        const refreshed = catalog.refreshProjectMemoryIndex({
            clock: () => '2026-08-04T12:00:00.000Z'
        });
        assert.equal(refreshed.outcome, 'applied');
        const freshSearch = catalog.searchProjectMemory('topology marker');
        assert.equal(freshSearch.status, 'ready');
        assert.equal(freshSearch.hits[0]?.sourcePath, 'live/docs/project-memory/architecture.md');
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('project-memory search fails closed when persisted FTS content drifts without changing row counts', () => {
    const workspaceRoot = createWorkspace('garda-project-memory-fts-drift-');
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        assert.equal(catalog.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC }).outcome, 'applied');
        assert.equal(catalog.searchProjectMemory('canonical').status, 'ready');

        const database = new DatabaseSync(resolveDerivedSqliteCatalogPath(workspaceRoot));
        try {
            database.prepare(`
                UPDATE project_memory_fts
                SET body = 'tampered-index-only-marker'
                WHERE entity_id = (
                    SELECT entity_id FROM project_memory_fts ORDER BY entity_id LIMIT 1
                )
            `).run();
        } finally {
            database.close();
        }

        const search = catalog.searchProjectMemory('tampered-index-only-marker');
        assert.equal(search.status, 'stale');
        assert.deepEqual(search.hits, []);
        assert.equal(catalog.inspectProjectMemoryIndex().status, 'stale');
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('project-memory refresh does not report ready when canonical sources change during refresh', (context) => {
    const workspaceRoot = createWorkspace('garda-project-memory-refresh-race-');
    const architecturePath = path.join(
        workspaceRoot,
        'live',
        'docs',
        'project-memory',
        'architecture.md'
    );
    const originalOpenSync = mutableFs.openSync;
    let architectureOpenCount = 0;
    let mutating = false;
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        context.mock.method(mutableFs, 'openSync', (
            filePath: fs.PathLike,
            flags: fs.OpenMode,
            mode?: fs.Mode
        ): number => {
            if (
                !mutating
                && path.resolve(String(filePath)) === path.resolve(architecturePath)
            ) {
                architectureOpenCount += 1;
                if (architectureOpenCount === 2) {
                    mutating = true;
                    try {
                        fs.appendFileSync(architecturePath, '\nchanged-during-refresh-marker\n', 'utf8');
                    } finally {
                        mutating = false;
                    }
                }
            }
            return mode === undefined
                ? originalOpenSync(filePath, flags)
                : originalOpenSync(filePath, flags, mode);
        });

        const refreshed = catalog.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC });
        assert.equal(architectureOpenCount >= 2, true);
        assert.equal(refreshed.outcome, 'deferred');
        assert.equal(refreshed.status, 'stale');
        assert.deepEqual(refreshed.changedSources, ['live/docs/project-memory/architecture.md']);
        assert.match(refreshed.diagnostic, /changed while the index refresh was in progress/u);
        assert.equal(catalog.searchProjectMemory('changed-during-refresh-marker').status, 'stale');
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('read-only project-memory queries preserve stale diagnostics and reject index mutation', () => {
    const workspaceRoot = createWorkspace('garda-project-memory-read-only-');
    try {
        const writable = requireCatalog(workspaceRoot);
        assert.equal(writable.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC }).outcome, 'applied');
        writable.close();

        const opened = openDerivedSqliteCatalogReadOnly(workspaceRoot);
        if (opened.status !== 'available') {
            assert.fail(`Expected read-only catalog, got ${opened.reason}: ${opened.diagnostic}`);
        }
        try {
            assert.equal(opened.catalog.searchProjectMemory('canonical').status, 'ready');
            assert.throws(
                () => opened.catalog.refreshProjectMemoryIndex(),
                /read-only/u
            );
        } finally {
            opened.catalog.close();
        }
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

sqliteCatalogTest('project-memory refresh reports missing approved files without replacing a healthy index', () => {
    const workspaceRoot = createWorkspace('garda-project-memory-missing-');
    const missingPath = path.join(workspaceRoot, 'live', 'docs', 'project-memory', 'risks.md');
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        const first = catalog.refreshProjectMemoryIndex({ clock: () => INDEXED_AT_UTC });
        assert.equal(first.status, 'ready');
        fs.rmSync(missingPath);

        const deferred = catalog.refreshProjectMemoryIndex({
            clock: () => '2026-08-04T13:00:00.000Z'
        });
        assert.equal(deferred.outcome, 'deferred');
        assert.equal(deferred.status, 'unavailable');
        assert.deepEqual(deferred.changedSources, ['live/docs/project-memory/risks.md']);

        const database = new DatabaseSync(resolveDerivedSqliteCatalogPath(workspaceRoot), { readOnly: true });
        try {
            const state = database.prepare(`
                SELECT snapshot_sha256, indexed_at_utc, source_count
                FROM project_memory_index_state WHERE singleton_id = 1
            `).get() as Record<string, unknown>;
            assert.equal(state.snapshot_sha256, first.snapshotSha256);
            assert.equal(state.indexed_at_utc, INDEXED_AT_UTC);
            assert.equal(Number(state.source_count), PROJECT_MEMORY_FILE_DEFINITIONS.length);
        } finally {
            database.close();
        }
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});
