// Re-export manifest parsing and index loading from focused modules so
// existing consumers that import from 'runtime/skills' keep working.
export {
    BASELINE_SKILL_DIRECTORIES,
    asObjectRecord,
    normalizeStringArray,
    normalizeOptionalString,
    normalizeRequiredString,
    normalizeNonNegativeInteger,
    getPackTemplateRoot,
    readPackManifest,
    readSkillManifest,
    readBaselineSkillManifest,
    collectMissingReferenceIssues,
    listPackSkillDefinitions,
    listBuiltinSkillPacks,
    getBuiltinSkillPackDefinition
} from './skill-manifest';
export type {
    SkillPackManifestDefinition,
    SkillManifestDefinition,
    BaselineSkillManifestDefinition,
    ManifestWithReferences,
    BuiltinSkillPackDefinition
} from './skill-manifest';

export {
    SKILLS_INDEX_VERSION,
    getSkillsIndexConfigPath,
    buildSkillsIndex,
    writeSkillsIndex,
    readSkillsIndex,
    validateSkillsIndex
} from './skill-index';
export type {
    SkillsIndexPackEntry,
    SkillsIndexSkillEntry,
    SkillsIndexPayload,
    SkillsIndexData
} from './skill-index';

export {
    SKILLS_HEADLINES_VERSION,
    getSkillsHeadlinesConfigPath,
    buildSkillsHeadlines,
    computeSkillsHeadlinesSourceStateHintSha256,
    writeSkillsHeadlines,
    readSkillsHeadlines,
    readSkillsHeadlinesIfPresent,
    validateSkillsHeadlines
} from './skill-headlines';
export type {
    SkillsHeadlineSkillEntry,
    SkillsHeadlinePackEntry,
    SkillsHeadlinesPayload,
    SkillsHeadlinesData
} from './skill-headlines';

export {
    OPTIONAL_SKILL_SELECTION_POLICY_MODES,
    OPTIONAL_SKILL_AS_IS_REASONS,
    getOptionalSkillSelectionConfigPath,
    getOptionalSkillSelectionArtifactPath,
    isOptionalSkillSelectionPolicyConfigured,
    readOptionalSkillSelectionPolicyConfig,
    readOptionalSkillSelectionArtifact,
    buildOptionalSkillSelectionArtifact,
    writeOptionalSkillSelectionArtifact,
    getOptionalSkillSelectionArtifactViolations,
    getOptionalSkillSelectionGateViolations,
    readOptionalSkillSelectionTimelineEvidence,
    getCurrentCycleOptionalSkillReferenceLoads
} from './optional-skill-selection';
export type {
    OptionalSkillSelectionPolicyMode,
    OptionalSkillSelectionAsIsReason,
    OptionalSkillSelectionPolicyConfig,
    OptionalSkillSelectionArtifact,
    OptionalSkillSelectionArtifactData,
    OptionalSkillSelectionEntry,
    OptionalSkillSelectionRecommendedPack,
    OptionalSkillSelectionReferenceLoadEvidence,
    OptionalSkillSelectionTimelineEvidence
} from './optional-skill-selection';

// Re-export skill resolution (fuzzy alias, scoring, suggestion, dedupe)
// from the focused module so callers importing 'runtime/skills' keep working.
export {
    FUZZY_ALIAS_GROUPS,
    getFuzzyAliasMap,
    containsAtWordBoundary,
    getSignalFuzzyVariants,
    textMatchesFuzzyVariant,
    MATCH_CATEGORIES,
    hasDistinctSignalCoverage,
    dedupeSkillsByPack,
    suggestSkills
} from './skill-resolution';
export type {
    SignalMatches,
    SkillSuggestion
} from './skill-resolution';

// Re-export skill activation (review capabilities, installed packs CRUD,
// pack listing, add/remove, validation) from the focused module.
export {
    getSkillPacksConfigPath,
    getReviewCapabilitiesConfigPath,
    syncReviewCapabilities,
    computeReviewCapabilities,
    readInstalledSkillPacks,
    writeInstalledSkillPacks,
    listSkillPacks,
    addSkillPack,
    removeSkillPack,
    validateSkillPacks
} from './skill-activation';

// Re-export skill telemetry (event types, emit helpers, typed event
// builders) from the focused module so callers importing 'runtime/skills'
// can access telemetry without knowing the internal module layout.
export {
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
} from './skill-telemetry';
