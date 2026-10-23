import { UNTRACKED_BUILD_OUTPUT_CONFIG_KEY } from '../core/build-output-paths';
/**
 * Stack-neutral default path patterns shared by classification defaults,
 * review-trigger policy and the materialized `live/config/paths.json` template.
 *
 * All patterns are evaluated case-insensitively. Test patterns therefore rely on
 * separators and directory conventions, never bare `Test` suffixes: a pattern such
 * as `Test\.java$` would also classify production `Contest.java` as test-only scope
 * and suppress its domain reviews.
 */

/** Source extensions across common ecosystems, used by domain trigger patterns. */
export const CODE_EXTENSION_GROUP = '(?:java|kt|kts|groovy|scala|sc|clj|cljs|cljc|ts|tsx|js|jsx|cjs|mjs|vue|svelte'
    + '|cs|fs|vb|go|py|rb|php|rs|swift|m|mm|c|cc|cpp|cxx|h|hh|hpp|hxx|ex|exs|erl|hrl|dart|lua|hs|ml|mli'
    + '|jl|r|nim|zig|cr|pl|pm|sh|bash|ps1|psm1)';

/** Conventional production source roots across ecosystems (Go `cmd/internal/pkg`, Swift `Sources`, Rust `crates`, Ruby/Elixir `lib`). */
export const DEFAULT_RUNTIME_ROOTS: readonly string[] = Object.freeze([
    'src/', 'app/', 'apps/', 'backend/', 'frontend/', 'web/', 'api/', 'services/', 'packages/',
    'lib/', 'cmd/', 'internal/', 'pkg/', 'Sources/', 'crates/'
]);

export const DEFAULT_CODE_LIKE_REGEXES: readonly string[] = Object.freeze([
    `\\.${CODE_EXTENSION_GROUP}$`
]);

export const DEFAULT_TEST_PATH_REGEXES: readonly string[] = Object.freeze([
    '/src/test/',
    '(^|/)(__tests__|tests?)/',
    // Kotlin multiplatform, Android and Gradle source sets.
    '(^|/)src/(?:common|jvm|js|native|android|androidUnit|androidInstrumented|ios|desktop|wasmJs|wasmWasi|integration|functional|unit)Test/',
    // .NET test projects such as `Billing.Tests/` or `Billing.IntegrationTests/`.
    '(^|/)[^/]+\\.(?:unit|integration|functional|acceptance|component|e2e)?tests?/',
    '(^|/)e2e/',
    // Source extensions only: `feature.spec.md` stays documentation.
    `\\.(spec|test)\\.${CODE_EXTENSION_GROUP}$`,
    '_test\\.(?:go|py|exs|dart|cc|cpp|cxx|c|lua|cr|nim|zig|jl)$',
    '_unittest\\.(?:cc|cpp|cxx|c)$',
    '_spec\\.(?:rb|lua|cr|exs|js|ts)$',
    '(^|/)test_[^/]+\\.py$',
    '(^|/)t/[^/]+\\.t$',
    '\\.tests\\.ps1$',
    '_SUITE\\.erl$'
]);

export const DEFAULT_REFACTOR_PATH_REGEXES: readonly string[] = Object.freeze([
    `(Config|Settings|Options|Schema|Contract|Dto|DTO)[^/]*\\.(?:${CODE_EXTENSION_GROUP.slice(3, -1)}|json|ya?ml|toml|xml)$`,
    '(^|/)(config|configs?|schemas?|contracts?)(/|$)',
    '(^|/)[^/]*(config|settings|paths)[^/]*\\.(json|ya?ml|toml|xml)$'
]);

/** Weak database signal: only escalates with project database evidence. */
export const DEFAULT_DB_WEAK_SIGNAL_REGEX = `(Repository|Dao|Specification|Query|Migration)[^/]*\\.${CODE_EXTENSION_GROUP}$`;
/** Ambient database signal: ORM or migration tool names anywhere in the path. */
// Substrings must stay distinctive: short names such as `ecto` also occur in `vector` or `connector`.
export const DEFAULT_DB_AMBIENT_SIGNAL_REGEX = '(typeorm|prisma|flyway|liquibase|alembic|knex|sequelize|sqlalchemy|hibernate|entityframework|dbcontext|activerecord|doctrine)';

