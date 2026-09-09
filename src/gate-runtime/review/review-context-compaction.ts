export interface CompactMarkdownOptions {
    stripExamples?: boolean;
    stripCodeBlocks?: boolean;
}

export interface CompactMarkdownResult {
    content: string;
    original_line_count: number;
    output_line_count: number;
    original_char_count: number;
    output_char_count: number;
    removed_code_blocks: number;
    retained_structural_code_blocks: number;
    removed_example_sections: number;
    removed_example_labels: number;
    removed_example_content_lines: number;
}

/**
 * Classify whether the preceding context of a code block indicates
 * it is illustrative (example/demo) rather than structural (config/commands/API).
 * Returns true when the code block should be stripped.
 */
function isIllustrativeCodeBlock(outputLines: readonly string[], currentHeadingText: string | null): boolean {
    const illustrativeHeadingPattern = /\bexamples?\b/i;
    if (currentHeadingText && illustrativeHeadingPattern.test(currentHeadingText)) {
        return true;
    }

    // Scan backward through already-emitted output lines for the nearest non-blank line.
    for (let i = outputLines.length - 1; i >= 0; i--) {
        const trimmed = outputLines[i].trim();
        if (!trimmed) continue;

        // Example label right before the fence (e.g. "Bad example:", "Examples:")
        if (/^\s*(?:bad|good)?\s*examples?\s*:/i.test(trimmed)) return true;

        // Inline illustrative phrases immediately preceding the fence
        if (/\b(?:for\s+example\b|e\.g\.|such\s+as\b|like\s+so\b|for\s+instance\b)/i.test(trimmed)) return true;

        // Only inspect the nearest non-blank line
        break;
    }
    return false;
}

/**
 * Compact markdown content by stripping examples and/or code blocks.
 * When stripCodeBlocks is enabled, classification is context-aware:
 * only illustrative code blocks are removed; structural ones are retained.
 */
