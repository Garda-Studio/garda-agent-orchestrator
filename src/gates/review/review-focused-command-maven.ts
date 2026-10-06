import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPathRealpathInsideRoot } from '../../core/paths';

const MAVEN_RUNNER_PATTERN = /^(?:mvn|mvnw)(?:\.cmd|\.bat)?$/u;
const MAVEN_UNSUPPORTED_COMMAND_REASON = 'use unsupported or incomplete Maven options, goals, or test selectors';
const MAVEN_FAIL_OPTIONS = new Set(['-fn', '-ff', '-fae']);
const MAVEN_FILE_OPTION_COLLISIONS = ['fail-fast', 'fail-at-end', 'fail-never', 'file', 'force-interactive'];
const MAVEN_TEST_SOURCE_DIRECTORY = 'src/test/java';
const MAVEN_TEST_CLASSES_DIRECTORY = 'target/test-classes';
const MAVEN_MAX_SCANNED_ENTRIES = 10000;
const MAVEN_MAX_POM_BYTES = 1024 * 1024;
const MAVEN_UNSUPPORTED_LAYOUT_ELEMENTS = new Set([
    'parent', 'modules', 'testSourceDirectory', 'testClassesDirectory', 'testOutputDirectory', 'outputDirectory'
]);
const JAVA_NAME = '[A-Za-z_][A-Za-z0-9_]*';
const MAVEN_TEST_SELECTOR_PATTERN = new RegExp(`^${JAVA_NAME}(?:(?:\\.${JAVA_NAME})+|(?:/${JAVA_NAME})+(?:\\.java)?)?(?:#${JAVA_NAME})?$`, 'u');

export interface MavenFocusedCommand {
    project: string;
    selector: string;
    goal: 'test' | 'surefire:test' | null;
    unsafeReason: string | null;
}

interface MavenOptionOperand {
    value: string;
    endIndex: number;
}

function readMavenOperand(tokens: readonly string[], index: number, shortName: string, longName: string): MavenOptionOperand | null {
    const token = tokens[index];
    if (token === shortName || token === longName) {
        return { value: tokens[index + 1] || '', endIndex: index + 1 };
    }
    if (token.startsWith(`${longName}=`)) {
        return { value: token.slice(longName.length + 1), endIndex: index };
    }
    if (token.startsWith(shortName)) {
        return { value: token.slice(shortName.length).replace(/^=/u, ''), endIndex: index };
    }
    return null;
}

function readMavenTestProperty(tokens: readonly string[], index: number): MavenOptionOperand | null {
    const property = readMavenOperand(tokens, index, '-D', '--define');
    if (!property) return null;
    if (property.value.startsWith('test=')) {
        return { ...property, value: property.value.slice('test='.length) };
    }
    return { ...property, value: '' };
}

export function parseMavenFocusedCommand(tokens: readonly string[]): MavenFocusedCommand | null {
    if (!MAVEN_RUNNER_PATTERN.test(tokens[0] || '')) return null;
    let project = '.';
    let selector = '';
    let projectSeen = false;
    let goal: MavenFocusedCommand['goal'] = null;
    let offline = false;
    const invalid = (): MavenFocusedCommand => ({ project, selector, goal, unsafeReason: MAVEN_UNSUPPORTED_COMMAND_REASON });
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '-o' || token === '--offline') {
            offline = true;
            continue;
        }
        if (token === 'test' || token === 'surefire:test') {
            if (goal) return invalid();
            goal = token;
            continue;
        }
        // Maven also recognizes single-hyphen long options and their abbreviations.
        const optionName = token.startsWith('-f') ? token.slice(1).split('=', 1)[0] : '';
        if (MAVEN_FAIL_OPTIONS.has(token) || (optionName.length > 1
            && MAVEN_FILE_OPTION_COLLISIONS.some((option) => option.startsWith(optionName)))) return invalid();
        const projectOperand = readMavenOperand(tokens, index, '-f', '--file');
        if (projectOperand) {
            if (projectSeen || !projectOperand.value || projectOperand.value.startsWith('-')) return invalid();
            project = projectOperand.value;
            projectSeen = true;
            index = projectOperand.endIndex;
            continue;
        }
        const testProperty = readMavenTestProperty(tokens, index);
        if (!testProperty || selector || !MAVEN_TEST_SELECTOR_PATTERN.test(testProperty.value)) return invalid();
        selector = testProperty.value;
        index = testProperty.endIndex;
    }
    return offline && goal && selector ? { project, selector, goal, unsafeReason: null } : invalid();
}

function isUnlinkedDirectoryPath(repoRoot: string, directory: string, allowMissing = false): boolean {
    if (!isPathRealpathInsideRoot(repoRoot, directory, { allowMissing })) return false;
    let current = path.resolve(repoRoot);
    for (const segment of path.relative(current, directory).split(path.sep)) {
        current = path.join(current, segment);
        let stats: fs.Stats;
        try {
            stats = fs.lstatSync(current);
        } catch (error: unknown) {
            if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return true;
            throw error;
        }
        if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    }
    return true;
}

function* readMavenPomTags(pom: string): Generator<string | null> {
    let offset = 0;
    while (offset < pom.length) {
        const start = pom.indexOf('<', offset);
        if (start < 0) return;
        const terminator = pom.startsWith('<!--', start) ? '-->'
            : pom.startsWith('<![CDATA[', start) ? ']]>' : pom.startsWith('<?', start) ? '?>' : null;
        if (terminator) {
            const end = pom.indexOf(terminator, start + 2);
            if (end < 0) {
                yield null;
                return;
            }
            offset = end + terminator.length;
            continue;
        }
        let quote = '';
        let end = start + 1;
        for (; end < pom.length; end += 1) {
            const character = pom[end];
            if (quote) {
                if (character === quote) quote = '';
            } else if (character === '"' || character === "'") {
                quote = character;
            } else if (character === '<') {
                yield null;
                return;
            } else if (character === '>') {
                break;
            }
        }
        if (end === pom.length) {
            yield null;
            return;
        }
        yield pom.slice(start, end + 1);
        offset = end + 1;
    }
}

