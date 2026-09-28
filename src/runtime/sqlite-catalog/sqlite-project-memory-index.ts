import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { lstatFileIdentitySync } from '../../core/file-stat';
import { isPathRealpathInsideRoot } from '../../core/paths';
import {
    PROJECT_MEMORY_FILE_DEFINITIONS,
    PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH,
    normalizeProjectMemoryMarkdown,
    sha256Hex,
    stripProjectMemoryHtmlComments,
    type ProjectMemoryReadRole
} from '../../core/project-memory';
import { redactSecretText } from '../../core/redaction';
import type {
    ProjectMemoryIndexInspection,
    ProjectMemoryIndexRefreshResult,
    ProjectMemoryRelationshipResult,
    ProjectMemorySearchOptions,
    ProjectMemorySearchResult
} from './sqlite-catalog-contracts';
import type { CatalogDatabase } from './sqlite-catalog-driver';

const MAX_PROJECT_MEMORY_FILE_BYTES = 1_048_576;
const MAX_PROJECT_MEMORY_SECTIONS_PER_DOCUMENT = 128;
const MAX_PROJECT_MEMORY_LINKS_PER_DOCUMENT = 256;
const MAX_PROJECT_MEMORY_QUERY_CHARS = 256;
const MAX_PROJECT_MEMORY_QUERY_TOKENS = 12;
const DEFAULT_PROJECT_MEMORY_SEARCH_LIMIT = 20;
const MAX_PROJECT_MEMORY_SEARCH_LIMIT = 50;

interface MemoryLine {
    readonly line: number;
    readonly text: string;
    readonly relationshipEligible: boolean;
}

interface MemorySection {
    readonly entityId: string;
    readonly heading: string;
    readonly sourceLine: number;
    readonly ordinal: number;
    readonly body: string;
    readonly lines: readonly MemoryLine[];
}

interface MemoryDocument {
    readonly documentId: string;
    readonly documentEntityId: string;
    readonly fileName: string;
    readonly sourcePath: string;
    readonly readRole: ProjectMemoryReadRole;
    readonly title: string;
    readonly contentSha256: string;
    readonly indexedContentSha256: string;
    readonly sourceFingerprint: string;
    readonly redactionApplied: boolean;
    readonly sections: readonly MemorySection[];
}

interface MemoryRelationship {
    readonly relationshipId: string;
    readonly sourceEntityId: string;
    readonly targetEntityId: string;
    readonly kind: 'contains' | 'links_to';
    readonly sourcePath: string;
    readonly sourceLine: number;
}

interface MemorySnapshot {
    readonly repoRoot: string;
    readonly snapshotSha256: string;
    readonly documents: readonly MemoryDocument[];
    readonly relationships: readonly MemoryRelationship[];
}

interface SafeMemoryRead {
    readonly content: Buffer;
    readonly sourceFingerprint: string;
}

interface ReadyIndexCacheEntry {
    readonly repoRoot: string;
    readonly stateKey: string;
    readonly dataVersion: number;
    readonly sourceFingerprintsKey: string;
    readonly inspection: ProjectMemoryIndexInspection;
}

interface IndexStateRow {
    readonly status: 'empty' | 'ready' | 'stale';
    readonly snapshotSha256: string | null;
    readonly indexedAtUtc: string | null;
    readonly sourceCount: number;
    readonly entityCount: number;
    readonly relationshipCount: number;
}

class ProjectMemorySourceError extends Error {
    readonly sourcePath: string;

    constructor(sourcePath: string, message: string) {
        super(message);
        this.name = 'ProjectMemorySourceError';
        this.sourcePath = sourcePath;
    }
}

const readyIndexCache = new WeakMap<CatalogDatabase, ReadyIndexCacheEntry>();

function stableId(seed: string): string {
    return createHash('sha256').update(seed, 'utf8').digest('hex');
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message
        ? error.message
        : String(error || 'unknown project-memory index error');
}

function sourcePathFor(fileName: string): string {
    return `${PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH}/${fileName}`;
}

function assertCanonicalMemoryRoot(orchestratorRoot: string, memoryRoot: string): void {
    const relativeMemoryRoot = path.relative(orchestratorRoot, memoryRoot);
    if (
        !relativeMemoryRoot
        || path.isAbsolute(relativeMemoryRoot)
        || relativeMemoryRoot === '..'
        || relativeMemoryRoot.startsWith(`..${path.sep}`)
    ) {
        throw new ProjectMemorySourceError(
            PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH,
            `Canonical project-memory directory is unavailable or unsafe: ${PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH}.`
        );
    }
    let currentPath = orchestratorRoot;
    try {
        for (const segment of relativeMemoryRoot.split(path.sep)) {
            currentPath = path.join(currentPath, segment);
            const stat = fs.lstatSync(currentPath);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new ProjectMemorySourceError(
                    PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH,
                    `Canonical project-memory directory must not contain symlink or junction components: ${PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH}.`
                );
            }
        }
    } catch (error: unknown) {
        if (error instanceof ProjectMemorySourceError) throw error;
        throw new ProjectMemorySourceError(
            PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH,
            `Canonical project-memory directory is unavailable or unsafe: ${PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH}.`
        );
    }
    if (!isPathRealpathInsideRoot(orchestratorRoot, memoryRoot)) {
        throw new ProjectMemorySourceError(
            PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH,
            `Canonical project-memory directory escapes the orchestrator root: ${PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH}.`
        );
    }
}

