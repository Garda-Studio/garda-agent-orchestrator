import fs from 'node:fs';
import path from 'node:path';

export interface LocalUiLocalizedText {
    label?: string;
    description?: string;
    title?: string;
    body?: string;
    options?: Record<string, {
        label: string;
        description?: string;
    }>;
}

const PACK_FILE_PATTERN = /^garda-ui-(.+)\.json$/u;
const BUILTIN_LANGUAGE_IDS = new Set(['en']);

export interface UiLanguagePackDescriptor {
    readonly id: string;
    readonly label: string;
    readonly nativeLabel: string;
}

export interface ImportedUiLanguagePack {
    readonly language: UiLanguagePackDescriptor;
    readonly LOCAL_UI_TEXT: Readonly<Record<string, string>>;
    readonly LOCAL_UI_SETTING_TEXT: Readonly<Record<string, LocalUiLocalizedText>>;
    readonly LOCAL_UI_ACTION_TEXT: Readonly<Record<string, LocalUiLocalizedText>>;
    readonly LOCAL_UI_INIT_SETTING_TEXT: Readonly<Record<string, LocalUiLocalizedText>>;
    readonly LOCAL_UI_PROJECT_MEMORY_TEXT: Readonly<Record<string, LocalUiLocalizedText>>;
    readonly LOCAL_UI_ACTION_CATEGORY_TEXT: Readonly<Record<string, string>>;
    readonly LOCAL_UI_INSTRUCTION_TEXT: Readonly<Record<string, LocalUiLocalizedText>>;
    readonly LOCAL_UI_TASK_CLOSURE_POLICY_TEXT: Readonly<Record<string, string>>;
    readonly LOCAL_UI_TASK_PROGRESS_TEXT: Readonly<Record<string, string>>;
}

interface UiLanguagePackFile {
    language: UiLanguagePackDescriptor;
    LOCAL_UI_TEXT: Record<string, string>;
    LOCAL_UI_SETTING_TEXT?: Record<string, LocalUiLocalizedText>;
    LOCAL_UI_ACTION_TEXT?: Record<string, LocalUiLocalizedText>;
    LOCAL_UI_INIT_SETTING_TEXT?: Record<string, LocalUiLocalizedText>;
    LOCAL_UI_PROJECT_MEMORY_TEXT?: Record<string, LocalUiLocalizedText>;
    LOCAL_UI_ACTION_CATEGORY_TEXT?: Record<string, string>;
    LOCAL_UI_INSTRUCTION_TEXT?: Record<string, LocalUiLocalizedText>;
    LOCAL_UI_TASK_CLOSURE_POLICY_TEXT?: Record<string, string>;
    LOCAL_UI_TASK_PROGRESS_TEXT?: Record<string, string>;
}

function resolveLangPacksDirectory(): string {
    const besideModule = path.join(__dirname, 'lang-packs');
    if (fs.existsSync(besideModule)) {
        return besideModule;
    }

    const fromRepoSource = path.resolve(__dirname, '..', '..', '..', 'src', 'reports', 'ui', 'lang-packs');
    if (fs.existsSync(fromRepoSource)) {
        return fromRepoSource;
    }

    throw new Error('UI language packs directory not found beside ui-language-pack-loader or under src/reports/ui/lang-packs.');
}

function readPackFile(filePath: string): UiLanguagePackFile {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed == null || typeof parsed !== 'object') {
        throw new Error(`UI language pack must be a JSON object: ${filePath}`);
    }

    const pack = parsed as UiLanguagePackFile;
    if (pack.language == null || pack.language.id.trim() === '') {
        throw new Error(`UI language pack is missing language.id: ${filePath}`);
    }
    if (pack.LOCAL_UI_TEXT == null || typeof pack.LOCAL_UI_TEXT !== 'object') {
        throw new Error(`UI language pack is missing LOCAL_UI_TEXT: ${filePath}`);
    }

    return pack;
}

