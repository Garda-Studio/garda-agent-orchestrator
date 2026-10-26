import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deployFreshBundle } from '../../../src/cli/commands/cli-bundle-helpers';
import { getRepoRoot } from '../../../scripts/node-foundation/build';

test('every relative link in deployed public documentation resolves inside the bundle', context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-deployed-doc-links-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bundle = path.join(root, 'bundle');
    deployFreshBundle(getRepoRoot(), bundle);
    const docs: string[] = [];
    const walk = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(target);
            else if (entry.name.endsWith('.md')) docs.push(target);
        }
    };
    walk(path.join(bundle, 'docs'));
    for (const entry of fs.readdirSync(bundle)) if (entry.endsWith('.md')) docs.push(path.join(bundle, entry));
    const missing: string[] = [];
    for (const doc of docs) {
        const text = fs.readFileSync(doc, 'utf8').replace(/^\s*(```|~~~)[\s\S]*?^\s*\1[^\r\n]*$/gm, '');
        const links = [...text.matchAll(/\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g),
            ...text.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm),
            ...text.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map(match => match[1]);
        for (const link of links) {
            if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(link)) continue;
            const relative = decodeURIComponent(link.split(/[?#]/)[0]);
            if (!relative) continue;
            const target = path.resolve(path.dirname(doc), relative);
            if (!target.startsWith(bundle + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
                missing.push(path.relative(bundle, doc).replace(/\\/g, '/') + ' -> ' + link);
            }
        }
    }
    assert.deepEqual(missing, []);
});