export const DEFAULT_DB_TRIGGER_REGEXES: readonly string[] = Object.freeze([
    '(^|/)(db|database|migrations?|schema)(/|$)',
    '\\.sql$',
    DEFAULT_DB_WEAK_SIGNAL_REGEX,
    DEFAULT_DB_AMBIENT_SIGNAL_REGEX
]);

export const DEFAULT_API_TRIGGER_REGEXES: readonly string[] = Object.freeze([
    '(^|/)(controllers?|routes?|handlers?|endpoints?|graphql)(/|\\.|$)',
    `(Controller|Handler|Endpoint|Router|Routes)[^/]*\\.${CODE_EXTENSION_GROUP}$`,
    `(Request|Response|Dto|DTO|Contract|Schema)[^/]*\\.${CODE_EXTENSION_GROUP}$`,
    '(^|/)(openapi|swagger)\\.(ya?ml|json)$',
    '\\.(proto|graphqls?|avsc|thrift)$'
]);

/** Container, CI and infrastructure-as-code surfaces across common providers. */
export const DEFAULT_INFRA_TRIGGER_REGEXES: readonly string[] = Object.freeze([
    '(^|/)Dockerfile(\\..+)?$',
    '(^|/)docker-compose(\\.[^/]+)?\\.ya?ml$',
    '(^|/)(terraform|infra|infrastructure|helm|k8s|kubernetes)(/|$)',
    '(^|/)\\.github/workflows/',
    '(^|/)\\.gitlab-ci\\.ya?ml$',
    '(^|/)Jenkinsfile(\\.[^/]+)?$',
    '(^|/)azure-pipelines(\\.[^/]+)?\\.ya?ml$',
    '(^|/)bitbucket-pipelines\\.ya?ml$',
    '(^|/)\\.(circleci|buildkite|woodpecker)/',
    '(^|/)\\.drone\\.ya?ml$',
    '\\.(tf|tfvars|hcl)$',
    '(^|/)(Chart|kustomization)\\.ya?ml$'
]);

export const DEFAULT_PERFORMANCE_TRIGGER_REGEXES: readonly string[] = Object.freeze([
    `(Cache|Redis|Elasticsearch|Search|Query|Benchmark|Profiling)[^/]*\\.${CODE_EXTENSION_GROUP}$`,
    '(^|/)(performance|perf|benchmarks?|benches)/'
]);

