import { isTestLikeRemediationPath } from '../../../../gates/review-remediation/review-remediation-scope-boundary';
import { declaredFileRole, type FileRoleBindings } from '../../../../core/file-role-bindings';
import { normalizeChangedFiles } from './recovery-flow-shared';
import type {
    ReviewRemediationImpactAnalysis,
    ReviewRemediationScopeBoundary,
    ReviewRemediationSemanticCategory
} from './recovery-flow-types';

export interface ReviewRemediationSemanticSignals {
    category: ReviewRemediationSemanticCategory;
    matchedSignals: string[];
    rationale: string;
    changedFiles: string[];
    scopeSource: 'expanded_files' | 'impact_analysis_files' | 'current_changed_files';
}

export function groupReviewRemediationFiles(
    files: readonly string[],
    testTriggerRegexes: readonly string[],
    fileRoles?: FileRoleBindings
): Record<string, string[]> {
    const groups: Record<string, string[]> = {
        source: [],
        test: [],
        docs: [],
        config: [],
        runtime_artifact: [],
        other: []
    };
    for (const file of normalizeChangedFiles(files)) {
        if (declaredFileRole(file, fileRoles) === 'source') {
            groups.source.push(file);
        } else if (isTestLikeRemediationPath(file, testTriggerRegexes, fileRoles)) {
            groups.test.push(file);
        } else if (/^(docs|docs_local)\//iu.test(file) || /\.(md|mdx)$/iu.test(file)) {
            groups.docs.push(file);
        } else if (/^(package(-lock)?\.json|tsconfig[^/]*\.json|\.github\/|live\/config\/|garda-agent-orchestrator\/live\/config\/)/iu.test(file)) {
            groups.config.push(file);
        } else if (/^(garda-agent-orchestrator\/runtime\/|runtime\/)/iu.test(file)) {
            groups.runtime_artifact.push(file);
        } else if (/^(src|bin|template|live)\//iu.test(file) || /^garda-agent-orchestrator\/(src|bin|template|live)\//iu.test(file)) {
            groups.source.push(file);
        } else {
            groups.other.push(file);
        }
    }
    return Object.fromEntries(Object.entries(groups).filter(([, entries]) => entries.length > 0));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeImpactAnalysisSearchText(summary: string): string {
    return summary.replace(/\\/gu, '/').toLocaleLowerCase();
}

function findAllNeedleIndexes(haystack: string, needle: string): number[] {
    const indexes: number[] = [];
    if (!needle) {
        return indexes;
    }
    let fromIndex = 0;
    while (fromIndex < haystack.length) {
        const index = haystack.indexOf(needle, fromIndex);
        if (index < 0) {
            break;
        }
        indexes.push(index);
        fromIndex = index + Math.max(needle.length, 1);
    }
    return indexes;
}

function isNegatedFileMention(summary: string, index: number, needleLength: number): boolean {
    const before = summary.slice(Math.max(0, index - 120), index);
    const after = summary.slice(index + needleLength, Math.min(summary.length, index + needleLength + 140));
    const marker = '__remediation_file__';
    const around = `${before}${marker}${after}`;
    const markerPattern = escapeRegExp(marker);
    const directNegationPatterns = [
        new RegExp(`\\b(?:no|without)\\s+(?:product\\s+|source\\s+)?(?:changes?|edits?|modifications?|touches?)\\s+(?:to|in|for)?\\s*[^.;,]{0,60}${markerPattern}`, 'iu'),
        new RegExp(`\\b(?:not|never)\\s+(?:changed|modified|touched)\\s+[^.;,]{0,60}${markerPattern}`, 'iu'),
        new RegExp(`${markerPattern}[^.;,]{0,80}\\b(?:unchanged|unmodified|untouched|not\\s+(?:changed|modified|touched)|stay(?:s|ed)?\\s+unchanged|remain(?:s|ed)?\\s+unchanged)\\b`, 'iu')
    ];
    return directNegationPatterns.some((pattern) => pattern.test(around));
}

function getPositiveSummaryClauses(summary: string): string[] {
    return summary
        .replace(/\\/gu, '/')
        .split(/[.;\n\r]+/u)
        .map((clause) => clause.trim())
        .filter(Boolean)
        .filter((clause) => !/\b(?:no|not|never|without)\b[^.;\n\r]{0,80}\b(?:api|public\s+api|runtime|behavior|contract|security|artifact|product|source)\b|\b(?:api|public\s+api|runtime|behavior|contract|security|artifact|product|source)\b[^.;\n\r]{0,80}\b(?:unchanged|unmodified|untouched|not\s+(?:changed|modified|touched)|stay(?:s|ed)?\s+unchanged|remain(?:s|ed)?\s+unchanged)\b/iu.test(clause));
}

function getReviewRemediationSemanticFileScope(
    scopeBoundary: ReviewRemediationScopeBoundary,
    impactAnalysis?: ReviewRemediationImpactAnalysis,
    testTriggerRegexes: readonly string[] = []
): { files: string[]; source: ReviewRemediationSemanticSignals['scopeSource'] } {
    const expandedFiles = normalizeChangedFiles(scopeBoundary.expandedFiles);
    if (expandedFiles.length > 0) {
        return {
            files: expandedFiles,
            source: 'expanded_files'
        };
    }
    const impactAnalysisFiles = getTestOnlyImpactAnalysisFileScope(
        scopeBoundary,
        impactAnalysis,
        testTriggerRegexes
    );
    if (impactAnalysisFiles.length > 0) {
        return {
            files: impactAnalysisFiles,
            source: 'impact_analysis_files'
        };
    }
    return {
        files: scopeBoundary.currentChangedFiles,
        source: 'current_changed_files'
    };
}

function getMentionedCurrentChangedFiles(
    summary: string,
    currentChangedFiles: readonly string[]
): string[] {
    const normalizedSummary = normalizeImpactAnalysisSearchText(summary);
    return normalizeChangedFiles(currentChangedFiles).filter((entry) => {
        const normalizedEntry = entry.toLocaleLowerCase();
        const mentionIndexes = findAllNeedleIndexes(normalizedSummary, normalizedEntry);
        return mentionIndexes.some((index) => (
            !isNegatedFileMention(normalizedSummary, index, normalizedEntry.length)
        ));
    });
}

function getTestOnlyImpactAnalysisFileScope(
    scopeBoundary: ReviewRemediationScopeBoundary,
    impactAnalysis: ReviewRemediationImpactAnalysis | undefined,
    testTriggerRegexes: readonly string[]
): string[] {
    if (!impactAnalysis || scopeBoundary.status !== 'OK') {
        return [];
    }
    const mentionedFiles = getMentionedCurrentChangedFiles(
        impactAnalysis.summary,
        scopeBoundary.currentChangedFiles
    );
    if (mentionedFiles.length === 0) {
        return [];
    }
    return mentionedFiles.every((entry) => isTestLikeRemediationPath(entry, testTriggerRegexes, scopeBoundary.fileRoles))
        ? mentionedFiles
        : [];
}

export function getReviewRemediationSemanticSignals(
    scopeBoundary: ReviewRemediationScopeBoundary,
    impactAnalysis?: ReviewRemediationImpactAnalysis,
    testTriggerRegexes: readonly string[] = []
): ReviewRemediationSemanticSignals {
    const summary = impactAnalysis?.summary || '';
    const semanticFileScope = getReviewRemediationSemanticFileScope(
        scopeBoundary,
        impactAnalysis,
        testTriggerRegexes
    );
    if (impactAnalysis && semanticFileScope.source === 'impact_analysis_files') {
        return {
            category: 'test_coverage_only',
            matchedSignals: ['test-only impact analysis files'],
            rationale: 'remediation impact analysis names only classifier-recognized test files inside the previous failed-review scope',
            changedFiles: semanticFileScope.files,
            scopeSource: semanticFileScope.source
        };
    }
    const files = semanticFileScope.files.join('\n').toLocaleLowerCase();
    const positiveSummary = getPositiveSummaryClauses(summary).join('\n').toLocaleLowerCase();
    const text = `${positiveSummary}\n${files}`;
    const matches: Array<{ category: ReviewRemediationSemanticCategory; signal: string; pattern: RegExp }> = [
        {
            category: 'security_sensitive',
            signal: 'security-sensitive surface',
            pattern: /\b(security[-\s]?sensitive|auth(?:entication|orization)?|token|secret|credential|crypto|signature|provenance|trust|redaction)\b/iu
        },
        {
            category: 'api_surface',
            signal: 'public API surface',
            pattern: /\b(public\s+(?:api|surface)|api\s+surface|exported\s+(?:api|contract|symbol)|breaking\s+change)\b/iu
        },
        {
            category: 'runtime_behavior',
            signal: 'runtime behavior change',
            pattern: /\b(runtime\s+(?:behavior|deletion|change)|behavior\s+change|observable\s+behavior|execution\s+path)\b/iu
        },
        {
            category: 'test_hook_isolation',
            signal: 'test hook isolation',
            pattern: /(?:_testhooks?|test[-\s_]?hooks?|test[-\s]?only\s+hook|hook\s+isolation)/iu
        },
        {
            category: 'refactor_structure',
            signal: 'refactor structure',
            pattern: /\b(refactor(?:ing)?\s+structure|structural\s+refactor|decomposition|extraction|rename|move)\b/iu
        }
    ];
    const matched = matches.filter((entry) => entry.pattern.test(text));
    const matchedCategories = [...new Set(matched.map((entry) => entry.category))];
    if (matchedCategories.length === 1) {
        const category = matchedCategories[0] as ReviewRemediationSemanticCategory;
        return {
            category,
            matchedSignals: matched.map((entry) => entry.signal),
            rationale: `remediation impact analysis and file scope matched ${category}`,
            changedFiles: semanticFileScope.files,
            scopeSource: semanticFileScope.source
        };
    }
    if (matchedCategories.length > 1) {
        return {
            category: 'unknown',
            matchedSignals: matched.map((entry) => entry.signal),
            rationale: 'remediation matched multiple semantic classes; fail closed before reuse',
            changedFiles: semanticFileScope.files,
            scopeSource: semanticFileScope.source
        };
    }
    const semanticFileGroups = groupReviewRemediationFiles(
        semanticFileScope.files,
        testTriggerRegexes,
        scopeBoundary.fileRoles
    );
    if (impactAnalysis && (semanticFileGroups.source?.length || 0) > 0) {
        return {
            category: 'runtime_behavior',
            matchedSignals: ['source remediation fallback'],
            rationale: 'remediation changes source files but uses no narrower supported semantic phrase; classify as runtime behavior and fail closed before reuse',
            changedFiles: semanticFileScope.files,
            scopeSource: semanticFileScope.source
        };
    }
    if (
        impactAnalysis
        && scopeBoundary.status === 'OK'
        && scopeBoundary.allowedTestOnlyExpansionFiles.length > 0
        && scopeBoundary.expandedNonTestFiles.length === 0
    ) {
        return {
            category: 'test_coverage_only',
            matchedSignals: ['test-only expansion'],
            rationale: 'remediation only added classifier-recognized test coverage outside the previous failed-review scope',
            changedFiles: semanticFileScope.files,
            scopeSource: semanticFileScope.source
        };
    }
    return {
        category: 'unknown',
        matchedSignals: impactAnalysis ? [] : ['missing remediation impact analysis'],
        rationale: impactAnalysis
            ? 'remediation impact analysis did not identify a single supported semantic class'
            : 'remediation impact analysis is missing; fail closed before reuse',
        changedFiles: semanticFileScope.files,
        scopeSource: semanticFileScope.source
    };
}
