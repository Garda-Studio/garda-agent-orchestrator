const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
    acquireBuildRootLock,
    getBuildRootLockPath,
    releaseBuildRootLock,
    resetBuildRoot,
    sleepSync
} = require('./build-root-lock.cjs');

const SCRIPT_RUNTIME_SUPPORT_FILES = Object.freeze(['build-root-lock.cjs']);
const SCRIPTS_BUILD_FINGERPRINT_SCHEMA_VERSION = 1;
const SCRIPTS_BUILD_FINGERPRINT_PATH = 'scripts-build-fingerprint.json';
const SCRIPTS_BUILD_FORCE_REBUILD_ENV = 'GARDA_BUILD_SCRIPTS_FORCE_REBUILD';
const SCRIPTS_BUILD_PROCESS_TIMEOUT_MS_ENV = 'GARDA_BUILD_SCRIPTS_PROCESS_TIMEOUT_MS';
const DEFAULT_SCRIPTS_BUILD_PROCESS_TIMEOUT_MS = 15 * 60 * 1000;
const UNLIMITED_PROCESS_TIMEOUT_MS = 0;
const INPUT_FILE_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.ts']);

function appendTraceLine(tracePath, message) {
    if (!tracePath) {
        return;
    }

    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.appendFileSync(tracePath, `${message}\n`, 'utf8');
}

function readPositiveIntegerEnv(name, fallbackValue) {
    const rawValue = process.env[name];
    if (!rawValue) {
        return fallbackValue;
    }
    const parsedValue = Number(rawValue);
    if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return parsedValue;
}

function formatCommand(command, args) {
    return [command, ...args].join(' ');
}

function resolveEntryProcessTimeoutMs(entryScript) {
    return entryScript === 'test.js' || entryScript === 'coverage.js'
        ? UNLIMITED_PROCESS_TIMEOUT_MS
        : undefined;
}

function runProcess(command, args, cwd, options = {}) {
    const timeoutMs = options.timeoutMs ?? readPositiveIntegerEnv(
        SCRIPTS_BUILD_PROCESS_TIMEOUT_MS_ENV,
        DEFAULT_SCRIPTS_BUILD_PROCESS_TIMEOUT_MS
    );
    const spawnOptions = {
        cwd,
        stdio: 'inherit',
        windowsHide: true
    };
    if (timeoutMs > UNLIMITED_PROCESS_TIMEOUT_MS) {
        spawnOptions.timeout = timeoutMs;
    }
    const result = childProcess.spawnSync(command, args, spawnOptions);
    if (result.error && result.error.code === 'ETIMEDOUT') {
        throw new Error(`${path.basename(command)} timed out after ${timeoutMs} ms: ${formatCommand(command, args)}`);
    }
    if (result.error) {
        throw new Error(`${path.basename(command)} failed to start: ${result.error.message}`);
    }
    if (result.signal === 'SIGTERM') {
        const timeoutDiagnostic = timeoutMs > UNLIMITED_PROCESS_TIMEOUT_MS
            ? ` after ${timeoutMs} ms`
            : '';
        throw new Error(`${path.basename(command)} timed out or terminated${timeoutDiagnostic}: ${formatCommand(command, args)}`);
    }
    if (result.status !== 0) {
        throw new Error(`${path.basename(command)} failed (exit ${result.status})`);
    }
}

function toRepoRelativePath(repoRoot, filePath) {
    return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function hashText(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJsonFileIfExists(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function readTypescriptVersion(repoRoot) {
    const pkg = readJsonFileIfExists(path.join(repoRoot, 'node_modules', 'typescript', 'package.json'));
    return pkg && typeof pkg.version === 'string' ? pkg.version : 'unknown';
}

function shouldFingerprintFile(filePath) {
    return INPUT_FILE_EXTENSIONS.has(path.extname(filePath));
}

function collectInputFiles(repoRoot, inputPaths) {
    const files = [];
    const visit = (absolutePath) => {
        if (!fs.existsSync(absolutePath)) {
            return;
        }
        const stat = fs.statSync(absolutePath);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === '.git') {
                    continue;
                }
                visit(path.join(absolutePath, entry.name));
            }
            return;
        }
        if (stat.isFile() && shouldFingerprintFile(absolutePath)) {
            files.push(absolutePath);
        }
    };

    for (const inputPath of inputPaths) {
        visit(path.join(repoRoot, ...inputPath.split('/')));
    }
    return Array.from(new Set(files.map((filePath) => path.resolve(filePath)))).sort((a, b) =>
        toRepoRelativePath(repoRoot, a).localeCompare(toRepoRelativePath(repoRoot, b))
    );
}

function buildScriptsInputFingerprint(repoRoot) {
    const files = collectInputFiles(repoRoot, [
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'tsconfig.scripts.json',
        'src/bin',
        'src/core',
        'scripts/node-foundation'
    ]).map((filePath) => {
        const stat = fs.statSync(filePath);
        return {
            path: toRepoRelativePath(repoRoot, filePath),
            size: stat.size,
            sha256: hashFile(filePath)
        };
    });
    const payload = {
        schemaVersion: SCRIPTS_BUILD_FINGERPRINT_SCHEMA_VERSION,
        kind: 'scripts-build',
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        typescriptVersion: readTypescriptVersion(repoRoot),
        fileCount: files.length,
        files
    };
    return {
        ...payload,
        sha256: hashText(JSON.stringify(payload))
    };
}