function assertPackTextKeys(languageId: string, packKeys: string[], englishKeys: string[], filePath: string): void {
    const missingKeys = englishKeys.filter((key) => !packKeys.includes(key));
    const extraKeys = packKeys.filter((key) => !englishKeys.includes(key));
    if (missingKeys.length > 0 || extraKeys.length > 0) {
        throw new Error(
            `UI language pack '${languageId}' in ${filePath} is incomplete. Missing: ${missingKeys.join(', ') || 'none'}; extra: ${extraKeys.join(', ') || 'none'}.`
        );
    }
}

function normalizePack(pack: UiLanguagePackFile): ImportedUiLanguagePack {
    const languageId = pack.language.id;

    return Object.freeze({
        language: Object.freeze({
            id: languageId,
            label: pack.language.label,
            nativeLabel: pack.language.nativeLabel
        }),
        LOCAL_UI_TEXT: Object.freeze({ ...pack.LOCAL_UI_TEXT }),
        LOCAL_UI_SETTING_TEXT: Object.freeze({ ...(pack.LOCAL_UI_SETTING_TEXT || {}) }),
        LOCAL_UI_ACTION_TEXT: Object.freeze({ ...(pack.LOCAL_UI_ACTION_TEXT || {}) }),
        LOCAL_UI_INIT_SETTING_TEXT: Object.freeze({ ...(pack.LOCAL_UI_INIT_SETTING_TEXT || {}) }),
        LOCAL_UI_PROJECT_MEMORY_TEXT: Object.freeze({ ...(pack.LOCAL_UI_PROJECT_MEMORY_TEXT || {}) }),
        LOCAL_UI_ACTION_CATEGORY_TEXT: Object.freeze({ ...(pack.LOCAL_UI_ACTION_CATEGORY_TEXT || {}) }),
        LOCAL_UI_INSTRUCTION_TEXT: Object.freeze({ ...(pack.LOCAL_UI_INSTRUCTION_TEXT || {}) }),
        LOCAL_UI_TASK_CLOSURE_POLICY_TEXT: Object.freeze({
            ...(pack.LOCAL_UI_TASK_CLOSURE_POLICY_TEXT || {})
        }),
        LOCAL_UI_TASK_PROGRESS_TEXT: Object.freeze({
            ...(pack.LOCAL_UI_TASK_PROGRESS_TEXT || {})
        })
    });
}

export function loadImportedUiLanguagePacks(englishTextKeys: readonly string[]): readonly ImportedUiLanguagePack[] {
    const directory = resolveLangPacksDirectory();
    const packs: ImportedUiLanguagePack[] = [];

    for (const fileName of fs.readdirSync(directory).sort()) {
        const match = PACK_FILE_PATTERN.exec(fileName);
        if (!match) {
            continue;
        }

        const languageId = match[1];
        if (BUILTIN_LANGUAGE_IDS.has(languageId)) {
            continue;
        }

        const filePath = path.join(directory, fileName);
        const pack = readPackFile(filePath);
        if (pack.language.id !== languageId) {
            throw new Error(`UI language pack id mismatch in ${filePath}: filename=${languageId}, language.id=${pack.language.id}`);
        }

        assertPackTextKeys(languageId, Object.keys(pack.LOCAL_UI_TEXT).sort(), [...englishTextKeys].sort(), filePath);
        packs.push(normalizePack(pack));
    }

    return Object.freeze(packs);
}

export function copyUiLanguagePacksToBuildOutput(repoRoot: string, buildRoot: string): void {
    const sourceDirectory = path.join(repoRoot, 'src', 'reports', 'ui', 'lang-packs');
    const destinationDirectory = path.join(buildRoot, 'src', 'reports', 'ui', 'lang-packs');
    if (!fs.existsSync(sourceDirectory)) {
        throw new Error(`Missing UI language packs source directory: ${sourceDirectory}`);
    }

    fs.mkdirSync(destinationDirectory, { recursive: true });
    for (const fileName of fs.readdirSync(sourceDirectory)) {
        if (!PACK_FILE_PATTERN.test(fileName)) {
            continue;
        }
        fs.copyFileSync(path.join(sourceDirectory, fileName), path.join(destinationDirectory, fileName));
    }
}
