import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyCommitGuardHook } from '../../../src/materialization/install';

const AGENT_ENV_PREFIXES = ['CODEX_', 'CLAUDE', 'CURSOR_', 'QWEN_', 'GITHUB_COPILOT', 'COPILOT_', 'AIDER_', 'GEMINI_', 'GARDA_'];

/** The host running the tests may itself be an agent shell; start from an environment without any marker. */
function neutralEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (!AGENT_ENV_PREFIXES.some(prefix => key.toUpperCase().startsWith(prefix))) env[key] = value;
    }
    return { ...env, ...extra };
}

// The installer resolves the hook through `git rev-parse --git-path`, which honours any hooksPath the
// test runner configures; commit through that same directory.
function installedHooksDir(root: string): string {
    const hook = childProcess.spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-commit'],
        { cwd: root, encoding: 'utf8' }).stdout.trim();
    return path.dirname(path.resolve(root, hook)).replace(/\\/gu, '/');
}

function commit(root: string, env: NodeJS.ProcessEnv): childProcess.SpawnSyncReturns<string> {
    fs.writeFileSync(path.join(root, 'file.txt'), `${Date.now()}-${Math.random()}\n`);
    childProcess.spawnSync('git', ['add', 'file.txt'], { cwd: root, env, encoding: 'utf8' });
    return childProcess.spawnSync('git', ['-c', `core.hooksPath=${installedHooksDir(root)}`,
        '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        'commit', '--quiet', '-m', 'guard probe'], { cwd: root, env, encoding: 'utf8' });
}

describe('commit guard agent markers', () => {
    it('blocks Claude Code and Gemini CLI agent shells and keeps human and operator commits working', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-guard-markers-'));
        try {
            const env = neutralEnv({});
            childProcess.spawnSync('git', ['init', '--quiet'], { cwd: root, env });
            assert.equal(applyCommitGuardHook(root, true, false), true);

            for (const marker of ['CLAUDECODE', 'GEMINI_CLI', 'CODEX_THREAD_ID']) {
                const blocked = commit(root, neutralEnv({ [marker]: '1' }));
                assert.notEqual(blocked.status, 0, `${marker} must be blocked`);
                assert.match(`${blocked.stdout}${blocked.stderr}`, new RegExp(`Commit blocked[\\s\\S]*${marker}`, 'u'));
            }
            assert.equal(commit(root, neutralEnv({ CLAUDECODE: '1', GARDA_ALLOW_COMMIT: '1' })).status, 0,
                'the operator escape still allows a commit');
            assert.equal(commit(root, neutralEnv({})).status, 0, 'a human shell without markers can commit');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
