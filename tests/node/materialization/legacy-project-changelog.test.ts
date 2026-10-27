import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { migrateLegacyProjectChangelog } from '../../../src/materialization/init/legacy-project-changelog';

const SKELETON = '# Change Log\n\nFeature and behavior change log for this project.\n';
const LEGACY = [
    '# Change Log',
    '',
    'Current baseline:',
    '',
    '- runtime is Node-only',
    '- lifecycle commands and gates run through `bin/garda.js`',
    '- template content no longer ships shell lifecycle or gate entrypoints',
    '',
    'For source-level release notes, see the repository root `CHANGELOG.md`.',
    ''
].join('\n');

describe('migrateLegacyProjectChangelog', () => {
    it('replaces the shipped Garda baseline with the project skeleton', () => {
        assert.equal(migrateLegacyProjectChangelog(LEGACY, SKELETON), SKELETON);
    });

    it('keeps project lines inside and after the legacy block', () => {
        const withProjectLines = LEGACY
            .replace('- runtime is Node-only\n', '- runtime is Node-only\n- Checkout: idempotent order submission.\n')
            .concat('- Catalog: price filter.\n');
        assert.equal(
            migrateLegacyProjectChangelog(withProjectLines, SKELETON),
            `${SKELETON}\n- Checkout: idempotent order submission.\n- Catalog: price filter.\n`
        );
    });

    it('keeps blank lines between project paragraphs inside the legacy block', () => {
        const withParagraphs = LEGACY.replace(
            '- template content no longer ships shell lifecycle or gate entrypoints\n',
            '- template content no longer ships shell lifecycle or gate entrypoints\n- Checkout: idempotent orders.\n\n## Payments\n\n- Refund webhook.\n'
        );
        assert.equal(
            migrateLegacyProjectChangelog(withParagraphs, SKELETON),
            `${SKELETON}\n- Checkout: idempotent orders.\n\n## Payments\n\n- Refund webhook.\n`
        );
    });

    it('preserves CRLF line endings', () => {
        const migrated = migrateLegacyProjectChangelog(LEGACY.replace(/\n/g, '\r\n'), SKELETON);
        assert.equal(migrated, SKELETON.replace(/\n/g, '\r\n'));
    });

    it('leaves a project-owned change log untouched', () => {
        assert.equal(migrateLegacyProjectChangelog('# Change Log\n\n- Checkout: idempotent order submission.\n', SKELETON), null);
        assert.equal(migrateLegacyProjectChangelog(LEGACY.replace(/For source-level release notes.*\n/u, ''), SKELETON), null);
    });
});
