import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';
import { matchAnyRegex } from '../../../src/gate-runtime/text-utils';
import {
    DEFAULT_API_TRIGGER_REGEXES,
    DEFAULT_CODE_LIKE_REGEXES,
    DEFAULT_DB_TRIGGER_REGEXES,
    DEFAULT_DEPENDENCY_TRIGGER_REGEXES,
    DEFAULT_PERFORMANCE_TRIGGER_REGEXES,
    DEFAULT_REFACTOR_PATH_REGEXES,
    DEFAULT_RUNTIME_ROOTS,
    DEFAULT_TEST_PATH_REGEXES,
    LEGACY_MANAGED_PATH_REGEX_DEFAULTS,
    migrateLegacyManagedPathRegexes
} from '../../../src/policy/default-path-regexes';

const matches = (file: string, regexes: readonly string[]): boolean => matchAnyRegex(file, [...regexes], {
    skipInvalidRegex: false,
    caseInsensitive: true
});

test('default test patterns recognize test conventions across ecosystems', () => {
    for (const file of [
        'pkg/billing/invoice_test.go', 'spec/models/user_spec.rb', 'tests/test_api.py', 'app/test_models.py',
        'billing/invoice_test.py', 'test/billing_test.exs', 'test/widget_test.dart', 'src/test/scala/FooSpec.scala',
        'Tests/AppTests/FooTests.swift', 'Billing.Tests/InvoiceTests.cs', 'Billing.IntegrationTests/Flow.cs',
        'src/commonTest/kotlin/FooTest.kt', 'src/androidInstrumentedTest/java/FooTest.java', 't/basic.t',
        'scripts/Install.Tests.ps1', 'src/parser_unittest.cc', 'src/a.test.ts', 'src/a.spec.jsx', 'e2e/login.ts',
        'apps/server/test/billing_SUITE.erl', 'spec/parser_spec.lua'
    ]) {
        assert.equal(matches(file, DEFAULT_TEST_PATH_REGEXES), true, file);
    }
});

test('default test patterns do not downgrade production code that merely contains test words', () => {
    for (const file of [
        'src/main/java/app/Contest.java', 'src/Latest.cs', 'src/latest/view.ts', 'lib/protest.ex',
        'src/attestation.rs', 'Sources/App/LatestFeed.swift', 'docs/feature.spec.md', 'src/lib.rs',
        'app/models/ab_testing.rb', 'cmd/contest/main.go', 'src/manifest.json'
    ]) {
        assert.equal(matches(file, DEFAULT_TEST_PATH_REGEXES), false, file);
    }
});

test('default dependency patterns cover manifests and lockfiles of common ecosystems', () => {
    for (const file of [
        'package.json', 'pnpm-lock.yaml', 'bun.lockb', 'deno.json', 'pom.xml', 'gradle/libs.versions.toml',
        'build.sbt', 'requirements-dev.txt', 'uv.lock', 'Pipfile.lock', 'setup.py', 'go.work', 'Cargo.lock',
        'composer.lock', 'app.gemspec', 'src/App/App.csproj', 'Directory.Packages.props', 'packages.lock.json',
        'Package.swift', 'Package.resolved', 'Podfile.lock', 'pubspec.yaml', 'mix.lock', 'rebar.config',
        'app.cabal', 'stack.yaml', 'deps.edn', 'Project.toml', 'renv.lock', 'CMakeLists.txt', 'vcpkg.json',
        'conanfile.txt', 'MODULE.bazel', 'build.zig.zon', 'flake.lock', 'services/api/go.mod'
    ]) {
        assert.equal(matches(file, DEFAULT_DEPENDENCY_TRIGGER_REGEXES), true, file);
    }
    for (const file of ['src/package.ts', 'docs/dependencies.md', 'src/Podfile.swift']) {
        assert.equal(matches(file, DEFAULT_DEPENDENCY_TRIGGER_REGEXES), false, file);
    }
});

