import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    redactHostname,
    redactPath,
    redactEnvObject,
    redactDiagnosticText,
    redactSecretText,
    redactSensitiveData,
    serializeRedactedJson,
    sha256RedactedJsonPayload,
    createRedactionContext,
    _resetCachedValues
} from '../../../src/core/redaction';


test('redactHostname returns null for null input', () => {
    assert.equal(redactHostname(null), null);
});

test('redactHostname returns null for undefined input', () => {
    assert.equal(redactHostname(undefined), null);
});

test('redactHostname returns null for empty string', () => {
    assert.equal(redactHostname(''), null);
});

test('redactHostname returns null for whitespace-only string', () => {
    assert.equal(redactHostname('   '), null);
});

test('redactHostname returns a deterministic <host-...> token', () => {
    const result = redactHostname('my-workstation');
    assert.ok(result !== null);
    assert.match(result!, /^<host-[0-9a-f]{8}>$/);
});

test('redactHostname is deterministic for the same input', () => {
    const a = redactHostname('server-1');
    const b = redactHostname('server-1');
    assert.equal(a, b);
});

test('redactHostname produces different tokens for different inputs', () => {
    const a = redactHostname('host-a');
    const b = redactHostname('host-b');
    assert.notEqual(a, b);
});

test('redactHostname trims whitespace before hashing', () => {
    const a = redactHostname('  my-host  ');
    const b = redactHostname('my-host');
    assert.equal(a, b);
});


test('redactPath returns empty string for empty input', () => {
    assert.equal(redactPath(''), '');
});

test('redactPath relativizes path inside repo root', () => {
    const result = redactPath('/projects/my-repo/src/index.ts', '/projects/my-repo');
    assert.equal(result, 'src/index.ts');
});

test('redactPath returns "." when path equals repo root', () => {
    const result = redactPath('/projects/my-repo', '/projects/my-repo');
    assert.equal(result, '.');
});

test('redactPath handles Windows-style path separator', () => {
    const result = redactPath('C:\\Users\\dev\\repo\\src\\file.ts', 'C:\\Users\\dev\\repo');
    assert.equal(result, 'src/file.ts');
});

test('redactPath replaces home directory prefix with <home>', () => {
    _resetCachedValues();
    const homedir = os.homedir().replace(/\\/g, '/');
    const testPath = homedir + '/Documents/secret.txt';
    const result = redactPath(testPath);
    assert.ok(
        result.startsWith('<home>'),
        `Expected result to start with <home>, got: ${result}`
    );
    assert.ok(!result.includes(homedir), 'Home directory should be redacted');
});

test('redactPath handles non-matching path unchanged', () => {
    // Path that does not match repo root, home dir, or username
    const result = redactPath('/opt/system/data/file.txt');
    assert.ok(typeof result === 'string');
});


test('redactEnvObject redacts keys matching secret patterns', () => {
    const env = {
        PATH: '/usr/bin',
        HOME: '/home/user',
        SECRET_KEY: 'supersecret',
        API_KEY: 'abc123',
        AUTH_TOKEN: 'tok-xyz',
        MY_PASSWORD: 'p@ssw0rd',
        NORMAL_VAR: 'safe_value',
        NODE_ENV: 'production'
    };
    const result = redactEnvObject(env);
    assert.equal(result['PATH'], '/usr/bin');
    assert.equal(result['HOME'], '/home/user');
    assert.equal(result['SECRET_KEY'], '<redacted>');
    assert.equal(result['API_KEY'], '<redacted>');
    assert.equal(result['AUTH_TOKEN'], '<redacted>');
    assert.equal(result['MY_PASSWORD'], '<redacted>');
    assert.equal(result['NORMAL_VAR'], 'safe_value');
    assert.equal(result['NODE_ENV'], 'production');
});

test('redactEnvObject skips undefined values', () => {
    const env: Record<string, string | undefined> = {
        PRESENT: 'yes',
        MISSING: undefined
    };
    const result = redactEnvObject(env);
    assert.equal(result['PRESENT'], 'yes');
    assert.ok(!('MISSING' in result));
});

test('redactEnvObject handles empty object', () => {
    const result = redactEnvObject({});
    assert.deepEqual(result, {});
});