/** Dependency manifests, lockfiles and toolchain pins across ecosystems. */
export const DEFAULT_DEPENDENCY_TRIGGER_REGEXES: readonly string[] = Object.freeze([
    // JVM: Maven, Gradle, sbt.
    '(^|/)pom\\.xml$',
    '(^|/)build\\.gradle(\\.kts)?$',
    '(^|/)settings\\.gradle(\\.kts)?$',
    '(^|/)gradle/[^/]*\\.versions\\.toml$',
    '(^|/)gradle\\.lockfile$',
    '(^|/)build\\.sbt$',
    '(^|/)project/(?:plugins|build)\\.sbt$',
    // JavaScript runtimes and package managers.
    '(^|/)package\\.json$',
    '(^|/)(?:package-lock|npm-shrinkwrap)\\.json$',
    '(^|/)pnpm-(?:lock|workspace)\\.yaml$',
    '(^|/)yarn\\.lock$',
    '(^|/)\\.yarnrc\\.yml$',
    '(^|/)bun\\.lockb?$',
    '(^|/)deno\\.(?:jsonc?|lock)$',
    // Python.
    '(^|/)requirements[^/]*\\.(?:txt|in)$',
    '(^|/)constraints[^/]*\\.txt$',
    '(^|/)(?:poetry|uv|pdm)\\.lock$',
    '(^|/)Pipfile(\\.lock)?$',
    '(^|/)pyproject\\.toml$',
    '(^|/)setup\\.(?:py|cfg)$',
    '(^|/)(?:environment|conda-lock)\\.ya?ml$',
    // Go, Rust, Zig, Nim, Crystal.
    '(^|/)go\\.(?:mod|sum|work|work\\.sum)$',
    '(^|/)Cargo\\.(?:toml|lock)$',
    '(^|/)rust-toolchain(\\.toml)?$',
    '(^|/)build\\.zig\\.zon$',
    '\\.nimble$',
    '(^|/)shard\\.(?:yml|lock)$',
    // PHP, Ruby, Perl, Lua.
    '(^|/)composer\\.(?:json|lock)$',
    '(^|/)Gemfile(\\.lock)?$',
    '\\.gemspec$',
    '(^|/)cpanfile(\\.snapshot)?$',
    '\\.rockspec$',
    // .NET.
    '\\.(?:csproj|fsproj|vbproj|sln|slnx)$',
    '(^|/)Directory\\.(?:Packages|Build)\\.(?:props|targets)$',
    '(^|/)(?:packages\\.config|packages\\.lock\\.json|global\\.json|nuget\\.config)$',
    // Apple platforms and Dart/Flutter.
    '(^|/)Package\\.(?:swift|resolved)$',
    '(^|/)Podfile(\\.lock)?$',
    '(^|/)Cartfile(\\.resolved)?$',
    '(^|/)pubspec\\.(?:yaml|lock)$',
    // Elixir, Erlang, Haskell, OCaml, Clojure, Elm, Julia, R.
    '(^|/)mix\\.(?:exs|lock)$',
    '(^|/)rebar\\.(?:config|lock)$',
    '\\.cabal$',
    '(^|/)cabal\\.project(\\.freeze)?$',
    '(^|/)stack\\.yaml(\\.lock)?$',
    '\\.opam$',
    '(^|/)dune-project$',
    '(^|/)(?:deps\\.edn|project\\.clj)$',
    '(^|/)elm\\.json$',
    '(^|/)(?:Project|Manifest)\\.toml$',
    '(^|/)renv\\.lock$',
    // C and C++ package and build manifests.
    '(^|/)CMakeLists\\.txt$',
    '(^|/)conanfile\\.(?:txt|py)$',
    '(^|/)vcpkg(?:-configuration)?\\.json$',
    '(^|/)meson\\.build$',
    '(^|/)(?:MODULE\\.bazel|WORKSPACE(?:\\.bazel)?)(\\.lock)?$',
    // Nix.
    '(^|/)flake\\.(?:nix|lock)$'
]);

/**
 * Managed defaults shipped before stack-neutral patterns. An update replaces a
 * materialized value only when it still equals one of these exact arrays, so
 * project-owned customizations are never rewritten.
 */