function readBoundedMemoryFile(fileDescriptor: number, sourcePath: string): Buffer {
    const buffer = Buffer.allocUnsafe(MAX_PROJECT_MEMORY_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
        const bytesRead = fs.readSync(fileDescriptor, buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
    }
    if (offset > MAX_PROJECT_MEMORY_FILE_BYTES) {
        throw new ProjectMemorySourceError(
            sourcePath,
            `Approved project-memory source exceeds ${MAX_PROJECT_MEMORY_FILE_BYTES} bytes: ${sourcePath}.`
        );
    }
    return buffer.subarray(0, offset);
}

function sourceFingerprint(stat: fs.Stats): string {
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function readSafeMemoryFile(
    orchestratorRoot: string,
    memoryRoot: string,
    fileName: string
): SafeMemoryRead {
    const sourcePath = sourcePathFor(fileName);
    const filePath = path.resolve(memoryRoot, fileName);
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let fileDescriptor: number;
    assertCanonicalMemoryRoot(orchestratorRoot, memoryRoot);
    try {
        fileDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag);
    } catch {
        throw new ProjectMemorySourceError(sourcePath, `Approved project-memory source is unavailable: ${sourcePath}.`);
    }
    try {
        assertCanonicalMemoryRoot(orchestratorRoot, memoryRoot);
        const openedStat = fs.fstatSync(fileDescriptor);
        const pathStat = lstatFileIdentitySync(filePath);
        if (!openedStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()) {
            throw new ProjectMemorySourceError(
                sourcePath,
                `Approved project-memory source must be a regular file: ${sourcePath}.`
            );
        }
        const openedFingerprint = sourceFingerprint(openedStat);
        if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
            throw new ProjectMemorySourceError(
                sourcePath,
                `Approved project-memory source changed while being opened: ${sourcePath}.`
            );
        }
        if (
            !isPathRealpathInsideRoot(memoryRoot, filePath)
            || !isPathRealpathInsideRoot(orchestratorRoot, filePath)
        ) {
            throw new ProjectMemorySourceError(
                sourcePath,
                `Approved project-memory source escapes its canonical directory: ${sourcePath}.`
            );
        }
        if (openedStat.size > MAX_PROJECT_MEMORY_FILE_BYTES) {
            throw new ProjectMemorySourceError(
                sourcePath,
                `Approved project-memory source exceeds ${MAX_PROJECT_MEMORY_FILE_BYTES} bytes: ${sourcePath}.`
            );
        }
        const content = readBoundedMemoryFile(fileDescriptor, sourcePath);
        const finalOpenedStat = fs.fstatSync(fileDescriptor);
        const finalPathStat = lstatFileIdentitySync(filePath);
        if (
            !finalOpenedStat.isFile()
            || !finalPathStat.isFile()
            || finalPathStat.isSymbolicLink()
            || sourceFingerprint(finalOpenedStat) !== openedFingerprint
            || sourceFingerprint(finalPathStat) !== openedFingerprint
        ) {
            throw new ProjectMemorySourceError(
                sourcePath,
                `Approved project-memory source changed while being read: ${sourcePath}.`
            );
        }
        return { content, sourceFingerprint: openedFingerprint };
    } catch (error: unknown) {
        if (error instanceof ProjectMemorySourceError) throw error;
        throw new ProjectMemorySourceError(
            sourcePath,
            `Approved project-memory source could not be read safely: ${sourcePath}.`
        );
    } finally {
        fs.closeSync(fileDescriptor);
    }
}

function decodeUtf8(buffer: Buffer, sourcePath: string): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        throw new ProjectMemorySourceError(sourcePath, `Approved project-memory source is not valid UTF-8: ${sourcePath}.`);
    }
}