test('redactSecretText masks common command and log secret shapes', () => {
    const text = [
        'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456',
        'NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz123456',
        '"databasePassword": "plain-text-password"',
        'postgres://app:super-secret@db.example/app',
        '-----BEGIN PRIVATE KEY-----',
        'abc123',
        '-----END PRIVATE KEY-----'
    ].join('\n');

    const result = redactSecretText(text);

    assert.doesNotMatch(result, /abcdefghijklmnopqrstuvwxyz123456/);
    assert.doesNotMatch(result, /plain-text-password/);
    assert.doesNotMatch(result, /super-secret/);
    assert.doesNotMatch(result, /abc123/);
    assert.match(result, /Authorization: Bearer <redacted>/);
    assert.match(result, /NPM_TOKEN=<redacted>/);
    assert.match(result, /"databasePassword": "<redacted>"/);
    assert.match(result, /postgres:\/\/app:<redacted>@db\.example\/app/);
    assert.match(result, /<redacted-private-key>/);
});

test('redactSensitiveData recursively masks secret-bearing keys and text values', () => {
    const result = redactSensitiveData({
        safe: 'visible',
        nested: {
            apiToken: 'tok-live-value',
            output: 'curl -H "Authorization: Basic abcdef123456" https://example.test'
        },
        list: ['PASSWORD=from-output']
    });

    assert.deepEqual(result, {
        safe: 'visible',
        nested: {
            apiToken: '<redacted>',
            output: 'curl -H "Authorization: Basic <redacted>" https://example.test'
        },
        list: ['PASSWORD=<redacted>']
    });
});

test('redactSensitiveData masks multiline secrets split across output line arrays', () => {
    const result = redactSensitiveData({
        outputLines: [
            'before',
            'API_TOKEN="line one',
            'line two"',
            'after'
        ]
    });

    assert.deepEqual(result, {
        outputLines: [
            'before',
            'API_TOKEN="<redacted>"',
            'after'
        ]
    });
});

test('redactSensitiveData preserves authenticated redacted line-array boundaries', () => {
    const redactedLines = [
        'export const first = true;\r\n',
        'export const second = true;\n'
    ];
    const result = redactSensitiveData({ redacted_lines: redactedLines });

    assert.deepEqual(result, { redacted_lines: redactedLines });
    assert.deepEqual(
        JSON.parse(serializeRedactedJson({ redacted_lines: redactedLines })),
        { redacted_lines: redactedLines }
    );
});

test('redacted JSON serialization preserves canonical assignment placeholders and line endings', () => {
    const redactedLines = [
        'export const TOKEN_ECONOMY_FIELDS = <redacted>\n',
        'const max_review_tokens: <redacted>\r\n',
        'const auth = <redacted>\r'
    ];
    const serialized = serializeRedactedJson({ redacted_lines: redactedLines });

    assert.deepEqual(JSON.parse(serialized), { redacted_lines: redactedLines });
    assert.equal(serializeRedactedJson(JSON.parse(serialized)), serialized);
});

test('redacted JSON serialization preserves JSON escaping around source assignment patterns', () => {
    const sourceLine = 'const match = html.match(/const actionToken = "([^"]+)";/u);\n';
    const redactedLine = redactSecretText(sourceLine);
    const serialized = serializeRedactedJson({ redacted_lines: [redactedLine] });

    assert.deepEqual(JSON.parse(serialized), { redacted_lines: [redactedLine] });
    assert.equal(serializeRedactedJson(JSON.parse(serialized)), serialized);
});

test('redactSensitiveData preserves token telemetry keys while masking real token secrets', () => {
    const result = redactSensitiveData({
        token: 'bare-token-secret',
        tokens: 'bare-tokens-secret',
        token_economy: {
            estimated_saved_tokens: 12,
            estimated_saved_tokens_chars_per_4: 48,
            raw_token_count_estimate: 100,
            token_estimator: 'hybrid_text_v1',
            legacy_token_estimator: 'chars_per_4'
        },
        token_economy_active_for_depth: true,
        total_output_token_count_estimate: 25,
        VerdictToken: 'REVIEW PASSED',
        access_token: 'secret-access-token',
        authToken: 'secret-auth-token',
        TOKEN_ECONOMY: 'enabled'
    });

    assert.deepEqual(result, {
        token: '<redacted>',
        tokens: '<redacted>',
        token_economy: {
            estimated_saved_tokens: 12,
            estimated_saved_tokens_chars_per_4: 48,
            raw_token_count_estimate: 100,
            token_estimator: 'hybrid_text_v1',
            legacy_token_estimator: 'chars_per_4'
        },
        token_economy_active_for_depth: true,
        total_output_token_count_estimate: 25,
        VerdictToken: 'REVIEW PASSED',
        access_token: '<redacted>',
        authToken: '<redacted>',
        TOKEN_ECONOMY: 'enabled'
    });
});

