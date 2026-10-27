import { createHash } from 'node:crypto';

// Before 1.4.4, init and update overwrote the project change log with Garda's own release baseline.
const LEGACY_HEADER = ['# Change Log', '', 'Current baseline:'];
const LEGACY_FOOTER = 'For source-level release notes, see the repository root `CHANGELOG.md`.';
// SHA-256 of every bullet that the shipped template ever contained; any other line belongs to the project.
const LEGACY_BULLET_SHA256 = new Set([
    'acf54eec64f316f0ae98e4d274172eea2dca8d1a15beb8bc9e585aa8731ce9f0',
    '2bc33c4b91bc50a444289d9cf2f02f10c861e4b8dcfd567bbe2fb9b5dc3f1469',
    'bffd19fe33810b997f5dc403184a3e5df6cef47fbd722f1e946f07a2a4cf9c72',
    '685920ea31d2696c9af52eabf95890ef3902e5ae4245d215087eba9a12bc402a',
    '866c4dc1699acfbaf16e59c6bb909674ebe045b2a70b57da162ad711c57315df',
    '6dafc9e5fa17f5c0b127dceee4367da7a5c6a9e6d241ff210ef27bb7ed6f1205',
    'a42eef675bc4bf22651a84ac9a06ac8ac364a7fa92150d4910675d4d2057c830',
    '720fb19a2961c3664a79a169da76ccd6e529c2912b8ce2997015323bad73cf16',
    'aaddc19aa353b361d5de42b7ff54a9ccd14cfa99640c1bb74e55388d033d39d8',
    'd916dd822d8b7149b65d10bc4cf7fadb576c86f5385fdbf2bd71c66a71462d3f'
]);

function isLegacyBullet(line: string): boolean {
    return LEGACY_BULLET_SHA256.has(createHash('sha256').update(line).digest('hex'));
}

/**
 * Replaces the legacy Garda baseline in a project change log with the neutral skeleton.
 * Project-authored lines inside or after the legacy block are kept; anything else returns null (no change).
 */
export function migrateLegacyProjectChangelog(content: string, skeleton: string): string | null {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    if (LEGACY_HEADER.some((line, index) => lines[index] !== line)) return null;
    const footerIndex = lines.indexOf(LEGACY_FOOTER);
    if (footerIndex < LEGACY_HEADER.length) return null;
    // Keep project paragraphs intact: drop legacy bullets, then collapse only the blank runs they leave behind.
    const block = lines.slice(LEGACY_HEADER.length, footerIndex);
    // The template frame had one blank line after the header and one before the footer.
    if (block[0] === '') block.shift();
    if (block[block.length - 1] === '') block.pop();
    const projectLines = [
        ...block.filter((line) => !isLegacyBullet(line)),
        ...lines.slice(footerIndex + 1)
    ].filter((line, index, all) => line.trim() !== '' || index === 0 || all[index - 1].trim() !== '');
    while (projectLines.length > 0 && projectLines[0].trim() === '') projectLines.shift();
    while (projectLines.length > 0 && projectLines[projectLines.length - 1].trim() === '') projectLines.pop();
    const migrated = [
        ...skeleton.replace(/\r\n/g, '\n').trimEnd().split('\n'),
        ...(projectLines.length > 0 ? ['', ...projectLines] : [])
    ];
    return `${migrated.join(eol)}${eol}`;
}