function cleanHeading(value: string): string {
    return value
        .replace(/\s+#+\s*$/u, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
        .replace(/[`*_~]/gu, '')
        .trim();
}

function buildSections(sourcePath: string, documentId: string, content: string): readonly MemorySection[] {
    const sections: Array<{
        heading: string;
        sourceLine: number;
        bodyLines: MemoryLine[];
        explicitHeading: boolean;
    }> = [];
    let current = {
        heading: 'Overview',
        sourceLine: 1,
        bodyLines: [] as MemoryLine[],
        explicitHeading: false
    };
    let fence: { readonly marker: '`' | '~'; readonly length: number } | null = null;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        const lineNumber = index + 1;
        const line = lines[index];
        const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/u);
        if (fenceMatch) {
            const sequence = fenceMatch[1];
            const marker = sequence[0] as '`' | '~';
            if (fence === null) fence = { marker, length: sequence.length };
            else if (fence.marker === marker && sequence.length >= fence.length) fence = null;
            current.bodyLines.push({ line: lineNumber, text: line, relationshipEligible: false });
            continue;
        }
        const headingMatch = fence === null ? line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/u) : null;
        if (headingMatch) {
            if (current.explicitHeading || current.bodyLines.some((entry) => entry.text.trim())) {
                sections.push(current);
            }
            current = {
                heading: cleanHeading(headingMatch[1]) || 'Untitled section',
                sourceLine: lineNumber,
                bodyLines: [],
                explicitHeading: true
            };
            continue;
        }
        current.bodyLines.push({
            line: lineNumber,
            text: line,
            relationshipEligible: fence === null
        });
    }
    sections.push(current);
    if (sections.length > MAX_PROJECT_MEMORY_SECTIONS_PER_DOCUMENT) {
        throw new ProjectMemorySourceError(
            sourcePath,
            `Approved project-memory source exceeds ${MAX_PROJECT_MEMORY_SECTIONS_PER_DOCUMENT} sections: ${sourcePath}.`
        );
    }
    return sections.map((section, index) => {
        const ordinal = index + 1;
        const body = section.bodyLines.map((entry) => entry.text).join('\n').trim();
        return Object.freeze({
            entityId: stableId(`project-memory:section:${documentId}:${ordinal}:${section.heading}`),
            heading: section.heading,
            sourceLine: section.sourceLine,
            ordinal,
            body,
            lines: Object.freeze(section.bodyLines.map((entry) => Object.freeze(entry)))
        });
    });
}

function extractTitle(fileName: string, content: string): string {
    let fence: { readonly marker: '`' | '~'; readonly length: number } | null = null;
    for (const line of content.split('\n')) {
        const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/u);
        if (fenceMatch) {
            const sequence = fenceMatch[1];
            const marker = sequence[0] as '`' | '~';
            if (fence === null) fence = { marker, length: sequence.length };
            else if (fence.marker === marker && sequence.length >= fence.length) fence = null;
            continue;
        }
        const headingMatch = fence === null ? line.match(/^\s{0,3}#\s+(.+?)\s*$/u) : null;
        if (headingMatch) return cleanHeading(headingMatch[1]) || fileName;
    }
    return fileName.replace(/\.md$/iu, '');
}

function readMemoryDocument(
    repoRoot: string,
    definition: typeof PROJECT_MEMORY_FILE_DEFINITIONS[number]
): MemoryDocument {
    const orchestratorRoot = joinOrchestratorPath(repoRoot, '');
    const memoryRoot = joinOrchestratorPath(repoRoot, PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH);
    const sourcePath = sourcePathFor(definition.fileName);
    const source = readSafeMemoryFile(orchestratorRoot, memoryRoot, definition.fileName);
    const original = normalizeProjectMemoryMarkdown(decodeUtf8(source.content, sourcePath));
    const redacted = redactSecretText(original);
    const indexed = normalizeProjectMemoryMarkdown(stripProjectMemoryHtmlComments(redacted));
    const documentId = stableId(`project-memory:document:${sourcePath}`);
    const title = extractTitle(definition.fileName, indexed);
    return Object.freeze({
        documentId,
        documentEntityId: stableId(`project-memory:entity:${documentId}`),
        fileName: definition.fileName,
        sourcePath,
        readRole: definition.readRole,
        title,
        contentSha256: sha256Hex(original),
        indexedContentSha256: sha256Hex(indexed),
        sourceFingerprint: source.sourceFingerprint,
        redactionApplied: redacted !== original,
        sections: buildSections(sourcePath, documentId, indexed)
    });
}

