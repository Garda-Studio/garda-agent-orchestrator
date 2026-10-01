import { createRequire } from 'node:module';
import * as path from 'node:path';
import type ts from 'typescript';

const requireParser = createRequire(__filename);

function hasValidSyntax(parser: typeof ts, sourceFile: ts.SourceFile): boolean {
    const filename = sourceFile.fileName;
    const host: ts.CompilerHost = {
        getSourceFile: (name) => name === filename ? sourceFile : undefined,
        getDefaultLibFileName: () => '',
        writeFile: () => undefined,
        getCurrentDirectory: () => '',
        getCanonicalFileName: (name) => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        fileExists: (name) => name === filename,
        readFile: (name) => name === filename ? sourceFile.text : undefined
    };
    const program = parser.createProgram([filename], {
        noLib: true, noResolve: true, noEmit: true, types: [], allowJs: true,
        target: parser.ScriptTarget.Latest, jsx: parser.JsxEmit.Preserve
    }, host);
    return program.getSyntacticDiagnostics(sourceFile).length === 0;
}

function hasValidRegexLiteral(text: string): boolean {
    const delimiter = text.lastIndexOf('/');
    if (delimiter <= 0) return false;
    try {
        // Compilation validates the complete pattern and flags without running matches.
        new RegExp(text.slice(1, delimiter), text.slice(delimiter + 1));
        return true;
    } catch {
        return false;
    }
}

function maskParsedLiterals(parser: typeof ts, sourceFile: ts.SourceFile): string | null {
    const spans: Array<{ start: number; end: number }> = [];
    let valid = true;
    const visit = (node: ts.Node): void => {
        if (parser.isRegularExpressionLiteral(node)) {
            if (!hasValidRegexLiteral(node.getText(sourceFile))) valid = false;
            spans.push({ start: node.getStart(sourceFile), end: node.end });
        } else if (parser.isTemplateExpression(node) || parser.isNoSubstitutionTemplateLiteral(node)
            || parser.isJsxElement(node) || parser.isJsxSelfClosingElement(node) || parser.isJsxFragment(node)
            || parser.isMethodDeclaration(node) || parser.isGetAccessorDeclaration(node)
            || parser.isSetAccessorDeclaration(node) || parser.isConstructorDeclaration(node)
            || parser.isClassStaticBlockDeclaration(node)) {
            spans.push({ start: node.getStart(sourceFile), end: node.end });
        }
        // Inspect executable substitutions even when their enclosing literal is masked.
        parser.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (!valid) return null;
    spans.sort((left, right) => left.start - right.start || right.end - left.end);
    const chunks: string[] = [];
    let cursor = 0;
    for (const span of spans) {
        if (span.start < cursor) continue;
        chunks.push(sourceFile.text.slice(cursor, span.start), 'r', ' '.repeat(span.end - span.start - 1));
        cursor = span.end;
    }
    return chunks.join('') + sourceFile.text.slice(cursor);
}

/** Preserve offsets and exact test names while hiding literals and nested method bodies. */
export function maskTestEvidenceRegexLiterals(source: string, evidenceFile: string): string | null {
    try {
        // Builds include this compiler library so deployed runtimes need no development install.
        const parser = requireParser('./vendor-typescript.js') as typeof ts;
        const sourceFile = parser.createSourceFile(
            `test-evidence${path.extname(evidenceFile)}`, source, parser.ScriptTarget.Latest, true
        );
        if (!hasValidSyntax(parser, sourceFile)) return null;
        return maskParsedLiterals(parser, sourceFile);
    } catch {
        return null;
    }
}
