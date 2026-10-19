import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildSharedStartTaskWorkflowContent } from '../../../../src/materialization/content-builders';
import { runInit } from '../../../../src/materialization/init';
import { runInstall } from '../../../../src/materialization/install';

function findRepoRoot(): string {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'template')) && fs.existsSync(path.join(current, 'package.json'))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root.');
}

interface MaterializedWorkspace {
    projectRoot: string;
    bundleRoot: string;
}

const REPO_ROOT = findRepoRoot();
let materializedWorkspace: MaterializedWorkspace | null = null;

function copyDirRecursive(src: string, dst: string): void {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, dstPath);
        } else {
            fs.copyFileSync(srcPath, dstPath);
        }
    }
}

function setupMaterializedWorkspace(repoRoot: string): MaterializedWorkspace {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-command-preference-'));
    const bundleRoot = path.join(projectRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    fs.mkdirSync(bundleRoot, { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'VERSION'), path.join(bundleRoot, 'VERSION'));
    copyDirRecursive(path.join(repoRoot, 'template'), path.join(bundleRoot, 'template'));
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.git', 'hooks'), { recursive: true });

    fs.writeFileSync(initAnswersPath, JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'GitHubCopilot',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE',
        ActiveAgentFiles: '.github/copilot-instructions.md, CLAUDE.md'
    }, null, 2), 'utf8');

    runInstall({
        targetRoot: projectRoot,
        bundleRoot,
        assistantLanguage: 'English',
        assistantBrevity: 'concise',
        sourceOfTruth: 'GitHubCopilot',
        initAnswersPath,
        runInit: true,
        initRunner: (options) => {
            runInit({
                targetRoot: options.targetRoot,
                bundleRoot,
                assistantLanguage: options.assistantLanguage,
                assistantBrevity: options.assistantBrevity,
                sourceOfTruth: options.sourceOfTruth,
                enforceNoAutoCommit: options.enforceNoAutoCommit,
                tokenEconomyEnabled: options.tokenEconomyEnabled
            });
        }
    });

    return { projectRoot, bundleRoot };
}

function cleanupMaterializedWorkspace(workspace: MaterializedWorkspace | null): void {
    if (!workspace) {
        return;
    }
    fs.rmSync(workspace.projectRoot, { recursive: true, force: true });
}

function getMaterializedWorkspace(): MaterializedWorkspace {
    assert.ok(materializedWorkspace !== null, 'materialized workspace must be initialized before reading generated files');
    return materializedWorkspace;
}

function readRepoFile(relativePath: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
}

function readMaterializedProjectFile(relativePath: string): string {
    const workspace = getMaterializedWorkspace();
    return fs.readFileSync(path.join(workspace.projectRoot, relativePath), 'utf-8');
}

function readMaterializedBundleFile(relativePath: string): string {
    const workspace = getMaterializedWorkspace();
    return fs.readFileSync(path.join(workspace.bundleRoot, relativePath), 'utf-8');
}

before(() => {
    materializedWorkspace = setupMaterializedWorkspace(REPO_ROOT);
});

after(() => {
    cleanupMaterializedWorkspace(materializedWorkspace);
    materializedWorkspace = null;
});