function approvedLinkTarget(value: string, documentsByFileName: ReadonlyMap<string, MemoryDocument>): MemoryDocument | null {
    const unwrapped = value.trim().replace(/^<|>$/gu, '');
    const targetPath = unwrapped.split('#', 1)[0].replace(/^\.\//u, '');
    if (!targetPath || targetPath.includes('/') || targetPath.includes('\\')) return null;
    return documentsByFileName.get(targetPath) || null;
}

function buildRelationships(documents: readonly MemoryDocument[]): readonly MemoryRelationship[] {
    const documentsByFileName = new Map(documents.map((document) => [document.fileName, document]));
    const relationships = new Map<string, MemoryRelationship>();
    for (const document of documents) {
        let linkCount = 0;
        for (const section of document.sections) {
            const containsId = stableId(`project-memory:contains:${document.documentEntityId}:${section.entityId}`);
            relationships.set(containsId, Object.freeze({
                relationshipId: containsId,
                sourceEntityId: document.documentEntityId,
                targetEntityId: section.entityId,
                kind: 'contains',
                sourcePath: document.sourcePath,
                sourceLine: section.sourceLine
            }));
            for (const line of section.lines) {
                if (!line.relationshipEligible) continue;
                const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
                let match: RegExpExecArray | null;
                while ((match = linkPattern.exec(line.text)) !== null) {
                    const target = approvedLinkTarget(match[1], documentsByFileName);
                    if (!target) continue;
                    linkCount += 1;
                    if (linkCount > MAX_PROJECT_MEMORY_LINKS_PER_DOCUMENT) {
                        throw new ProjectMemorySourceError(
                            document.sourcePath,
                            `Approved project-memory source exceeds ${MAX_PROJECT_MEMORY_LINKS_PER_DOCUMENT} approved links: ${document.sourcePath}.`
                        );
                    }
                    const relationshipId = stableId(
                        `project-memory:links-to:${section.entityId}:${target.documentEntityId}`
                    );
                    if (!relationships.has(relationshipId)) {
                        relationships.set(relationshipId, Object.freeze({
                            relationshipId,
                            sourceEntityId: section.entityId,
                            targetEntityId: target.documentEntityId,
                            kind: 'links_to',
                            sourcePath: document.sourcePath,
                            sourceLine: line.line
                        }));
                    }
                }
            }
        }
    }
    return Object.freeze([...relationships.values()].sort((left, right) => (
        left.sourcePath.localeCompare(right.sourcePath, 'en')
        || left.sourceLine - right.sourceLine
        || left.relationshipId.localeCompare(right.relationshipId, 'en')
    )));
}

function buildMemorySnapshot(repoRoot: string): MemorySnapshot {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const documents = PROJECT_MEMORY_FILE_DEFINITIONS
        .map((definition) => readMemoryDocument(resolvedRepoRoot, definition))
        .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath, 'en'));
    const snapshotPayload = documents
        .map((document) => `${document.sourcePath}\0${document.contentSha256}`)
        .join('\n');
    return Object.freeze({
        repoRoot: resolvedRepoRoot,
        snapshotSha256: sha256Hex(snapshotPayload),
        documents: Object.freeze(documents),
        relationships: buildRelationships(documents)
    });
}

function indexStateKey(state: IndexStateRow): string {
    return [
        state.status,
        state.snapshotSha256 || '',
        state.indexedAtUtc || '',
        state.sourceCount,
        state.entityCount,
        state.relationshipCount
    ].join('\0');
}

function readDataVersion(database: CatalogDatabase): number {
    const row = database.prepare('PRAGMA data_version').get() as Record<string, unknown> | undefined;
    const value = Number(row?.data_version);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('SQLite data_version is invalid.');
    }
    return value;
}

function snapshotSourceFingerprintsKey(snapshot: MemorySnapshot): string {
    return snapshot.documents
        .map((document) => `${document.sourcePath}\0${document.sourceFingerprint}`)
        .join('\n');
}

function currentSourceFingerprintsKey(repoRoot: string): string {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const orchestratorRoot = joinOrchestratorPath(resolvedRepoRoot, '');
    const memoryRoot = joinOrchestratorPath(resolvedRepoRoot, PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH);
    assertCanonicalMemoryRoot(orchestratorRoot, memoryRoot);
    return PROJECT_MEMORY_FILE_DEFINITIONS
        .map((definition) => {
            const sourcePath = sourcePathFor(definition.fileName);
            const filePath = path.resolve(memoryRoot, definition.fileName);
            let stat: fs.Stats;
            try {
                stat = lstatFileIdentitySync(filePath);
            } catch {
                throw new ProjectMemorySourceError(
                    sourcePath,
                    `Approved project-memory source is unavailable: ${sourcePath}.`
                );
            }
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new ProjectMemorySourceError(
                    sourcePath,
                    `Approved project-memory source must be a regular file: ${sourcePath}.`
                );
            }
            if (
                !isPathRealpathInsideRoot(memoryRoot, filePath)
                || !isPathRealpathInsideRoot(orchestratorRoot, filePath)
            ) {
                throw new ProjectMemorySourceError(
                    sourcePath,
                    `Approved project-memory source escapes its canonical directory: ${sourcePath}.`
                );
            }
            if (stat.size > MAX_PROJECT_MEMORY_FILE_BYTES) {
                throw new ProjectMemorySourceError(
                    sourcePath,
                    `Approved project-memory source exceeds ${MAX_PROJECT_MEMORY_FILE_BYTES} bytes: ${sourcePath}.`
                );
            }
            return `${sourcePath}\0${sourceFingerprint(stat)}`;
        })
        .sort((left, right) => left.localeCompare(right, 'en'))
        .join('\n');
}

function readIndexState(database: CatalogDatabase): IndexStateRow {
    const row = database.prepare(`
        SELECT index_status, snapshot_sha256, indexed_at_utc,
               source_count, entity_count, relationship_count
        FROM project_memory_index_state
        WHERE singleton_id = 1
    `).get() as Record<string, unknown> | undefined;
    const status = String(row?.index_status || '');
    if (status !== 'empty' && status !== 'ready' && status !== 'stale') {
        throw new Error('Project-memory index state is invalid.');
    }
    return {
        status,
        snapshotSha256: typeof row?.snapshot_sha256 === 'string' ? row.snapshot_sha256 : null,
        indexedAtUtc: typeof row?.indexed_at_utc === 'string' ? row.indexed_at_utc : null,
        sourceCount: Number(row?.source_count || 0),
        entityCount: Number(row?.entity_count || 0),
        relationshipCount: Number(row?.relationship_count || 0)
    };
}