function writeScriptsBuildFingerprint(buildRoot, fingerprint) {
    fs.writeFileSync(
        path.join(buildRoot, SCRIPTS_BUILD_FINGERPRINT_PATH),
        `${JSON.stringify(fingerprint, null, 2)}\n`,
        'utf8'
    );
}

function getScriptsBuildReuseStatus(repoRoot, buildRoot, compiledEntryPath, fingerprint) {
    if (process.env[SCRIPTS_BUILD_FORCE_REBUILD_ENV] === '1') {
        return { accepted: false, reason: `${SCRIPTS_BUILD_FORCE_REBUILD_ENV}=1` };
    }
    const existing = readJsonFileIfExists(path.join(buildRoot, SCRIPTS_BUILD_FINGERPRINT_PATH));
    if (!existing || existing.sha256 !== fingerprint.sha256) {
        return { accepted: false, reason: 'input_fingerprint_mismatch' };
    }
    if (!fs.existsSync(compiledEntryPath) || !fs.statSync(compiledEntryPath).isFile()) {
        return { accepted: false, reason: 'compiled_entry_missing' };
    }
    for (const fileName of SCRIPT_RUNTIME_SUPPORT_FILES) {
        const supportPath = path.join(buildRoot, 'scripts', 'node-foundation', fileName);
        if (!fs.existsSync(supportPath) || !fs.statSync(supportPath).isFile()) {
            return { accepted: false, reason: 'script_support_missing' };
        }
    }
    const compiledCliPath = path.join(repoRoot, '.scripts-build', 'src', 'bin', 'garda.js');
    if (!fs.existsSync(compiledCliPath) || !fs.statSync(compiledCliPath).isFile()) {
        return { accepted: false, reason: 'compiled_cli_missing' };
    }
    return { accepted: true, reason: 'input_fingerprint_match' };
}

function printScriptsBuildReuseDiagnostic(reuseStatus, fingerprint) {
    const status = reuseStatus.accepted ? 'accepted' : 'rejected';
    console.log(`SCRIPTS_BUILD_REUSE ${status} reason=${reuseStatus.reason} fingerprint=${fingerprint.sha256.slice(0, 16)}`);
}

function copyScriptRuntimeSupportFiles(repoRoot, buildRoot) {
    const compiledScriptsRoot = path.join(buildRoot, 'scripts', 'node-foundation');
    fs.mkdirSync(compiledScriptsRoot, { recursive: true });

    for (const fileName of SCRIPT_RUNTIME_SUPPORT_FILES) {
        const sourcePath = path.join(repoRoot, 'scripts', 'node-foundation', fileName);
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Script runtime support file not found: ${sourcePath}`);
        }
        fs.copyFileSync(sourcePath, path.join(compiledScriptsRoot, fileName));
    }
}

function main() {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const buildRoot = path.join(repoRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);
    const tracePath = process.env.GARDA_BUILD_SCRIPTS_TRACE_FILE || '';
    const holdMs = Number(process.env.GARDA_BUILD_SCRIPTS_LOCK_HOLD_MS || '0');
    const tscCliPath = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const entryArguments = process.argv.slice(2);
    const entryScript = entryArguments[0] || 'build.js';
    const entryArgs = entryArguments.length > 0 ? entryArguments.slice(1) : ['sync-repo-cli'];
    const compiledEntryPath = path.join(repoRoot, '.scripts-build', 'scripts', 'node-foundation', entryScript);
    const entryProcessOptions = { timeoutMs: resolveEntryProcessTimeoutMs(entryScript) };

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    acquireBuildRootLock(lockPath);
    appendTraceLine(tracePath, `acquired ${process.pid} ${Date.now()}`);
    try {
        if (holdMs > 0) {
            sleepSync(holdMs);
        }
        const fingerprint = buildScriptsInputFingerprint(repoRoot);
        const reuseStatus = getScriptsBuildReuseStatus(repoRoot, buildRoot, compiledEntryPath, fingerprint);
        printScriptsBuildReuseDiagnostic(reuseStatus, fingerprint);
        if (reuseStatus.accepted) {
            runProcess(process.execPath, [compiledEntryPath, ...entryArgs], repoRoot, entryProcessOptions);
            return;
        }
        resetBuildRoot(buildRoot);
        runProcess(process.execPath, [tscCliPath, '-p', 'tsconfig.scripts.json', '--outDir', '.scripts-build'], repoRoot);
        copyScriptRuntimeSupportFiles(repoRoot, buildRoot);
        writeScriptsBuildFingerprint(buildRoot, fingerprint);
        runProcess(process.execPath, [compiledEntryPath, ...entryArgs], repoRoot, entryProcessOptions);
    } finally {
        appendTraceLine(tracePath, `released ${process.pid} ${Date.now()}`);
        releaseBuildRootLock(lockPath);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    buildScriptsInputFingerprint,
    DEFAULT_SCRIPTS_BUILD_PROCESS_TIMEOUT_MS,
    getScriptsBuildReuseStatus,
    main,
    resolveEntryProcessTimeoutMs,
    runProcess
};