describe('command-preference-vs-mandatory-gates rule clarity', () => {

    describe('40-commands.md (live)', () => {
        it('uses "ad-hoc" qualifier in manual-command preference', () => {
            const content = readMaterializedBundleFile('live/docs/agent-rules/40-commands.md');
            assert.ok(
                content.includes('Prefer orchestrator-managed validation over ad-hoc validation'),
                '40-commands.md must prefer orchestrator-managed validation to prevent blanket test/build bans'
            );
        });

        it('includes mandatory-gate exception immediately after preference', () => {
            const content = readMaterializedBundleFile('live/docs/agent-rules/40-commands.md');
            assert.ok(
                content.includes('never waive mandatory gate validation'),
                '40-commands.md must state that user preferences do not waive mandatory gate validation'
            );
        });

        it('has Ad-Hoc vs Mandatory Gate Commands section', () => {
            const content = readMaterializedBundleFile('live/docs/agent-rules/40-commands.md');
            assert.ok(
                content.includes('### Ad-Hoc vs Mandatory Gate Commands'),
                '40-commands.md must include a section distinguishing ad-hoc from gate commands'
            );
        });

        it('includes compile-gate example showing gate-driven build is allowed', () => {
            const content = readMaterializedBundleFile('live/docs/agent-rules/40-commands.md');
            assert.ok(
                content.includes('compile-gate internally runs') ||
                content.includes('gate-driven, not ad-hoc'),
                '40-commands.md must include an example showing compile-gate build execution is allowed'
            );
        });

        it('forbids raw-shell fan-out for producer-consumer validation chains', () => {
            const content = readMaterializedBundleFile('live/docs/agent-rules/40-commands.md');
            assert.ok(
                content.includes('Known producer-consumer validation chains'),
                '40-commands.md must explicitly name producer-consumer validation chains'
            );
            assert.ok(
                content.includes('raw shell sidecars') && content.includes('a generator, build or compile step followed by a command that consumes its output'),
                '40-commands.md must forbid raw-shell fan-out for generated-artifact validation flows'
            );
        });

        it('documents bounded manual validation logging for noisy ad-hoc commands', () => {
            const content = readMaterializedBundleFile('live/docs/agent-rules/40-commands.md');
            assert.ok(
                content.includes('### Manual Validation Logs'),
                '40-commands.md must document the manual validation log pattern'
            );
            assert.ok(
                content.includes('ManualValidationLogPath') &&
                content.includes('$taskId = "<task-id>"') &&
                content.includes('garda-agent-orchestrator/runtime/manual-validation/$taskId') &&
                content.includes('task_id="<task-id>"') &&
                content.includes('tail -n 80 "$log_path"'),
                '40-commands.md must include PowerShell and POSIX bounded-tail examples'
            );
            assert.ok(
                content.includes('does not replace `compile-gate`, `full-suite-validation`, or') &&
                content.includes('preserve the original exit code'),
                '40-commands.md must keep manual validation separate from gate-owned evidence'
            );
        });

        it('promotes auditable intermediate commands before raw targeted tests', () => {
            const content = readMaterializedBundleFile('live/docs/agent-rules/40-commands.md');
            assert.ok(
                content.includes('### Auditable Intermediate Commands') &&
                content.includes('gate run-intermediate-command') &&
                content.includes('bounded failure tail'),
                '40-commands.md must surface run-intermediate-command as the preferred compact manual validation wrapper'
            );
            assert.ok(
                content.includes('do not wrap a redundant full suite') &&
                content.includes('never replaces `compile-gate`, `full-suite-validation`') &&
                content.includes('reviews, or completion evidence'),
                '40-commands.md must keep intermediate commands scoped and separate from mandatory gates'
            );
        });
    });

    describe('40-commands.md (template)', () => {
        const content = readRepoFile('template/docs/agent-rules/40-commands.md');

        it('uses "ad-hoc" qualifier in manual-command preference', () => {
            assert.ok(
                content.includes('Prefer orchestrator-managed validation over ad-hoc validation'),
                'template 40-commands.md must prefer orchestrator-managed validation'
            );
        });

        it('includes mandatory-gate exception', () => {
            assert.ok(
                content.includes('never waive mandatory gate validation'),
                'template 40-commands.md must state that user preferences do not waive mandatory gate validation'
            );
        });

        it('has Ad-Hoc vs Mandatory Gate Commands section', () => {
            assert.ok(
                content.includes('### Ad-Hoc vs Mandatory Gate Commands'),
                'template 40-commands.md must include ad-hoc vs gate section'
            );
        });

        it('forbids raw-shell fan-out for producer-consumer validation chains', () => {
            assert.ok(
                content.includes('Known producer-consumer validation chains'),
                'template 40-commands.md must explicitly name producer-consumer validation chains'
            );
            assert.ok(
                content.includes('raw shell sidecars') && content.includes('a generator, build or compile step followed by a command that consumes its output'),
                'template 40-commands.md must forbid raw-shell fan-out for generated-artifact validation flows'
            );
        });

        it('documents bounded manual validation logging for noisy ad-hoc commands', () => {
            assert.ok(
                content.includes('### Manual Validation Logs'),
                'template 40-commands.md must document the manual validation log pattern'
            );
            assert.ok(
                content.includes('ManualValidationLogPath') &&
                content.includes('$taskId = "<task-id>"') &&
                content.includes('garda-agent-orchestrator/runtime/manual-validation/$taskId') &&
                content.includes('task_id="<task-id>"') &&
                content.includes('tail -n 80 "$log_path"'),
                'template 40-commands.md must include PowerShell and POSIX bounded-tail examples'
            );
            assert.ok(
                content.includes('does not replace `compile-gate`, `full-suite-validation`, or') &&
                content.includes('preserve the original exit code'),
                'template 40-commands.md must keep manual validation separate from gate-owned evidence'
            );
        });

        it('promotes auditable intermediate commands before raw targeted tests', () => {
            assert.ok(
                content.includes('### Auditable Intermediate Commands') &&
                content.includes('gate run-intermediate-command') &&
                content.includes('bounded failure tail'),
                'template 40-commands.md must surface run-intermediate-command as the preferred compact manual validation wrapper'
            );
            assert.ok(
                content.includes('do not wrap a redundant full suite') &&
                content.includes('never replaces `compile-gate`, `full-suite-validation`') &&
                content.includes('reviews, or completion evidence'),
                'template 40-commands.md must keep intermediate commands scoped and separate from mandatory gates'
            );
        });
    });

    describe('00-core.md (live)', () => {
        it('cross-references 40-commands.md preference in Mandatory Infrastructure Integrity', () => {
            const content = readMaterializedBundleFile('live/docs/agent-rules/00-core.md');
            assert.ok(
                content.includes('40-commands.md') && content.includes('standalone ad-hoc commands'),
                '00-core.md Mandatory Infrastructure Integrity must cross-reference 40-commands.md ad-hoc restraint'
            );
        });

        it('explicitly exempts mandatory gates from ad-hoc preference', () => {
            const content = readMaterializedBundleFile('live/docs/agent-rules/00-core.md');
            assert.ok(
                content.includes('compile-gate') && content.includes('full-suite-validation') && content.includes('required lifecycle gate'),
                '00-core.md must state the ad-hoc restraint does not apply to required lifecycle gates'
            );
        });

        it('cross-references compact manual verification paths', () => {
            const content = readMaterializedBundleFile('live/docs/agent-rules/00-core.md');
            assert.ok(
                content.includes('gate run-intermediate-command') &&
                content.includes('Manual Validation Logs') &&
                content.includes('Raw `npm test` or `node --test` reruns are escalation steps'),
                '00-core.md must make compact manual verification visible from the high-level rule surface'
            );
        });
    });

    describe('00-core.md (template)', () => {
        const content = readRepoFile('template/docs/agent-rules/00-core.md');

        it('cross-references 40-commands.md preference in Mandatory Infrastructure Integrity', () => {
            assert.ok(
                content.includes('40-commands.md') && content.includes('standalone ad-hoc commands'),
                'template 00-core.md must cross-reference 40-commands.md ad-hoc restraint'
            );
        });

        it('explicitly exempts mandatory gates from ad-hoc preference', () => {
            assert.ok(
                content.includes('compile-gate') && content.includes('full-suite-validation') && content.includes('required lifecycle gate'),
                'template 00-core.md must state the ad-hoc restraint does not apply to required lifecycle gates'
            );
        });

        it('cross-references compact manual verification paths', () => {
            assert.ok(
                content.includes('gate run-intermediate-command') &&
                content.includes('Manual Validation Logs') &&
                content.includes('Raw `npm test` or `node --test` reruns are escalation steps'),
                'template 00-core.md must make compact manual verification visible from the high-level rule surface'
            );
        });
    });

    describe('start-task router (live)', () => {
        it('includes hard-stop clarifying mandatory gates are not exempted by command preference', () => {
            const content = readMaterializedProjectFile('.agents/workflows/start-task.md');
            assert.ok(
                content.includes('does NOT exempt mandatory gates'),
                'start-task.md must include hard-stop about mandatory gates not being exempted'
            );
        });

        it('includes hard-stop banning raw-shell producer-consumer fan-out', () => {
            const content = readMaterializedProjectFile('.agents/workflows/start-task.md');
            assert.ok(
                content.includes('raw shell sidecars') && content.includes('a generator, build or compile step followed by a command that consumes its output'),
                'start-task.md must forbid raw-shell fan-out for producer-consumer validation flows'
            );
        });
    });

    describe('start-task router (template)', () => {
        const content = readRepoFile('template/.agents/workflows/start-task.md');

        it('includes hard-stop clarifying mandatory gates are not exempted by command preference', () => {
            assert.ok(
                content.includes('does NOT exempt mandatory gates'),
                'template start-task.md must include hard-stop about mandatory gates not being exempted'
            );
        });

        it('includes hard-stop banning raw-shell producer-consumer fan-out', () => {
            assert.ok(
                content.includes('raw shell sidecars') && content.includes('a generator, build or compile step followed by a command that consumes its output'),
                'template start-task.md must forbid raw-shell fan-out for producer-consumer validation flows'
            );
        });
    });

    describe('root entrypoint (.github/copilot-instructions.md)', () => {
        it('includes clarification that ad-hoc preference does not apply to mandatory gates', () => {
            const content = readMaterializedProjectFile('.github/copilot-instructions.md');
            assert.ok(
                content.includes('restraint applies only to standalone ad-hoc commands'),
                '.github/copilot-instructions.md must clarify that ad-hoc preference does not apply to mandatory gates'
            );
        });
    });

    describe('neutral canonical rule-index template', () => {
        const content = readRepoFile('template/entrypoints/canonical-rule-index.md');

        it('includes clarification that ad-hoc preference does not apply to mandatory gates', () => {
            assert.ok(
                content.includes('restraint applies only to standalone ad-hoc commands'),
                'template/entrypoints/canonical-rule-index.md must clarify that ad-hoc preference does not apply to mandatory gates'
            );
        });
    });

    describe('ad-hoc commands are still discouraged (negative parity)', () => {
        it('live 40-commands.md still discourages ad-hoc project commands', () => {
            const liveCommands = readMaterializedBundleFile('live/docs/agent-rules/40-commands.md');
            assert.ok(
                liveCommands.includes('Avoid standalone ad-hoc build, test, or lint commands'),
                'live 40-commands.md must still discourage ad-hoc command execution'
            );
        });

        it('template 40-commands.md still discourages ad-hoc project commands', () => {
            const templateCommands = readRepoFile('template/docs/agent-rules/40-commands.md');
            assert.ok(
                templateCommands.includes('Avoid standalone ad-hoc build, test, or lint commands'),
                'template 40-commands.md must still discourage ad-hoc command execution'
            );
        });

        it('live 40-commands.md marks direct project build as ad-hoc to avoid', () => {
            const liveCommands = readMaterializedBundleFile('live/docs/agent-rules/40-commands.md');
            assert.ok(
                liveCommands.includes('Ad-hoc - avoid as routine task validation'),
                'live 40-commands.md example must mark direct build as ad-hoc to avoid'
            );
        });
    });

    describe('content-builders.ts generated start-task router', () => {
        it('buildSharedStartTaskWorkflowContent includes mandatory-gate exemption hard-stop', () => {
            const generated = buildSharedStartTaskWorkflowContent('.github/copilot-instructions.md');
            assert.ok(
                generated.includes('restraint applies only to standalone ad-hoc commands'),
                'Generated start-task content must include hard-stop about mandatory gates not being exempted by ad-hoc preference'
            );
        });

        it('buildSharedStartTaskWorkflowContent includes compile-gate reference in hard-stop', () => {
            const generated = buildSharedStartTaskWorkflowContent('CLAUDE.md');
            assert.ok(
                generated.includes('compile-gate'),
                'Generated start-task content must reference compile-gate in the mandatory gate exemption hard-stop'
            );
        });

        it('buildSharedStartTaskWorkflowContent includes producer-consumer raw-shell prohibition', () => {
            const generated = buildSharedStartTaskWorkflowContent('CLAUDE.md');
            assert.ok(
                generated.includes('raw shell sidecars') && generated.includes('a generator, build or compile step followed by a command that consumes its output'),
                'Generated start-task content must forbid raw-shell producer-consumer validation fan-out'
            );
        });
    });
});
