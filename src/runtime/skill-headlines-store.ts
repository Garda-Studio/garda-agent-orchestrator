import * as fs from 'node:fs';

import { pathExists } from '../core/filesystem';
import { bindContainedDestination, writeContainedFile } from '../core/contained-filesystem';
import { asObjectRecord } from './skill-manifest';
import { formatJson, readJsonFile } from '../core/json';
import { computePayloadSha256, computeSha256FromText } from './skill-headlines-hashing';
import {
    buildSkillsHeadlinesPayload
} from './skill-headlines-payload';
import { getSkillsHeadlinesConfigPath } from './skill-headlines-sources';
import type { SkillsHeadlinesData, SkillsHeadlinesPayload } from './skill-headlines-types';
import { isValidSkillsHeadlinesPayload } from './skill-headlines-validation';

export function buildSkillsHeadlines(
    bundleRoot: string,
    sourceStateSha256?: string,
    sourceStateHintSha256?: string
): SkillsHeadlinesPayload {
    return buildSkillsHeadlinesPayload(bundleRoot, sourceStateSha256, sourceStateHintSha256);
}

export function writeSkillsHeadlines(bundleRoot: string): string {
    const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
    bindContainedDestination(bundleRoot, headlinesPath);
    writeContainedFile(bundleRoot, headlinesPath, formatJson(buildSkillsHeadlines(bundleRoot)));
    return headlinesPath;
}

export function ensureSkillsHeadlinesCurrent(bundleRoot: string): SkillsHeadlinesData {
    const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);

    const expected = buildSkillsHeadlines(bundleRoot);
    const expectedSha256 = computePayloadSha256(expected);

    if (!pathExists(headlinesPath)) {
        writeContainedFile(bundleRoot, headlinesPath, formatJson(expected));
        return {
            headlinesPath,
            sha256: expectedSha256,
            payload: expected
        };
    }

    try {
        const parsed = readJsonFile(headlinesPath);
        if (JSON.stringify(parsed) === JSON.stringify(expected)) {
            return {
                headlinesPath,
                sha256: expectedSha256,
                payload: expected
            };
        }
    } catch {
        // Refresh malformed artifacts from the current live skill surface.
    }

    writeContainedFile(bundleRoot, headlinesPath, formatJson(expected));
    return {
        headlinesPath,
        sha256: expectedSha256,
        payload: expected
    };
}

export function readSkillsHeadlines(bundleRoot: string): SkillsHeadlinesData {
    const { headlinesPath, sha256, payload } = ensureSkillsHeadlinesCurrent(bundleRoot);
    const normalizedPayload = asObjectRecord(payload);
    if (!isValidSkillsHeadlinesPayload(normalizedPayload)) {
        throw new Error(`Skills headlines have an invalid shape: ${headlinesPath}`);
    }

    return {
        headlinesPath,
        sha256,
        payload: normalizedPayload as unknown as SkillsHeadlinesPayload
    };
}

export function readSkillsHeadlinesIfPresent(bundleRoot: string): SkillsHeadlinesData | null {
    const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
    if (!pathExists(headlinesPath)) {
        return null;
    }

    try {
        const fileText = fs.readFileSync(headlinesPath, 'utf8');
        const normalizedPayload = asObjectRecord(JSON.parse(fileText));
        if (!isValidSkillsHeadlinesPayload(normalizedPayload)) {
            return null;
        }
        return {
            headlinesPath,
            sha256: computeSha256FromText(fileText),
            payload: normalizedPayload as unknown as SkillsHeadlinesPayload
        };
    } catch {
        return null;
    }
}

export function validateSkillsHeadlines(bundleRoot: string) {
    const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
    const issues: string[] = [];
    const expected = buildSkillsHeadlines(bundleRoot);

    if (!pathExists(headlinesPath)) {
        issues.push(`Skills headlines are missing: ${headlinesPath}`);
        return { headlinesPath, expected, issues, passed: false };
    }

    let parsed: unknown = null;
    try {
        parsed = readJsonFile(headlinesPath);
    } catch {
        issues.push(`Skills headlines are not valid JSON: ${headlinesPath}`);
        return { headlinesPath, expected, issues, passed: false };
    }

    const actualSerialized = JSON.stringify(parsed);
    const expectedSerialized = JSON.stringify(expected);
    if (actualSerialized !== expectedSerialized) {
        issues.push(`Skills headlines are stale: ${headlinesPath}. Re-run init/materialization to refresh them.`);
    }

    return {
        headlinesPath,
        expected,
        issues,
        passed: issues.length === 0
    };
}
