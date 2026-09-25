import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

const SCRIPT = path.join(getRepoRoot(), 'scripts', 'validate-workflow-references.cjs');
const CHECKOUT_SHA = '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0';
const OSV_SHA = 'b77c075a1235514558f0eb88dbd31e22c45e0cd2';

function makeWorkflowRoot(source: string, childSource?: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-workflow-pins-'));
    const workflowDir = path.join(root, '.github', 'workflows');
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(workflowDir, 'main.yml'), source);
    if (childSource !== undefined) {
        fs.writeFileSync(path.join(workflowDir, 'child.yml'), childSource);
    }
    return root;
}

function runValidator(root: string) {
    return spawnSync(process.execPath, [SCRIPT, '--repo-root', root], {
        encoding: 'utf8', timeout: 30_000
    });
}

test('repository workflow references match reviewed immutable pins', () => {
    const result = runValidator(getRepoRoot());
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /WORKFLOW_REFERENCES_VALID: 6 workflows, \d+ references/u);
});

test('validator accepts local reusable workflows and pinned nested reusable calls', () => {
    const root = makeWorkflowRoot([
        'jobs:',
        '  local:',
        '    uses: ./.github/workflows/child.yml',
        '  external:',
        `    uses: "google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@${OSV_SHA}" # v2.3.0`,
        '  step:',
        '    steps:',
        `      - 'uses': 'actions/checkout@${CHECKOUT_SHA}' # v7.0.0`,
        '      - run: |',
        '          echo uses: actions/checkout@v1'
    ].join('\n'), 'on:\n  workflow_call:\n');
    try {
        const result = runValidator(root);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /2 workflows, 3 references/u);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('validator rejects mutable step and nested reusable workflow refs', () => {
    const root = makeWorkflowRoot([
        'jobs:',
        '  scan:',
        '    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.0',
        '  check:',
        '    steps:',
        '      - uses: actions/checkout@v7.0.0'
    ].join('\n'));
    try {
        const result = runValidator(root);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /main.yml:3: External reference must use a full lowercase commit SHA/u);
        assert.match(result.stderr, /main.yml:6: External reference must use a full lowercase commit SHA/u);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('validator rejects unreviewed identities, changed pins, and missing local workflows', () => {
    const root = makeWorkflowRoot([
        'jobs:',
        `  a: { uses: actions/checkout@${CHECKOUT_SHA} }`,
        `  b:\n    uses: example/action@${CHECKOUT_SHA} # v1`,
        `  c:\n    uses: actions/checkout@${'a'.repeat(40)} # v7.0.0`,
        '  d:\n    uses: ./.github/workflows/missing.yml'
    ].join('\n'));
    try {
        const result = runValidator(root);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Unsupported uses syntax/u);
        assert.match(result.stderr, /External reference has no reviewed identity/u);
        assert.match(result.stderr, /differs from reviewed v7\.0\.0 pin/u);
        assert.match(result.stderr, /Local reference does not exist/u);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('validator rejects YAML-escaped uses keys for steps and reusable workflows', () => {
    const root = makeWorkflowRoot([
        'jobs:',
        '  scan:',
        '    "us\\u0065s": google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.0',
        '  check:',
        '    steps:',
        '      - "\\x75ses": actions/checkout@v7.0.0'
    ].join('\n'));
    try {
        const result = runValidator(root);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /main.yml:3: Unsupported uses syntax/u);
        assert.match(result.stderr, /main.yml:6: Unsupported uses syntax/u);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('validator rejects explicit and aliased YAML mapping keys', () => {
    const root = makeWorkflowRoot([
        'action_key: &actionKey uses',
        'jobs:',
        '  reusable:',
        '    ? uses',
        '    : google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.0',
        '  steps:',
        '    steps:',
        '      - *actionKey: actions/checkout@v7.0.0'
    ].join('\n'));
    try {
        const result = runValidator(root);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /main.yml:4: Unsupported uses syntax/u);
        assert.match(result.stderr, /main.yml:8: Unsupported uses syntax/u);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('validator rejects continued double-quoted YAML uses keys', () => {
    const root = makeWorkflowRoot([
        'jobs:',
        '  reusable:',
        '    "us\\',
        '      es": google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.0',
        '  steps:',
        '    steps:',
        '      - "us\\',
        '          es": actions/checkout@v7.0.0'
    ].join('\n'));
    try {
        const result = runValidator(root);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /main.yml:3: Unsupported uses syntax/u);
        assert.match(result.stderr, /main.yml:7: Unsupported uses syntax/u);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('validator rejects property-prefixed continued YAML uses keys', () => {
    const root = makeWorkflowRoot([
        'jobs:',
        '  anchored:',
        '    &key "us\\',
        '      es": google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.0',
        '  tagged:',
        '    steps:',
        '      - !!str "us\\',
        '          es": actions/checkout@v7.0.0'
    ].join('\n'));
    try {
        const result = runValidator(root);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /main.yml:3: Unsupported uses syntax/u);
        assert.match(result.stderr, /main.yml:7: Unsupported uses syntax/u);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('validator rejects mutable uses refs at flow-sequence boundaries', () => {
    const root = makeWorkflowRoot([
        'jobs:',
        '  scan:',
        '    steps: [uses: actions/checkout@v7.0.0]',
        '  another:',
        '    steps: ["us\\u0065s": actions/checkout@v7.0.0]'
    ].join('\n'));
    try {
        const result = runValidator(root);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /main.yml:3: Unsupported uses syntax/u);
        assert.match(result.stderr, /main.yml:5: Unsupported uses syntax/u);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('validator checks a uses sibling after a sequence block scalar', () => {
    const root = makeWorkflowRoot([
        'jobs:',
        '  scan:',
        '    steps:',
        '      - name: |',
        '          description with uses: inside scalar',
        '        uses: actions/checkout@v7.0.0'
    ].join('\n'));
    try {
        const result = runValidator(root);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /main.yml:6: External reference must use a full lowercase commit SHA/u);
        assert.doesNotMatch(result.stderr, /main.yml:5:/u);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('validator rejects local references resolved outside the repository', () => {
    const root = makeWorkflowRoot('jobs:\n  scan:\n    uses: ./.github/workflows/external/child.yml\n');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-workflow-external-'));
    try {
        fs.writeFileSync(path.join(outside, 'child.yml'), 'on:\n  workflow_call:\n');
        fs.symlinkSync(outside, path.join(root, '.github', 'workflows', 'external'),
            process.platform === 'win32' ? 'junction' : 'dir');
        const result = runValidator(root);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Local reference resolves outside repository/u);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});