function hasUnsupportedMavenLayout(pom: string): boolean {
    // Inspect element ancestry only; do not resolve Maven inheritance, properties or plugins.
    const element = /^<(\/?)((?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)(?=[\s/>])/u;
    const ancestors: string[] = [];
    let projectSeen = false;
    for (const token of readMavenPomTags(pom)) {
        if (token === null) return true;
        const parsed = element.exec(token);
        if (!parsed) return true;
        const [, closing, name] = parsed;
        const localName = name.split(':').pop()!;
        if (closing) {
            if (ancestors.pop() !== name) return true;
            continue;
        }
        if (ancestors.length === 0) {
            if (projectSeen || localName !== 'project') return true;
            projectSeen = true;
        }
        if (MAVEN_UNSUPPORTED_LAYOUT_ELEMENTS.has(localName)) return true;
        if (localName === 'directory' && (ancestors.length === 2 || ancestors.length === 4)) {
            const parentPath = ancestors.map((ancestor) => ancestor.split(':').pop()).join('/');
            if (parentPath === 'project/build' || parentPath === 'project/profiles/profile/build') return true;
        }
        if (!/\/>$/u.test(token)) ancestors.push(name);
    }
    return !projectSeen || ancestors.length !== 0;
}

function resolveMavenProjectRoot(command: MavenFocusedCommand, repoRoot: string): string | null {
    const projectPath = path.resolve(repoRoot, command.project);
    if (!isPathRealpathInsideRoot(repoRoot, projectPath)) return null;
    const stats = fs.lstatSync(projectPath);
    if (stats.isSymbolicLink()) return null;
    const pomPath = stats.isDirectory() ? path.join(projectPath, 'pom.xml') : projectPath;
    if (!isPathRealpathInsideRoot(repoRoot, pomPath)) return null;
    const pomStats = fs.lstatSync(pomPath);
    if (!pomStats.isFile() || pomStats.isSymbolicLink() || pomStats.size > MAVEN_MAX_POM_BYTES) return null;
    const pom = fs.readFileSync(pomPath, 'utf8');
    // These layouts need Maven model resolution before one local Java file can be authenticated.
    if (hasUnsupportedMavenLayout(pom)) return null;
    return path.dirname(pomPath);
}

function findMavenTestTargets(testRoot: string, repoRoot: string, selector: string, extension: '.java' | '.class'): string[] | null {
    const classSelector = selector.split('#', 1)[0].replace(/\.java$/u, '');
    const qualifiedPath = classSelector.includes('/') || classSelector.includes('.')
        ? `${classSelector.replace(/\./gu, '/')}${extension}` : null;
    const pending = [testRoot];
    const matches: string[] = [];
    let scannedEntries = 0;
    while (pending.length > 0) {
        const directory = pending.pop()!;
        if (!isPathRealpathInsideRoot(repoRoot, directory) || fs.lstatSync(directory).isSymbolicLink()) return null;
        const entries = fs.opendirSync(directory);
        try {
            let entry: fs.Dirent | null;
            while ((entry = entries.readSync()) !== null) {
                scannedEntries += 1;
                if (scannedEntries > MAVEN_MAX_SCANNED_ENTRIES) return null;
                const candidate = path.join(directory, entry.name);
                if (entry.isSymbolicLink()) return null;
                if (entry.isDirectory()) {
                    pending.push(candidate);
                } else if (entry.isFile() && (qualifiedPath
                    ? path.relative(testRoot, candidate).replace(/\\/gu, '/') === qualifiedPath
                    : entry.name === `${classSelector}${extension}`)) {
                    if (!isPathRealpathInsideRoot(repoRoot, candidate)) return null;
                    matches.push(path.relative(testRoot, candidate).replace(/\\/gu, '/'));
                    if (matches.length > 1) return null;
                }
            }
        } finally {
            entries.closeSync();
        }
    }
    return matches;
}

export function resolveMavenFocusedTargets(
    command: MavenFocusedCommand,
    repoRoot: string | undefined,
    isSafeRelativePath: (value: string) => boolean
): string[] {
    if (command.unsafeReason || !repoRoot) return [];
    const project = command.project.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '');
    if (project !== '.' && (!isSafeRelativePath(project) || /[:@*?\[\]{}$%~]/u.test(project))) return [];
    try {
        const projectRoot = resolveMavenProjectRoot({ ...command, project }, repoRoot);
        if (!projectRoot) return [];
        const testRoot = path.join(projectRoot, MAVEN_TEST_SOURCE_DIRECTORY);
        if (!isUnlinkedDirectoryPath(repoRoot, testRoot)) return [];
        const sources = findMavenTestTargets(testRoot, repoRoot, command.selector, '.java');
        if (!sources || sources.length !== 1) return [];
        const compiledRoot = path.join(projectRoot, MAVEN_TEST_CLASSES_DIRECTORY);
        if (!isUnlinkedDirectoryPath(repoRoot, compiledRoot, true)) return [];
        const classes = fs.existsSync(compiledRoot)
            ? findMavenTestTargets(compiledRoot, repoRoot, command.selector, '.class') : [];
        if (!classes || (command.goal === 'surefire:test' && classes.length !== 1)
            || (classes.length === 1 && classes[0] !== sources[0].replace(/\.java$/u, '.class'))) return [];
        return [path.relative(repoRoot, path.join(testRoot, sources[0])).replace(/\\/gu, '/')];
    } catch {
        return [];
    }
}