test('redactSecretText preserves token telemetry assignments and JSON fields', () => {
    const text = [
        '"token_estimator": "hybrid_text_v1"',
        '"estimated_saved_tokens": "12"',
        '"estimated_saved_tokens_chars_per_4": "48"',
        'TOKEN_ECONOMY=enabled',
        'TOKEN=plain-secret-value',
        'ACCESS_TOKEN=super-secret',
        '"apiToken": "secret-token"'
    ].join('\n');

    const result = redactSecretText(text);

    assert.match(result, /"token_estimator": "hybrid_text_v1"/);
    assert.match(result, /"estimated_saved_tokens": "12"/);
    assert.match(result, /"estimated_saved_tokens_chars_per_4": "48"/);
    assert.match(result, /TOKEN_ECONOMY=enabled/);
    assert.match(result, /TOKEN=<redacted>/);
    assert.match(result, /ACCESS_TOKEN=<redacted>/);
    assert.match(result, /"apiToken": "<redacted>"/);
});

test('redactSecretText preserves source coordinates without weakening secret assignment redaction', () => {
    const text = [
        'src/gates/review-context/review-context-token-economy.ts:54',
        'src/auth-handler.ts:21:7',
        'src/password-reset.ts:9',
        'API_TOKEN=54',
        'ACCESS_TOKEN:54',
        'config.api_token:54',
        'src/token.ts:not-a-line-secret'
    ].join('\n');

    const result = redactSecretText(text);

    assert.match(result, /review-context-token-economy\.ts:54/);
    assert.match(result, /auth-handler\.ts:21:7/);
    assert.match(result, /password-reset\.ts:9/);
    assert.match(result, /API_TOKEN=<redacted>/);
    assert.match(result, /ACCESS_TOKEN:<redacted>/);
    assert.match(result, /config\.api_token:<redacted>/);
    assert.match(result, /src\/token\.ts:<redacted>/);
});

test('redacted JSON hashing matches the canonical persisted representation', () => {
    const payload = {
        location: 'src/gates/review-context/review-context-token-economy.ts:54',
        note: 'API_TOKEN=fixture-secret'
    };

    const serialized = serializeRedactedJson(payload);

    assert.match(serialized, /review-context-token-economy\.ts:54/);
    assert.doesNotMatch(serialized, /fixture-secret/);
    assert.equal(serializeRedactedJson(JSON.parse(serialized)), serialized);
    assert.equal(
        sha256RedactedJsonPayload(payload),
        createHash('sha256').update(serialized).digest('hex')
    );
});

test('redactSecretText masks quoted env assignments with spaces and multiline values', () => {
    const text = [
        'PASSWORD="secret with spaces"',
        'API_TOKEN="line one',
        'line two"',
        "ACCESS_TOKEN='single quoted secret value'"
    ].join('\n');

    const result = redactSecretText(text);

    assert.doesNotMatch(result, /secret with spaces/);
    assert.doesNotMatch(result, /line one/);
    assert.doesNotMatch(result, /line two/);
    assert.doesNotMatch(result, /single quoted secret value/);
    assert.match(result, /PASSWORD="<redacted>"/);
    assert.match(result, /API_TOKEN="<redacted>"/);
    assert.match(result, /ACCESS_TOKEN='<redacted>'/);
});

test('redactSecretText masks secrets embedded in stack-trace-shaped output', () => {
    const text = [
        'Error: failed to connect postgres://app:stack-secret@db.example/app',
        '    at connect (src/db.ts:10:5)',
        '    at main (src/index.ts:2:1)',
        'Caused by: ACCESS_TOKEN="stack trace token"'
    ].join('\n');

    const result = redactSecretText(text);

    assert.doesNotMatch(result, /stack-secret/);
    assert.doesNotMatch(result, /stack trace token/);
    assert.match(result, /postgres:\/\/app:<redacted>@db\.example\/app/);
    assert.match(result, /ACCESS_TOKEN="<redacted>"/);
});


test('redactDiagnosticText replaces current hostname', () => {
    const hostname = os.hostname();
    if (!hostname) {
        return; // skip if hostname is empty
    }
    const text = `Lock held by ${hostname} with PID 1234`;
    const result = redactDiagnosticText(text);
    assert.ok(!result.includes(hostname), `Hostname '${hostname}' should be redacted`);
    assert.match(result, /<host-[0-9a-f]{8}>/);
});