test('domain triggers apply to source files of any common language without generic substring noise', () => {
    assert.equal(matches('lib/app/user_repository.ex', DEFAULT_DB_TRIGGER_REGEXES), true);
    assert.equal(matches('Sources/App/UserRepository.swift', DEFAULT_DB_TRIGGER_REGEXES), true);
    assert.equal(matches('src/vector_connector.rs', DEFAULT_DB_TRIGGER_REGEXES), false);
    assert.equal(matches('src/reporter.go', DEFAULT_DB_TRIGGER_REGEXES), false);
    assert.equal(matches('lib/web/user_controller.ex', DEFAULT_API_TRIGGER_REGEXES), true);
    assert.equal(matches('src/main/scala/UserDto.scala', DEFAULT_API_TRIGGER_REGEXES), true);
    assert.equal(matches('proto/billing.proto', DEFAULT_API_TRIGGER_REGEXES), true);
    assert.equal(matches('src/SearchIndex.dart', DEFAULT_PERFORMANCE_TRIGGER_REGEXES), true);
    assert.equal(matches('src/AppConfig.swift', DEFAULT_REFACTOR_PATH_REGEXES), true);
    for (const file of ['lib/x.ex', 'Sources/App/main.swift', 'src/main.c', 'include/a.hpp', 'lib/main.dart', 'src/lib.zig']) {
        assert.equal(matches(file, DEFAULT_CODE_LIKE_REGEXES), true, file);
    }
});

test('materialized paths template matches the shared stack-neutral defaults', () => {
    const template = JSON.parse(fs.readFileSync(path.join(getRepoRoot(), 'template', 'config', 'paths.json'), 'utf8'));
    assert.deepEqual(template.runtime_roots, DEFAULT_RUNTIME_ROOTS);
    assert.deepEqual(template.code_like_regexes, DEFAULT_CODE_LIKE_REGEXES);
    assert.deepEqual(template.triggers.test, DEFAULT_TEST_PATH_REGEXES);
    assert.deepEqual(template.triggers.refactor, DEFAULT_REFACTOR_PATH_REGEXES);
    assert.deepEqual(template.triggers.db, DEFAULT_DB_TRIGGER_REGEXES);
    assert.deepEqual(template.triggers.api, DEFAULT_API_TRIGGER_REGEXES);
    assert.deepEqual(template.triggers.dependency, DEFAULT_DEPENDENCY_TRIGGER_REGEXES);
    assert.deepEqual(template.triggers.performance, DEFAULT_PERFORMANCE_TRIGGER_REGEXES);
});

test('update migrates only uncustomized legacy managed path patterns', () => {
    const template = JSON.parse(fs.readFileSync(path.join(getRepoRoot(), 'template', 'config', 'paths.json'), 'utf8'));
    const customTest = ['(^|/)quality/'];
    const merged = {
        runtime_roots: [...LEGACY_MANAGED_PATH_REGEX_DEFAULTS.runtime_roots[0]],
        code_like_regexes: [...LEGACY_MANAGED_PATH_REGEX_DEFAULTS.code_like_regexes[0]],
        triggers: {
            dependency: [...LEGACY_MANAGED_PATH_REGEX_DEFAULTS['triggers.dependency'][0]],
            test: customTest,
            db: [...LEGACY_MANAGED_PATH_REGEX_DEFAULTS['triggers.db'][0], '(^|/)custom-db/']
        }
    };
    const migrated = migrateLegacyManagedPathRegexes(merged, template);
    assert.deepEqual(migrated.sort(), ['code_like_regexes', 'runtime_roots', 'triggers.dependency', 'untracked_build_output_regexes']);
    assert.deepEqual((merged as Record<string, unknown>).untracked_build_output_regexes, template.untracked_build_output_regexes);
    assert.deepEqual(merged.runtime_roots, DEFAULT_RUNTIME_ROOTS);
    assert.deepEqual(merged.code_like_regexes, DEFAULT_CODE_LIKE_REGEXES);
    assert.deepEqual(merged.triggers.dependency, DEFAULT_DEPENDENCY_TRIGGER_REGEXES);
    assert.equal(merged.triggers.test, customTest);
    assert.equal(merged.triggers.db.at(-1), '(^|/)custom-db/');
});
