export const PUBLIC_BUNDLE_ASSETS = Object.freeze([
    'NOTICE',
    'docs/task-plan-workflow.md',
    'docs/findings-contracts.md',
    'docs/parent-task-completion.md',
    'docs/run-methods.md',
    'SECURITY.md',
    'TRADEMARKS.md',
    'docs/assets/garda-github-social-preview.png',
    'docs/architecture.md',
    'docs/branch-protection.md',
    'docs/cli-reference.md',
    'docs/compatibility-matrix.md',
    'docs/configuration.md',
    'docs/node-runtime-contract.md',
    'docs/threat-model.md',
    'docs/sbom.md',
    'docs/control-plane-isolation.md',
    'docs/database/sqlite-persistence.md',
    'docs/orchestrator-work-and-isolation.md',
    'docs/provider-client-evidence.md',
    'docs/providers.md',
    'docs/secret-scanning.md',
    'docs/operator-consistency-runbook.md',
    'docs/work-example.md'
]);

// Formerly shipped maintainer-only guides; update removes them from deployed bundles (with rollback backup).
export const RETIRED_PUBLIC_BUNDLE_ASSETS = Object.freeze([
    'CONTRIBUTING.md',
    'docs/contributor-workflow.md',
    'docs/release-readiness.md',
    'docs/node-platform-foundation.md',
    'docs/manual-ci.md',
    'docs/database/sqlite-query-adoption-evidence.md'
]);