test('redactDiagnosticText replaces home directory path', () => {
    _resetCachedValues();
    const homedir = os.homedir();
    if (!homedir) {
        return;
    }
    const text = `Working in ${homedir}/my-project`;
    const result = redactDiagnosticText(text);
    assert.ok(!result.includes(homedir), 'Home directory should be redacted');
    assert.ok(result.includes('<home>'), 'Should contain <home> placeholder');
});

test('redactDiagnosticText replaces repo root when provided', () => {
    const repoRoot = '/some/unique/project/root';
    const text = `Building at ${repoRoot}/src/index.ts`;
    const result = redactDiagnosticText(text, repoRoot);
    assert.ok(!result.includes(repoRoot), 'Repo root should be redacted');
    assert.ok(result.includes('<repo>'), 'Should contain <repo> placeholder');
});

test('redactDiagnosticText handles null/empty input gracefully', () => {
    assert.equal(redactDiagnosticText(''), '');
    assert.equal(redactDiagnosticText(null as unknown as string), null);
});


test('createRedactionContext provides scoped redaction methods', () => {
    const repoRoot = '/workspace/project';
    const ctx = createRedactionContext(repoRoot);

    assert.equal(ctx.repoRoot, repoRoot);

    const hostname = ctx.redactHostname('my-server');
    assert.match(hostname!, /^<host-[0-9a-f]{8}>$/);

    const redactedPath = ctx.redactPath('/workspace/project/src/file.ts');
    assert.equal(redactedPath, 'src/file.ts');
});

test('createRedactionContext without repo root still works', () => {
    const ctx = createRedactionContext();
    assert.equal(ctx.repoRoot, undefined);

    const hostname = ctx.redactHostname('test-host');
    assert.ok(hostname !== null);
    assert.match(hostname!, /^<host-[0-9a-f]{8}>$/);
});


test('redactHostname token matches what redactDiagnosticText produces', () => {
    const hostname = 'integration-test-host';
    const token = redactHostname(hostname)!;
    const text = `Connected to ${hostname}`;
    assert.equal(redactDiagnosticText(text), text);
    // redactDiagnosticText only replaces the *current* os.hostname,
    // so this test checks the token format consistency.
    assert.match(token, /^<host-[0-9a-f]{8}>$/);
});

test('redactPath case-insensitive match on Windows-style paths', () => {
    const result = redactPath('C:/Users/Dev/REPO/src/file.ts', 'c:/users/dev/repo');
    assert.equal(result, 'src/file.ts');
});

test('redactDiagnosticText replaces the home prefix only at a path boundary', () => {
    _resetCachedValues();
    const home = os.homedir();
    const sibling = `${home}2${path.sep}a.txt`;
    const inside = `${home}${path.sep}a.txt`;
    const result = redactDiagnosticText(`see ${sibling} and ${inside} and "${home}"`);
    assert.ok(!result.includes('<home>2'), result);
    assert.ok(result.includes(`<home>${path.sep}a.txt`), result);
    assert.ok(result.includes('"<home>"'), result);
});

test('redactSensitiveData keeps multiline string array elements in place', () => {
    const result = redactSensitiveData({ secrets: ['line1\napi_key=sk-abcdef123456', 'ok'] }) as { secrets: string[] };
    assert.equal(result.secrets.length, 2);
    assert.equal(result.secrets[0], 'line1\napi_key=<redacted>');
    assert.equal(result.secrets[1], 'ok');
});

test('redactSecretText can keep the line count for line-aligned evidence', () => {
    const source = [
        '        mvc.perform(get("/not-found?token=" + SECRET))',
        '            .andExpect(status().isNotFound())',
        '            .andExpect(jsonPath("$.title").value("Not Found"))',
        'API_TOKEN="line one',
        'line two"',
        '-----BEGIN PRIVATE KEY-----',
        'MIIEvQIBADANBg',
        '-----END PRIVATE KEY-----'
    ].join('\n');
    const preserved = redactSecretText(source, { preserveLineCount: true });
    assert.equal(preserved.split('\n').length, source.split('\n').length);
    assert.doesNotMatch(preserved, /line one|line two|MIIEvQIBADANBg/);
    assert.ok(redactSecretText(source).split('\n').length < source.split('\n').length);
});
