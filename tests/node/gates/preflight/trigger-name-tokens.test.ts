import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange } from '../../../../src/gates/preflight/classify-change';
import { splitFileNameWords } from '../../../../src/gates/preflight/trigger-name-tokens';
import { defaultCapabilities, makeConfig } from './classify-change-test-support';

function lanes(file: string) {
    const result = classifyChange({
        normalizedFiles: [file],
        changedLinesTotal: 12,
        changedFileStats: { [file]: { additions: 8, deletions: 4, changed_lines: 12 } },
        classificationConfig: makeConfig(),
        reviewCapabilities: defaultCapabilities
    });
    return result.triggers as unknown as Record<string, unknown>;
}

describe('stack-neutral review triggers', () => {
    it('splits file names across naming styles', () => {
        assert.deepEqual(splitFileNameWords('src/config/SecurityConfig.java'), ['security', 'config', 'java']);
        assert.deepEqual(splitFileNameWords('JWTFilter.kt'), ['jwt', 'filter', 'kt']);
        assert.deepEqual(splitFileNameWords('auth-middleware.ts'), ['auth', 'middleware', 'ts']);
        assert.deepEqual(splitFileNameWords('payment_gateway.py'), ['payment', 'gateway', 'py']);
        assert.deepEqual(splitFileNameWords('OAuthClient.cs'), ['o', 'auth', 'client', 'cs']);
        assert.deepEqual(splitFileNameWords('src/lib/tokenizer.ts'), ['tokenizer', 'ts']);
    });

    it('requires security review for security-relevant code names in any stack and folder', () => {
        for (const file of [
            'api-gateway/src/main/java/com/shop/config/SecurityConfig.java',
            'src/filters/JwtFilter.kt',
            'src/middleware/AuthMiddleware.ts',
            'Services/TokenService.cs',
            'app/payment_gateway.py',
            'internal/session/session_store.go',
            'lib/password_hasher.rb',
            'src/crypto.rs',
            'app/Http/Middleware/VerifyCsrfToken.php'
        ]) {
            assert.equal(lanes(file).security, true, file);
        }
    });

    it('keeps near-miss names and documentation out of security review', () => {
        for (const file of ['src/lib/tokenizer.ts', 'src/ui/AuthorList.tsx', 'docs/payment-flow.md', 'src/sessionless_cache.go']) {
            assert.equal(lanes(file).security, false, file);
        }
    });

    it('requires infra review for CI and infrastructure-as-code files of common providers', () => {
        for (const file of ['.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml',
            '.circleci/config.yml', 'deploy/main.tf', 'env/prod.tfvars', 'charts/shop/Chart.yaml', 'overlays/prod/kustomization.yaml']) {
            assert.equal(lanes(file).infra, true, file);
        }
    });
});
