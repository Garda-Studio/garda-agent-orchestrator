import * as path from 'node:path';
import { createRequire } from 'node:module';
import type ts from 'typescript';
import { readValidationFile, validationDigest } from '../project-validation-identity';
import { isPlainRecord } from '../records';

const requireCompiler = createRequire(__filename);
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** Reconstruct the existing Node foundation producer's bytes; a .js/.ts name resemblance is not proof. */
export function resolveNodeFoundationFailureSource(repoRoot: string, emittedPath: string): string | null {
    try {
        const root = path.resolve(repoRoot);
        const relative = path.relative(root, path.resolve(root, emittedPath)).replace(/\\/gu, '/');
        if (!relative.startsWith('.node-build/') || !relative.endsWith('.js')) return null;
        const observed = new Map<string, string>();
        const read = (file: string) => {
            const retained = readValidationFile(root, file, MAX_ARTIFACT_BYTES);
            observed.set(file, validationDigest(retained.identity));
            return retained;
        };
        const compiler = requireCompiler('../vendor-typescript.js') as typeof ts;
        const manifest: unknown = JSON.parse(read('.node-build/node-foundation-manifest.json').bytes.toString('utf8'));
        if (!isPlainRecord(manifest) || !Array.isArray(manifest.files)
            || !manifest.files.includes(relative.slice('.node-build/'.length)) || !isPlainRecord(manifest.inputFingerprint)
            || manifest.inputFingerprint.typescriptVersion !== compiler.version || !Array.isArray(manifest.inputFingerprint.files)) return null;
        const producerInputs = manifest.inputFingerprint.files;
        const configBytes = read('tsconfig.tests.json');
        const config = compiler.parseConfigFileTextToJson('tsconfig.tests.json', configBytes.bytes.toString('utf8'));
        if (config.error || !isPlainRecord(config.config) || config.config.extends !== undefined || config.config.references !== undefined) return null;
        const parsed = compiler.parseJsonConfigFileContent(config.config, compiler.sys, root, {}, path.join(root, 'tsconfig.tests.json'));
        if (parsed.errors.length || path.resolve(parsed.options.outDir ?? '') !== path.join(root, '.node-build')) return null;
        const emitted = read(relative), mapFile = read(`${relative}.map`);
        const sourceMap: unknown = JSON.parse(mapFile.bytes.toString('utf8'));
        if (!isPlainRecord(sourceMap) || sourceMap.version !== 3 || sourceMap.file !== path.basename(relative)
            || sourceMap.sourceRoot !== '' || !Array.isArray(sourceMap.sources) || sourceMap.sources.length !== 1
            || typeof sourceMap.sources[0] !== 'string' || sourceMap.sections !== undefined) return null;
        const sourcePath = path.relative(root, path.resolve(root, path.dirname(relative), sourceMap.sources[0])).replace(/\\/gu, '/');
        const source = read(sourcePath);
        for (const retained of [source, configBytes]) {
            const inputs = producerInputs.filter(input => isPlainRecord(input) && input.path === retained.identity.path);
            if (inputs.length !== 1 || inputs[0].sha256 !== retained.identity.sha256 || inputs[0].size !== retained.identity.size) return null;
        }
        const outputs = compiler.getOutputFileNames(parsed, path.resolve(root, sourcePath), !compiler.sys.useCaseSensitiveFileNames);
        if (!outputs.some(output => path.resolve(output) === path.resolve(root, relative))) return null;
        const reconstructed = compiler.transpileModule(source.bytes.toString('utf8'), {
            fileName: path.resolve(root, sourcePath), compilerOptions: parsed.options, reportDiagnostics: true
        });
        if (reconstructed.diagnostics?.some(item => item.category === compiler.DiagnosticCategory.Error)
            || reconstructed.outputText !== emitted.bytes.toString('utf8') || !reconstructed.sourceMapText) return null;
        const reconstructedMap = JSON.parse(reconstructed.sourceMapText) as Record<string, unknown>;
        if (sourceMap.mappings !== reconstructedMap.mappings || validationDigest(sourceMap.names) !== validationDigest(reconstructedMap.names)) return null;
        for (const [file, identity] of observed) {
            if (validationDigest(readValidationFile(root, file, MAX_ARTIFACT_BYTES).identity) !== identity) return null;
        }
        return sourcePath;
    } catch { return null; }
}