function readActualIndexCounts(database: CatalogDatabase): {
    readonly sourceCount: number;
    readonly entityCount: number;
    readonly relationshipCount: number;
    readonly ftsCount: number;
} {
    const row = database.prepare(`
        SELECT
            (SELECT count(*) FROM project_memory_documents) AS source_count,
            (SELECT count(*) FROM project_memory_entities) AS entity_count,
            (SELECT count(*) FROM project_memory_relationships) AS relationship_count,
            (SELECT count(*) FROM project_memory_fts) AS fts_count
    `).get() as Record<string, unknown> | undefined;
    return {
        sourceCount: Number(row?.source_count || 0),
        entityCount: Number(row?.entity_count || 0),
        relationshipCount: Number(row?.relationship_count || 0),
        ftsCount: Number(row?.fts_count || 0)
    };
}

function expectedIndexProjection(snapshot: MemorySnapshot, indexedAtUtc: string | null): unknown {
    return {
        documents: snapshot.documents.map((document) => [
            document.documentId,
            document.sourcePath,
            document.fileName,
            document.readRole,
            document.title,
            document.contentSha256,
            document.indexedContentSha256,
            document.redactionApplied ? 1 : 0,
            indexedAtUtc
        ]),
        entities: snapshot.documents.flatMap((document) => [
            [
                document.documentEntityId,
                document.documentId,
                'document',
                document.title,
                document.title.toLocaleLowerCase('en-US'),
                document.sourcePath,
                1,
                0,
                sha256Hex(document.title)
            ],
            ...document.sections.map((section) => [
                section.entityId,
                document.documentId,
                'section',
                section.heading,
                section.heading.toLocaleLowerCase('en-US'),
                document.sourcePath,
                section.sourceLine,
                section.ordinal,
                sha256Hex(`${section.heading}\n${section.body}`)
            ])
        ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]), 'en')),
        relationships: snapshot.relationships
            .map((relationship) => [
                relationship.relationshipId,
                relationship.sourceEntityId,
                relationship.targetEntityId,
                relationship.kind,
                relationship.sourcePath,
                relationship.sourceLine
            ])
            .sort((left, right) => String(left[0]).localeCompare(String(right[0]), 'en')),
        fts: snapshot.documents.flatMap((document) => document.sections.map((section) => [
            section.entityId,
            document.documentId,
            document.sourcePath,
            section.sourceLine,
            document.title,
            section.heading,
            section.body
        ])).sort((left, right) => String(left[0]).localeCompare(String(right[0]), 'en'))
    };
}

function actualIndexProjection(database: CatalogDatabase): unknown {
    const documents = database.prepare(`
        SELECT document_id, source_path, file_name, read_role, title,
               content_sha256, indexed_content_sha256, redaction_applied, indexed_at_utc
        FROM project_memory_documents
        ORDER BY source_path
    `).all() as Record<string, unknown>[];
    const entities = database.prepare(`
        SELECT entity_id, document_id, entity_kind, label, normalized_label,
               source_path, source_line, ordinal, content_sha256
        FROM project_memory_entities
        ORDER BY entity_id
    `).all() as Record<string, unknown>[];
    const relationships = database.prepare(`
        SELECT relationship_id, source_entity_id, target_entity_id,
               relationship_kind, source_path, source_line
        FROM project_memory_relationships
        ORDER BY relationship_id
    `).all() as Record<string, unknown>[];
    const fts = database.prepare(`
        SELECT entity_id, document_id, source_path, source_line, title, heading, body
        FROM project_memory_fts
        ORDER BY entity_id, rowid
    `).all() as Record<string, unknown>[];
    return {
        documents: documents
            .map((row) => [
                String(row.document_id),
                String(row.source_path),
                String(row.file_name),
                String(row.read_role),
                String(row.title),
                String(row.content_sha256),
                String(row.indexed_content_sha256),
                Number(row.redaction_applied),
                typeof row.indexed_at_utc === 'string' ? row.indexed_at_utc : null
            ])
            .sort((left, right) => String(left[1]).localeCompare(String(right[1]), 'en')),
        entities: entities
            .map((row) => [
                String(row.entity_id),
                String(row.document_id),
                String(row.entity_kind),
                String(row.label),
                String(row.normalized_label),
                String(row.source_path),
                Number(row.source_line),
                Number(row.ordinal),
                String(row.content_sha256)
            ])
            .sort((left, right) => String(left[0]).localeCompare(String(right[0]), 'en')),
        relationships: relationships
            .map((row) => [
                String(row.relationship_id),
                String(row.source_entity_id),
                String(row.target_entity_id),
                String(row.relationship_kind),
                String(row.source_path),
                Number(row.source_line)
            ])
            .sort((left, right) => String(left[0]).localeCompare(String(right[0]), 'en')),
        fts: fts
            .map((row) => [
                String(row.entity_id),
                String(row.document_id),
                String(row.source_path),
                Number(row.source_line),
                String(row.title),
                String(row.heading),
                String(row.body)
            ])
            .sort((left, right) => String(left[0]).localeCompare(String(right[0]), 'en'))
    };
}

