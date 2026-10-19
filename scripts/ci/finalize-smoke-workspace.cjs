// This workspace is a synthetic CI project, not an operator's existing project.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PROJECT_MEMORY_FILE_DEFINITIONS } = require('../../dist/src/core/project-memory.js');

const targetRoot = path.resolve(process.argv[2]);
const memoryRoot = path.join(targetRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
for (const { fileName, purpose } of PROJECT_MEMORY_FILE_DEFINITIONS) {
    fs.writeFileSync(path.join(memoryRoot, fileName), [
        `# ${fileName}`,
        '',
        purpose,
        'This temporary Node project exists only to exercise Garda setup, agent-init, local Git update, doctor and uninstall.',
        'Its package.json builds index.js with node --check; it has no services or external dependencies.'
    ].join('\n') + '\n');
}

const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '../../bin/garda.js'), 'agent-init', '--target-root', targetRoot,
    '--active-agent-files', '.antigravity/rules.md', '--project-rules-updated', 'yes',
    '--skills-prompted', 'yes', '--ordinary-doc-paths', 'CHANGELOG.md'
], { encoding: 'utf8', timeout: 120_000 });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
assert.equal(result.status, 0, `Smoke agent-init failed: ${result.error || result.signal || result.status}`);
assert.match(result.stdout, /^AgentInit: PASS\r?$/mu, 'Smoke workspace must finish real agent initialization before update');
