import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRuleFileHashes, findStaleLoadedRuleFile } from '../../../../src/gates/rule-pack/rule-pack-selection';
import { fileSha256 } from '../../../../src/gates/shared/helpers';

test('regenerating the project-memory summary with only a new timestamp keeps loaded rules current', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-rule-hash-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const memory = path.join(root, '15-project-memory.md');
    const core = path.join(root, '00-core.md');
    const summary = (stamp: string, body: string) => `<!-- DO NOT EDIT -->\n\n# 15 · Project Memory Summary\n\nGenerated at: ${stamp}\n\n${body}\n`;
    fs.writeFileSync(memory, summary('2026-10-24T10:00:00.000Z', 'Stack: Java 25.'));
    fs.writeFileSync(core, '# Core\n');
    const loaded = buildRuleFileHashes([memory, core]);

    fs.writeFileSync(memory, summary('2026-10-25T00:00:20.251Z', 'Stack: Java 25.'));
    assert.equal(findStaleLoadedRuleFile(loaded, [memory, core]), null);

    fs.writeFileSync(memory, summary('2026-10-25T00:00:20.251Z', 'Stack: Java 25 and Next.js.'));
    assert.equal(findStaleLoadedRuleFile(loaded, [memory, core]), memory);

    fs.writeFileSync(memory, summary('2026-10-24T10:00:00.000Z', 'Stack: Java 25.'));
    fs.writeFileSync(core, '# Core changed\n');
    assert.equal(findStaleLoadedRuleFile(loaded, [memory, core]), core);

    // Evidence recorded before normalization (raw file hash) still matches an unchanged file.
    fs.writeFileSync(core, '# Core\n');
    assert.equal(findStaleLoadedRuleFile({ [memory]: fileSha256(memory), [core]: fileSha256(core) }, [memory, core]), null);
});