function indexProjectionMatches(
    database: CatalogDatabase,
    snapshot: MemorySnapshot,
    indexedAtUtc: string | null
): boolean {
    return sha256Hex(JSON.stringify(actualIndexProjection(database)))
        === sha256Hex(JSON.stringify(expectedIndexProjection(snapshot, indexedAtUtc)));
}

function changedSourcePaths(database: CatalogDatabase, snapshot: MemorySnapshot): readonly string[] {
    const indexedRows = database.prepare(`
        SELECT source_path, content_sha256 FROM project_memory_documents ORDER BY source_path
    `).all() as Record<string, unknown>[];
    const indexed = new Map(indexedRows.map((row) => [String(row.source_path), String(row.content_sha256)]));
    const changed = snapshot.documents
        .filter((document) => indexed.get(document.sourcePath) !== document.contentSha256)
        .map((document) => document.sourcePath);
    for (const sourcePath of indexed.keys()) {
        if (!snapshot.documents.some((document) => document.sourcePath === sourcePath)) changed.push(sourcePath);
    }
    return Object.freeze([...new Set(changed)].sort((left, right) => left.localeCompare(right, 'en')));
}

function inspectionFromSourceError(error: unknown): ProjectMemoryIndexInspection {
    const sourcePath = error instanceof ProjectMemorySourceError ? error.sourcePath : PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH;
    return {
        status: 'unavailable',
        snapshotSha256: null,
        indexedAtUtc: null,
        sourceCount: 0,
        entityCount: 0,
        relationshipCount: 0,
        changedSources: [sourcePath],
        diagnostic: errorMessage(error)
    };
}

function inspectSqliteProjectMemoryIndexSnapshot(
    database: CatalogDatabase,
    snapshot: MemorySnapshot
): ProjectMemoryIndexInspection {
    const dataVersionBefore = readDataVersion(database);
    const state = readIndexState(database);
    const actualCounts = readActualIndexCounts(database);
    const changedSources = changedSourcePaths(database, snapshot);
    const countsMatch = state.sourceCount === actualCounts.sourceCount
        && state.entityCount === actualCounts.entityCount
        && state.relationshipCount === actualCounts.relationshipCount;
    const projectionMatches = indexProjectionMatches(database, snapshot, state.indexedAtUtc);
    const dataVersionAfter = readDataVersion(database);
    const ready = state.status === 'ready'
        && state.snapshotSha256 === snapshot.snapshotSha256
        && changedSources.length === 0
        && countsMatch
        && projectionMatches
        && dataVersionBefore === dataVersionAfter;
    const empty = state.status === 'empty'
        && state.snapshotSha256 === null
        && actualCounts.sourceCount === 0
        && actualCounts.entityCount === 0
        && actualCounts.relationshipCount === 0
        && actualCounts.ftsCount === 0;
    const inspection: ProjectMemoryIndexInspection = {
        status: ready ? 'ready' : empty ? 'empty' : 'stale',
        snapshotSha256: state.snapshotSha256,
        indexedAtUtc: state.indexedAtUtc,
        sourceCount: actualCounts.sourceCount,
        entityCount: actualCounts.entityCount,
        relationshipCount: actualCounts.relationshipCount,
        changedSources,
        diagnostic: ready
            ? 'Project-memory SQLite index matches every approved canonical source hash.'
            : empty
            ? 'Project-memory SQLite index has not been built.'
            : 'Project-memory SQLite index is stale or internally inconsistent.'
    };
    if (inspection.status === 'ready') {
        readyIndexCache.set(database, {
            repoRoot: snapshot.repoRoot,
            stateKey: indexStateKey(state),
            dataVersion: dataVersionAfter,
            sourceFingerprintsKey: snapshotSourceFingerprintsKey(snapshot),
            inspection: { ...inspection, changedSources: Object.freeze([...inspection.changedSources]) }
        });
    } else {
        readyIndexCache.delete(database);
    }
    return inspection;
}

export function inspectSqliteProjectMemoryIndex(
    database: CatalogDatabase,
    repoRoot: string
): ProjectMemoryIndexInspection {
    try {
        return inspectSqliteProjectMemoryIndexSnapshot(database, buildMemorySnapshot(repoRoot));
    } catch (error: unknown) {
        readyIndexCache.delete(database);
        return inspectionFromSourceError(error);
    }
}

function inspectSqliteProjectMemoryIndexForQuery(
    database: CatalogDatabase,
    repoRoot: string
): ProjectMemoryIndexInspection {
    const cached = readyIndexCache.get(database);
    const resolvedRepoRoot = path.resolve(repoRoot);
    if (cached && cached.repoRoot === resolvedRepoRoot) {
        try {
            const state = readIndexState(database);
            if (
                cached.stateKey === indexStateKey(state)
                && cached.dataVersion === readDataVersion(database)
                && cached.sourceFingerprintsKey === currentSourceFingerprintsKey(resolvedRepoRoot)
            ) {
                return { ...cached.inspection, changedSources: [...cached.inspection.changedSources] };
            }
        } catch {
            // Fall through to the full fail-closed inspection for precise diagnostics.
        }
    }
    readyIndexCache.delete(database);
    return inspectSqliteProjectMemoryIndex(database, resolvedRepoRoot);
}

