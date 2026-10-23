/**
 * Stack-neutral review triggers based on the words of a file name.
 *
 * Path regexes alone miss security-relevant files whose keyword sits inside a
 * compound name in a neutral folder (`config/SecurityConfig.java`,
 * `filters/JwtFilter.kt`, `auth-middleware.ts`). Splitting the file name into
 * words for every common naming style and matching whole words keeps
 * `TokenService` in scope while leaving `tokenizer` out.
 */
export const TRIGGER_NAME_TOKENS_CONFIG_KEY = 'trigger_name_tokens';

export type TriggerNameTokenLane = 'security' | 'db';

export const DEFAULT_TRIGGER_NAME_TOKENS: Readonly<Record<TriggerNameTokenLane, readonly string[]>> = Object.freeze({
    security: Object.freeze([
        'auth', 'authn', 'authz', 'authentication', 'authenticator', 'authorization', 'authorizer',
        'security', 'oauth', 'oauth2', 'oidc', 'openid', 'saml', 'sso', 'jwt', 'jwk', 'jws', 'jwe',
        'token', 'tokens', 'password', 'passwords', 'passwd', 'credential', 'credentials',
        'secret', 'secrets', 'crypto', 'cryptography', 'cipher', 'encrypt', 'encryption', 'decrypt', 'decryption',
        'keystore', 'truststore', 'certificate', 'certificates', 'tls', 'ssl',
        'permission', 'permissions', 'rbac', 'abac', 'acl', 'acls', 'csrf', 'xsrf', 'cors', 'xss',
        'sanitizer', 'session', 'sessions', 'login', 'logout', 'signin', 'mfa', 'totp', 'otp',
        'keycloak', 'okta', 'auth0', 'vault', 'firewall', 'captcha',
        'webhook', 'webhooks', 'payment', 'payments', 'checkout', 'billing'
    ]),
    db: Object.freeze(['entity', 'entities'])
});

/** Splits a file name into lower-case words across camelCase, PascalCase, snake_case, kebab-case and dotted names. */
export function splitFileNameWords(filePath: string): string[] {
    const baseName = String(filePath || '').replace(/\\/g, '/').split('/').pop() || '';
    return baseName
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .map((word) => word.toLowerCase())
        .filter((word) => word.length > 0);
}

export function matchesTriggerNameTokens(filePath: string, tokens: readonly string[] | undefined): boolean {
    if (!tokens || tokens.length === 0) return false;
    const tokenSet = new Set(tokens.map((token) => token.toLowerCase()));
    return splitFileNameWords(filePath).some((word) => tokenSet.has(word));
}

export function normalizeTriggerNameTokens(value: unknown, context: string): Record<string, string[]> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${context} must be an object mapping review types to word lists.`);
    }
    const normalized: Record<string, string[]> = {};
    for (const [lane, words] of Object.entries(value as Record<string, unknown>)) {
        if (!Array.isArray(words) || words.some((word) => typeof word !== 'string' || !/^[a-z0-9]+$/i.test(word))) {
            throw new Error(`${context}.${lane} must be an array of single alphanumeric words.`);
        }
        normalized[lane] = (words as string[]).map((word) => word.toLowerCase());
    }
    return normalized;
}