export function compactMarkdownContent(content: unknown, options: CompactMarkdownOptions = {}): CompactMarkdownResult {
    const stripExamples = options.stripExamples || false;
    const stripCodeBlocks = options.stripCodeBlocks || false;

    let sourceText = content == null ? '' : String(content);
    sourceText = sourceText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = sourceText.split('\n');
    const outputLines: string[] = [];
    let exampleHeadingLevel = null;
    let currentHeadingText: string | null = null;
    let insideRemovedCodeBlock = false;
    let pendingExampleLabel = false;
    let removedCodeBlocks = 0;
    let retainedStructuralCodeBlocks = 0;
    let removedExampleSections = 0;
    let removedExampleLabels = 0;
    let removedExampleContentLines = 0;
    let insertedExamplePlaceholder = false;
    let insertedCodeBlockPlaceholder = false;

    const headingPattern = /^(#{1,6})\s+(.+?)\s*$/;
    const exampleLabelPattern = /^\s*(?:bad|good)?\s*examples?\s*:\s*$/i;
    const codeFencePattern = /^\s*```/;

    function ensureBlankLine() {
        if (outputLines.length > 0 && outputLines[outputLines.length - 1] !== '') {
            outputLines.push('');
        }
    }

    function addExamplePlaceholder() {
        if (insertedExamplePlaceholder) return;
        ensureBlankLine();
        outputLines.push('> Example content omitted due to token economy.');
        insertedExamplePlaceholder = true;
    }

    function addCodeBlockPlaceholder() {
        if (insertedCodeBlockPlaceholder) return;
        ensureBlankLine();
        outputLines.push('> Code block omitted due to token economy.');
        insertedCodeBlockPlaceholder = true;
    }

    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        const headingMatch = headingPattern.exec(line);

        if (exampleHeadingLevel != null) {
            if (headingMatch && headingMatch[1].length <= exampleHeadingLevel) {
                exampleHeadingLevel = null;
                insertedExamplePlaceholder = false;
                continue; // re-process this line
            }
            removedExampleContentLines++;
            index++;
            continue;
        }

        if (insideRemovedCodeBlock) {
            if (codeFencePattern.test(line)) {
                insideRemovedCodeBlock = false;
                insertedCodeBlockPlaceholder = false;
            }
            index++;
            continue;
        }

        // Track the current heading text for context-aware classification
        if (headingMatch) {
            currentHeadingText = headingMatch[2];
        }

        if (stripExamples && headingMatch && headingMatch[2].toLowerCase().includes('example')) {
            ensureBlankLine();
            outputLines.push(line);
            outputLines.push('> Example section omitted due to token economy.');
            removedExampleSections++;
            exampleHeadingLevel = headingMatch[1].length;
            insertedExamplePlaceholder = true;
            index++;
            continue;
        }

        if (stripExamples && exampleLabelPattern.test(line)) {
            addExamplePlaceholder();
            removedExampleLabels++;
            pendingExampleLabel = true;
            index++;
            continue;
        }

        if (pendingExampleLabel) {
            if (codeFencePattern.test(line)) {
                addCodeBlockPlaceholder();
                removedCodeBlocks++;
                insideRemovedCodeBlock = true;
                pendingExampleLabel = false;
                index++;
                continue;
            }
            if (!line.trim()) {
                index++;
                continue;
            }
            if (headingMatch) {
                pendingExampleLabel = false;
                continue; // re-process
            }
            removedExampleContentLines++;
            index++;
            continue;
        }

        if (stripCodeBlocks && codeFencePattern.test(line)) {
            if (isIllustrativeCodeBlock(outputLines, currentHeadingText)) {
                addCodeBlockPlaceholder();
                removedCodeBlocks++;
                insideRemovedCodeBlock = true;
                index++;
                continue;
            }
            // Structural code block: retain it and skip through to closing fence
            retainedStructuralCodeBlocks++;
            outputLines.push(line);
            index++;
            while (index < lines.length) {
                outputLines.push(lines[index]);
                if (codeFencePattern.test(lines[index])) {
                    index++;
                    break;
                }
                index++;
            }
            continue;
        }

        outputLines.push(line);
        index++;
    }

    let sanitizedText = outputLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    if (sourceText.endsWith('\n')) {
        sanitizedText += '\n';
    }

    return {
        content: sanitizedText,
        original_line_count: lines.length,
        output_line_count: sanitizedText ? sanitizedText.split('\n').length : 0,
        original_char_count: sourceText.length,
        output_char_count: sanitizedText.length,
        removed_code_blocks: removedCodeBlocks,
        retained_structural_code_blocks: retainedStructuralCodeBlocks,
        removed_example_sections: removedExampleSections,
        removed_example_labels: removedExampleLabels,
        removed_example_content_lines: removedExampleContentLines
    };
}

/**
 * Get compact review budget, matching Python get_compact_review_budget.
 */
export function getCompactReviewBudget(failTailLines: unknown): Record<string, number> {
    let resolvedFailTailLines = 50;
    if (typeof failTailLines === 'boolean') {
        resolvedFailTailLines = 50;
    } else if (typeof failTailLines === 'number' && Number.isInteger(failTailLines)) {
        resolvedFailTailLines = failTailLines;
    } else if (failTailLines != null) {
        const parsed = parseInt(String(failTailLines).trim(), 10);
        if (!isNaN(parsed)) {
            resolvedFailTailLines = parsed;
        }
    }

    resolvedFailTailLines = Math.max(resolvedFailTailLines, 1);
    const maxLines = Math.max(120, resolvedFailTailLines + 70);
    const maxChars = Math.max(12000, maxLines * 100);
    return {
        fail_tail_lines: resolvedFailTailLines,
        max_lines: maxLines,
        max_chars: maxChars,
        max_code_fence_lines: 4,
        max_example_markers: 0
    };
}

export interface AuditReviewArtifactOptions {
    artifactPath: string;
    content: string;
    reviewContext?: Record<string, unknown>;
}

export interface AuditReviewArtifactResult {
    expected: boolean;
    token_economy_active: boolean;
    review_context_path: string | null;
    line_budget_mode: 'line_and_character' | 'character_only_for_structured_json';
    line_count: number;
    char_count: number;
    code_fence_line_count: number;
    example_marker_count: number;
    budget: ReturnType<typeof getCompactReviewBudget>;
    warnings: string[];
    warning_count: number;
}

function isStructuredJsonObject(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return false;
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
        return false;
    }
}

/**
 * Audit review artifact compaction, matching Python audit_review_artifact_compaction.
 */
export function auditReviewArtifactCompaction(options: AuditReviewArtifactOptions): AuditReviewArtifactResult {
    const artifactPath = options.artifactPath;
    const content = options.content;
    let reviewContext: Record<string, unknown> = (options.reviewContext && typeof options.reviewContext === 'object') ? options.reviewContext : {};
    const tokenEconomy = (reviewContext.token_economy && typeof reviewContext.token_economy === 'object' ? reviewContext.token_economy : {}) as Record<string, unknown>;
    const flags = (tokenEconomy.flags && typeof tokenEconomy.flags === 'object' ? tokenEconomy.flags : {}) as Record<string, unknown>;
    const tokenEconomyActive = !!(reviewContext.token_economy_active) || !!(tokenEconomy.active);
    const compactExpected = tokenEconomyActive && !!(flags.compact_reviewer_output);
    const budget = getCompactReviewBudget(flags.fail_tail_lines);
    const structuredJsonObject = isStructuredJsonObject(content);

    const lines = content.split('\n');
    const codeFenceLines = lines.filter(line => /^\s*```/.test(line)).length;
    const exampleMarkerLines = lines.filter(
        line => /^\s*(?:#{1,6}\s+.*example.*|(?:bad|good)?\s*examples?\s*:)\s*$/i.test(line)
    ).length;

    const warnings: string[] = [];
    if (compactExpected) {
        if (!structuredJsonObject && lines.length > budget.max_lines) {
            warnings.push(
                `Review artifact '${String(artifactPath).replace(/\\/g, '/')}' exceeds compact line budget (${lines.length} > ${budget.max_lines}).`
            );
        }
        if (content.length > budget.max_chars) {
            warnings.push(
                `Review artifact '${String(artifactPath).replace(/\\/g, '/')}' exceeds compact char budget (${content.length} > ${budget.max_chars}).`
            );
        }
        if (codeFenceLines > budget.max_code_fence_lines) {
            warnings.push(
                `Review artifact '${String(artifactPath).replace(/\\/g, '/')}' exceeds code-fence budget (${codeFenceLines} > ${budget.max_code_fence_lines}).`
            );
        }
        if (flags.strip_examples && exampleMarkerLines > budget.max_example_markers) {
            warnings.push(
                `Review artifact '${String(artifactPath).replace(/\\/g, '/')}' still contains example markers while strip_examples=true.`
            );
        }
    }

    return {
        expected: compactExpected,
        token_economy_active: tokenEconomyActive,
        review_context_path: reviewContext.output_path
            ? String(reviewContext.output_path).replace(/\\/g, '/')
            : null,
        line_budget_mode: structuredJsonObject
            ? 'character_only_for_structured_json'
            : 'line_and_character',
        line_count: lines.length,
        char_count: content.length,
        code_fence_line_count: codeFenceLines,
        example_marker_count: exampleMarkerLines,
        budget: budget,
        warnings: warnings,
        warning_count: warnings.length
    };
}