export const LEGACY_MANAGED_PATH_REGEX_DEFAULTS: Readonly<Record<string, readonly (readonly string[])[]>> = Object.freeze({
    runtime_roots: [['src/', 'app/', 'apps/', 'backend/', 'frontend/', 'web/', 'api/', 'services/', 'packages/']],
    code_like_regexes: [['\\.(java|kt|kts|groovy|ts|tsx|js|jsx|cjs|mjs|cs|go|py|rb|php|rs)$']],
    'triggers.test': [[
        '/src/test/',
        '(^|/)(__tests__|tests?)/',
        '\\.(spec|test)\\.(ts|tsx|js|jsx|java|kt|go|py|rb|php)$'
    ]],
    'triggers.refactor': [[
        '(Config|Settings|Options|Schema|Contract|Dto|DTO)[^/]*\\.(java|kt|ts|tsx|js|jsx|py|go|cs|rb|php|json|ya?ml|toml|xml)$',
        '(^|/)(config|configs?|schemas?|contracts?)(/|$)',
        '(^|/)[^/]*(config|settings|paths)[^/]*\\.(json|ya?ml|toml|xml)$'
    ]],
    'triggers.db': [[
        '(^|/)(db|database|migrations?|schema)(/|$)',
        '\\.sql$',
        '(Repository|Dao|Specification|Query|Migration)[^/]*\\.(java|kt|ts|js|py|go|cs|rb|php)$',
        '(typeorm|prisma|flyway|liquibase|alembic|knex|sequelize)'
    ]],
    'triggers.api': [[
        '(^|/)(controllers?|routes?|handlers?|endpoints?|graphql)(/|\\.|$)',
        '(Request|Response|Dto|DTO|Contract|Schema)[^/]*\\.(java|kt|ts|tsx|js|jsx|py|go|cs|rb|php)$',
        '(^|/)(openapi|swagger)\\.(ya?ml|json)$'
    ]],
    'triggers.performance': [[
        '(Cache|Redis|Elasticsearch|Search|Query|Benchmark|Profiling)[^/]*\\.(java|kt|ts|js|py|go|cs|rb|php)$',
        '(^|/)(performance|perf|benchmark)/'
    ]],
    'triggers.infra': [[
        '(^|/)Dockerfile(\\..+)?$',
        '(^|/)docker-compose(\\.[^/]+)?\\.ya?ml$',
        '(^|/)(terraform|infra|infrastructure|helm|k8s|kubernetes)(/|$)',
        '(^|/)\\.github/workflows/'
    ]],
    'triggers.dependency': [[
        '(^|/)pom\\.xml$',
        '(^|/)build\\.gradle(\\.kts)?$',
        '(^|/)settings\\.gradle(\\.kts)?$',
        '(^|/)package\\.json$',
        '(^|/)package-lock\\.json$',
        '(^|/)pnpm-lock\\.yaml$',
        '(^|/)yarn\\.lock$',
        '(^|/)requirements(\\.txt|-dev\\.txt)?$',
        '(^|/)poetry\\.lock$',
        '(^|/)pyproject\\.toml$',
        '(^|/)go\\.mod$',
        '(^|/)go\\.sum$',
        '(^|/)Cargo\\.toml$',
        '(^|/)Cargo\\.lock$',
        '(^|/)composer\\.json$',
        '(^|/)Gemfile(\\.lock)?$'
    ]]
});

function readPath(record: Record<string, unknown>, dottedKey: string): unknown {
    return dottedKey.split('.').reduce<unknown>((value, key) => (
        value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined
    ), record);
}

function writePath(record: Record<string, unknown>, dottedKey: string, value: unknown): void {
    const keys = dottedKey.split('.');
    let target: Record<string, unknown> = record;
    for (const key of keys.slice(0, -1)) {
        const next = target[key];
        if (!next || typeof next !== 'object' || Array.isArray(next)) return;
        target = next as Record<string, unknown>;
    }
    target[keys[keys.length - 1]] = value;
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
    return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

/**
 * Upgrade managed path patterns that a project never customized. Returns the
 * dotted keys that were replaced with the current template value.
 */
export function migrateLegacyManagedPathRegexes(
    merged: Record<string, unknown>,
    template: Record<string, unknown>
): string[] {
    const migrated: string[] = [];
    if (merged[UNTRACKED_BUILD_OUTPUT_CONFIG_KEY] === undefined && Array.isArray(template[UNTRACKED_BUILD_OUTPUT_CONFIG_KEY])) {
        merged[UNTRACKED_BUILD_OUTPUT_CONFIG_KEY] = [...template[UNTRACKED_BUILD_OUTPUT_CONFIG_KEY]];
        migrated.push(UNTRACKED_BUILD_OUTPUT_CONFIG_KEY);
    }
    // File-name word triggers (security and db) arrived in 1.4.4; workspaces without them get the template list.
    const nameTokensKey = 'trigger_name_tokens';
    const templateNameTokens = template[nameTokensKey];
    if (merged[nameTokensKey] === undefined && templateNameTokens && typeof templateNameTokens === 'object' && !Array.isArray(templateNameTokens)) {
        merged[nameTokensKey] = JSON.parse(JSON.stringify(templateNameTokens));
        migrated.push(nameTokensKey);
    }
    for (const [dottedKey, legacyValues] of Object.entries(LEGACY_MANAGED_PATH_REGEX_DEFAULTS)) {
        const current = readPath(merged, dottedKey);
        const templateValue = readPath(template, dottedKey);
        if (!Array.isArray(templateValue) || !legacyValues.some(legacy => sameStringArray(current, legacy))) continue;
        writePath(merged, dottedKey, [...templateValue]);
        migrated.push(dottedKey);
    }
    return migrated;
}