function verifyRefreshSnapshot(
    database: CatalogDatabase,
    repoRoot: string,
    snapshot: MemorySnapshot,
    outcome: 'applied' | 'current'
): ProjectMemoryIndexRefreshResult {
    const verified = inspectSqliteProjectMemoryIndex(database, repoRoot);
    if (verified.status === 'ready' && verified.snapshotSha256 === snapshot.snapshotSha256) {
        return { ...verified, outcome };
    }
    return {
        ...verified,
        outcome: 'deferred',
        diagnostic: 'Canonical project-memory sources changed while the index refresh was in progress; the persisted index is stale.'
    };
}

export function refreshSqliteProjectMemoryIndex(
    database: CatalogDatabase,
    repoRoot: string,
    indexedAtUtc: string
): ProjectMemoryIndexRefreshResult {
    readyIndexCache.delete(database);
    let snapshot: MemorySnapshot;
    try {
        snapshot = buildMemorySnapshot(repoRoot);
    } catch (error: unknown) {
        return { ...inspectionFromSourceError(error), outcome: 'deferred' };
    }
    const before = inspectSqliteProjectMemoryIndexSnapshot(database, snapshot);
    if (before.status === 'ready' && before.snapshotSha256 === snapshot.snapshotSha256) {
        return verifyRefreshSnapshot(database, repoRoot, snapshot, 'current');
    }
    const entityCount = snapshot.documents.reduce((count, document) => count + 1 + document.sections.length, 0);
    try {
        database.exec('BEGIN IMMEDIATE;');
        database.exec([
            'DELETE FROM project_memory_fts;',
            'DELETE FROM project_memory_relationships;',
            'DELETE FROM project_memory_entities;',
            'DELETE FROM project_memory_documents;'
        ].join('\n'));
        const insertDocument = database.prepare(`
            INSERT INTO project_memory_documents (
                document_id, source_path, file_name, read_role, title,
                content_sha256, indexed_content_sha256, redaction_applied, indexed_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertEntity = database.prepare(`
            INSERT INTO project_memory_entities (
                entity_id, document_id, entity_kind, label, normalized_label,
                source_path, source_line, ordinal, content_sha256
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertFts = database.prepare(`
            INSERT INTO project_memory_fts (
                entity_id, document_id, source_path, source_line, title, heading, body
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const insertRelationship = database.prepare(`
            INSERT INTO project_memory_relationships (
                relationship_id, source_entity_id, target_entity_id,
                relationship_kind, source_path, source_line
            ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const document of snapshot.documents) {
            insertDocument.run(
                document.documentId,
                document.sourcePath,
                document.fileName,
                document.readRole,
                document.title,
                document.contentSha256,
                document.indexedContentSha256,
                document.redactionApplied ? 1 : 0,
                indexedAtUtc
            );
            insertEntity.run(
                document.documentEntityId,
                document.documentId,
                'document',
                document.title,
                document.title.toLocaleLowerCase('en-US'),
                document.sourcePath,
                1,
                0,
                sha256Hex(document.title)
            );
            for (const section of document.sections) {
                insertEntity.run(
                    section.entityId,
                    document.documentId,
                    'section',
                    section.heading,
                    section.heading.toLocaleLowerCase('en-US'),
                    document.sourcePath,
                    section.sourceLine,
                    section.ordinal,
                    sha256Hex(`${section.heading}\n${section.body}`)
                );
                insertFts.run(
                    section.entityId,
                    document.documentId,
                    document.sourcePath,
                    section.sourceLine,
                    document.title,
                    section.heading,
                    section.body
                );
            }
        }
        for (const relationship of snapshot.relationships) {
            insertRelationship.run(
                relationship.relationshipId,
                relationship.sourceEntityId,
                relationship.targetEntityId,
                relationship.kind,
                relationship.sourcePath,
                relationship.sourceLine
            );
        }
        database.prepare(`
            UPDATE project_memory_index_state
            SET index_status = 'ready', snapshot_sha256 = ?, indexed_at_utc = ?,
                source_count = ?, entity_count = ?, relationship_count = ?
            WHERE singleton_id = 1
        `).run(
            snapshot.snapshotSha256,
            indexedAtUtc,
            snapshot.documents.length,
            entityCount,
            snapshot.relationships.length
        );
        database.exec('COMMIT;');
    } catch (error: unknown) {
        try {
            database.exec('ROLLBACK;');
        } catch {
            // Preserve the primary write failure.
        }
        return {
            ...before,
            status: before.status === 'ready' ? 'stale' : before.status,
            outcome: 'deferred',
            diagnostic: `Project-memory SQLite index refresh was deferred: ${errorMessage(error)}`
        };
    }
    const verified = verifyRefreshSnapshot(database, repoRoot, snapshot, 'applied');
    return verified.outcome === 'applied'
        ? {
            ...verified,
            diagnostic: 'Approved project-memory Markdown was indexed without changing canonical sources.'
        }
        : verified;
}

function compileFtsQuery(query: string): string | null {
    const normalized = String(query || '').trim().slice(0, MAX_PROJECT_MEMORY_QUERY_CHARS);
    const tokens = normalized.match(/[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu)
        ?.slice(0, MAX_PROJECT_MEMORY_QUERY_TOKENS) || [];
    if (tokens.length === 0) return null;
    return tokens.map((token) => `"${token.replace(/"/gu, '""')}"`).join(' AND ');
}

export function searchSqliteProjectMemoryIndex(
    database: CatalogDatabase,
    repoRoot: string,
    query: string,
    options: ProjectMemorySearchOptions = {}
): ProjectMemorySearchResult {
    const inspection = inspectSqliteProjectMemoryIndexForQuery(database, repoRoot);
    if (inspection.status !== 'ready') {
        return {
            status: inspection.status,
            snapshotSha256: inspection.snapshotSha256,
            hits: [],
            changedSources: inspection.changedSources,
            diagnostic: inspection.diagnostic
        };
    }
    const ftsQuery = compileFtsQuery(query);
    if (!ftsQuery) {
        return {
            status: 'invalid_query',
            snapshotSha256: inspection.snapshotSha256,
            hits: [],
            changedSources: [],
            diagnostic: 'Project-memory search query contains no searchable tokens.'
        };
    }
    const requestedLimit = Number(options.limit ?? DEFAULT_PROJECT_MEMORY_SEARCH_LIMIT);
    const limit = Number.isSafeInteger(requestedLimit)
        ? Math.max(1, Math.min(MAX_PROJECT_MEMORY_SEARCH_LIMIT, requestedLimit))
        : DEFAULT_PROJECT_MEMORY_SEARCH_LIMIT;
    const rows = database.prepare(`
        SELECT
            entity_id,
            source_path,
            CAST(source_line AS INTEGER) AS source_line,
            title,
            heading,
            snippet(project_memory_fts, 6, '[', ']', ' … ', 18) AS snippet,
            bm25(project_memory_fts, 0.0, 0.0, 0.0, 0.0, 5.0, 3.0, 1.0) AS rank
        FROM project_memory_fts
        WHERE project_memory_fts MATCH ?
        ORDER BY rank ASC, source_path COLLATE BINARY ASC,
                 CAST(source_line AS INTEGER) ASC, entity_id COLLATE BINARY ASC
        LIMIT ?
    `).all(ftsQuery, limit) as Record<string, unknown>[];
    return {
        status: 'ready',
        snapshotSha256: inspection.snapshotSha256,
        hits: rows.map((row) => ({
            entityId: String(row.entity_id),
            sourcePath: String(row.source_path),
            sourceLine: Number(row.source_line),
            title: String(row.title),
            heading: String(row.heading),
            snippet: String(row.snippet || ''),
            rank: Number(row.rank)
        })),
        changedSources: [],
        diagnostic: `Project-memory search returned ${rows.length} deterministic result(s).`
    };
}

export function querySqliteProjectMemoryRelationships(
    database: CatalogDatabase,
    repoRoot: string,
    sourcePath?: string
): ProjectMemoryRelationshipResult {
    const inspection = inspectSqliteProjectMemoryIndexForQuery(database, repoRoot);
    if (inspection.status !== 'ready') {
        return {
            status: inspection.status,
            snapshotSha256: inspection.snapshotSha256,
            relationships: [],
            changedSources: inspection.changedSources,
            diagnostic: inspection.diagnostic
        };
    }
    const rows = database.prepare(`
        SELECT
            relationship.relationship_id,
            relationship.source_entity_id,
            relationship.target_entity_id,
            relationship.relationship_kind,
            relationship.source_path,
            target.source_path AS target_source_path,
            relationship.source_line
        FROM project_memory_relationships AS relationship
        INNER JOIN project_memory_entities AS target
            ON target.entity_id = relationship.target_entity_id
        WHERE (? IS NULL OR relationship.source_path = ?)
        ORDER BY relationship.source_path COLLATE BINARY ASC,
                 relationship.source_line ASC,
                 relationship.relationship_kind COLLATE BINARY ASC,
                 target.source_path COLLATE BINARY ASC,
                 relationship.relationship_id COLLATE BINARY ASC
    `).all(sourcePath || null, sourcePath || null) as Record<string, unknown>[];
    return {
        status: 'ready',
        snapshotSha256: inspection.snapshotSha256,
        relationships: rows.map((row) => ({
            relationshipId: String(row.relationship_id),
            sourceEntityId: String(row.source_entity_id),
            targetEntityId: String(row.target_entity_id),
            kind: String(row.relationship_kind) as 'contains' | 'links_to',
            sourcePath: String(row.source_path),
            targetSourcePath: String(row.target_source_path),
            sourceLine: Number(row.source_line)
        })),
        changedSources: [],
        diagnostic: `Project-memory relationship query returned ${rows.length} deterministic row(s).`
    };
}
