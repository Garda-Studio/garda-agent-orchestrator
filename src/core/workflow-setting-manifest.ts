export const WORKFLOW_SETTING_VALUE_TYPES = Object.freeze([
    'boolean',
    'enum',
    'enum_list',
    'integer',
    'string',
    'string_list'
] as const);

export type WorkflowSettingValueType = (typeof WORKFLOW_SETTING_VALUE_TYPES)[number];
export interface WorkflowSettingValueByType {
    boolean: boolean;
    enum: string;
    enum_list: readonly string[];
    integer: number;
    string: string;
    string_list: readonly string[];
}
export type WorkflowSettingValue = WorkflowSettingValueByType[WorkflowSettingValueType];

export type WorkflowSettingOwner =
    | Readonly<{ kind: 'workflow'; section: string }>
    | Readonly<{ kind: 'catalog-backed'; catalog: 'review'; entry_id: string }>
    | Readonly<{ kind: 'review-lane'; lane_id: string }>;

export interface WorkflowSettingCliMetadata {
    flag: `--${string}`;
    value_name?: string;
}

export interface WorkflowSettingUiMetadata {
    group: string;
    label: string;
    description: string;
    control: WorkflowSettingUiControl;
    options?: readonly WorkflowSettingOption[];
    min?: number;
    max?: number;
    placeholder?: string;
    editable?: boolean;
}

export interface WorkflowSettingOption {
    value: string;
    label: string;
    description: string;
}

export type WorkflowSettingUiControl = 'checkbox' | 'number' | 'select' | 'text' | 'text_list';

export interface WorkflowSettingMaterialization {
    path: string;
    value: unknown;
}

export interface WorkflowSettingMaterializationContext {
    target: 'live' | 'template';
}

export interface WorkflowSettingManifestEntry<
    TValueType extends WorkflowSettingValueType = WorkflowSettingValueType
> {
    id: string;
    key: string;
    owner: WorkflowSettingOwner;
    value_type: TValueType;
    exposure: 'operator-visible';
    default_value: WorkflowSettingValueByType[TValueType];
    validate(value: unknown): value is WorkflowSettingValueByType[TValueType];
    cli: Readonly<WorkflowSettingCliMetadata>;
    ui: Readonly<WorkflowSettingUiMetadata>;
    materialize(
        value: WorkflowSettingValueByType[TValueType],
        context: Readonly<WorkflowSettingMaterializationContext>
    ): readonly WorkflowSettingMaterialization[];
}

export interface WorkflowSettingRegistry {
    readonly entries: readonly WorkflowSettingManifestEntry[];
    get(id: string): WorkflowSettingManifestEntry | null;
    require(id: string): WorkflowSettingManifestEntry;
    validate(id: string, value: unknown): WorkflowSettingValue;
    materialize(
        id: string,
        value: unknown,
        context: Readonly<WorkflowSettingMaterializationContext>
    ): readonly WorkflowSettingMaterialization[];
}

const STABLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CONFIG_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const OWNER_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const CONFIG_PATH_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const SENSITIVE_TOKEN_PATTERN = /(?:^|[._-])(?:bearer|credentials?|dsn|passphrase|passwd|password|secret|token|(?:access|api|client|encryption|private|session|signing|ssh)[._-]?keys?|connection[._-]?strings?|cookies?|session[._-]?ids?)(?:$|[._-])/iu;
const CLI_FLAG_PATTERN = /^--[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const UI_CONTROLS = Object.freeze<readonly WorkflowSettingUiControl[]>([
    'checkbox',
    'number',
    'select',
    'text',
    'text_list'
]);

function freezeUiControls(...controls: WorkflowSettingUiControl[]): readonly WorkflowSettingUiControl[] {
    return Object.freeze(controls);
}

const UI_CONTROLS_BY_VALUE_TYPE: Readonly<
    Record<WorkflowSettingValueType, readonly WorkflowSettingUiControl[]>
> = Object.freeze({
    boolean: freezeUiControls('checkbox'),
    enum: freezeUiControls('select'),
    enum_list: freezeUiControls('select'),
    integer: freezeUiControls('number'),
    string: freezeUiControls('text'),
    string_list: freezeUiControls('text_list')
});

function requireBoundedString(value: unknown, label: string, maximumLength: number): string {
    if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maximumLength) {
        throw new Error(`${label} must be a non-empty trimmed string with at most ${maximumLength} characters.`);
    }
    return value;
}

function assertOwner(owner: WorkflowSettingOwner, label: string): void {
    if (!owner || typeof owner !== 'object') {
        throw new Error(`${label}.owner must be an object.`);
    }
    if (owner.kind === 'workflow') {
        if (!OWNER_ID_PATTERN.test(requireBoundedString(owner.section, `${label}.owner.section`, 80))) {
            throw new Error(`${label}.owner.section must be a stable identifier.`);
        }
        return;
    }
    if (owner.kind === 'catalog-backed') {
        if (owner.catalog !== 'review') {
            throw new Error(`${label}.owner.catalog must reference the review catalog.`);
        }
        if (!OWNER_ID_PATTERN.test(requireBoundedString(owner.entry_id, `${label}.owner.entry_id`, 80))) {
            throw new Error(`${label}.owner.entry_id must be a stable catalog reference.`);
        }
        return;
    }
    if (owner.kind === 'review-lane') {
        if (!OWNER_ID_PATTERN.test(requireBoundedString(owner.lane_id, `${label}.owner.lane_id`, 80))) {
            throw new Error(`${label}.owner.lane_id must be a stable lane reference.`);
        }
        return;
    }
    throw new Error(`${label}.owner.kind is unsupported.`);
}

function isDenseStringArray(value: unknown): value is readonly string[] {
    if (!Array.isArray(value)) {
        return false;
    }
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index) || typeof value[index] !== 'string') {
            return false;
        }
    }
    return true;
}

function isValueTypeCompatible(valueType: WorkflowSettingValueType, value: unknown): value is WorkflowSettingValue {
    switch (valueType) {
        case 'boolean':
            return typeof value === 'boolean';
        case 'integer':
            return typeof value === 'number' && Number.isSafeInteger(value);
        case 'enum':
        case 'string':
            return typeof value === 'string';
        case 'enum_list':
        case 'string_list':
            return isDenseStringArray(value);
    }
}

function assertOptionalUiMetadata(entry: WorkflowSettingManifestEntry, label: string): void {
    const ui = entry.ui;
    if (ui.options !== undefined) {
        if (!Array.isArray(ui.options)) throw new Error(`${label}.ui.options must be an array.`);
        const values = new Set<string>();
        for (let index = 0; index < ui.options.length; index += 1) {
            const option = ui.options[index];
            const subject = `${label}.ui.options[${index}]`;
            const value = requireBoundedString(option?.value, `${subject}.value`, 160);
            requireBoundedString(option?.label, `${subject}.label`, 120);
            requireBoundedString(option?.description, `${subject}.description`, 1000);
            if (values.has(value)) throw new Error(`${label}.ui.options contains duplicate value '${value}'.`);
            values.add(value);
        }
        if (values.size > 0 && !['boolean', 'enum', 'enum_list'].includes(entry.value_type)) {
            throw new Error(`${label}.ui.options is incompatible with value_type '${entry.value_type}'.`);
        }
        if (entry.value_type === 'boolean' && [...values].some(value => value !== 'true' && value !== 'false')) {
            throw new Error(`${label}.ui.options boolean values must be true or false.`);
        }
        if (values.size > 0 && ['enum', 'enum_list'].includes(entry.value_type)) {
            const defaults = Array.isArray(entry.default_value) ? entry.default_value : [entry.default_value];
            if (defaults.some(value => !values.has(String(value)))) {
                throw new Error(`${label}.default_value must appear in ui.options.`);
            }
        }
    }
    for (const field of ['min', 'max'] as const) {
        if (ui[field] !== undefined && (entry.value_type !== 'integer' || !Number.isSafeInteger(ui[field]))) {
            throw new Error(`${label}.ui.${field} requires a safe integer for an integer setting.`);
        }
    }
    if (ui.min !== undefined && ui.max !== undefined && ui.min > ui.max) {
        throw new Error(`${label}.ui.min must not exceed ui.max.`);
    }
    if (typeof entry.default_value === 'number' && (
        (ui.min !== undefined && entry.default_value < ui.min)
        || (ui.max !== undefined && entry.default_value > ui.max)
    )) throw new Error(`${label}.default_value must stay within ui bounds.`);
    if (ui.placeholder !== undefined) requireBoundedString(ui.placeholder, `${label}.ui.placeholder`, 1000);
    if (ui.editable !== undefined && typeof ui.editable !== 'boolean') {
        throw new Error(`${label}.ui.editable must be a boolean.`);
    }
}

function assertEntry(entry: WorkflowSettingManifestEntry, index: number): void {
    const label = `workflow-setting manifest[${index}]`;
    const id = requireBoundedString(entry.id, `${label}.id`, 80);
    const key = requireBoundedString(entry.key, `${label}.key`, 160);
    if (!STABLE_ID_PATTERN.test(id)) {
        throw new Error(`${label}.id must be a stable lowercase kebab-case identifier.`);
    }
    if (!CONFIG_KEY_PATTERN.test(key)) {
        throw new Error(`${label}.key must be a dotted lowercase configuration key.`);
    }
    if (SENSITIVE_TOKEN_PATTERN.test(id) || SENSITIVE_TOKEN_PATTERN.test(key)) {
        throw new Error(`${label} cannot register secret-bearing settings.`);
    }
    if (!WORKFLOW_SETTING_VALUE_TYPES.includes(entry.value_type)) {
        throw new Error(`${label}.value_type is unsupported.`);
    }
    if (entry.exposure !== 'operator-visible') {
        throw new Error(`${label}.exposure must be operator-visible.`);
    }
    assertOwner(entry.owner, label);
    if (
        !isValueTypeCompatible(entry.value_type, entry.default_value)
        || typeof entry.validate !== 'function'
        || !entry.validate(entry.default_value)
    ) {
        throw new Error(`${label}.default_value must satisfy its declared value_type and validator.`);
    }
    if (typeof entry.materialize !== 'function') {
        throw new Error(`${label}.materialize must be a function.`);
    }
    const cliFlag = requireBoundedString(entry.cli?.flag, `${label}.cli.flag`, 100);
    if (!CLI_FLAG_PATTERN.test(cliFlag)) {
        throw new Error(`${label}.cli.flag must be a stable long CLI flag.`);
    }
    if (SENSITIVE_TOKEN_PATTERN.test(cliFlag)) {
        throw new Error(`${label} cannot register secret-bearing settings.`);
    }
    if (entry.cli.value_name !== undefined) {
        const valueName = requireBoundedString(entry.cli.value_name, `${label}.cli.value_name`, 80);
        if (SENSITIVE_TOKEN_PATTERN.test(valueName)) {
            throw new Error(`${label} cannot register secret-bearing settings.`);
        }
    }
    requireBoundedString(entry.ui?.group, `${label}.ui.group`, 80);
    requireBoundedString(entry.ui?.label, `${label}.ui.label`, 120);
    requireBoundedString(entry.ui?.description, `${label}.ui.description`, 1000);
    if (!UI_CONTROLS.includes(entry.ui?.control)) {
        throw new Error(`${label}.ui.control is unsupported.`);
    }
    if (!UI_CONTROLS_BY_VALUE_TYPE[entry.value_type].includes(entry.ui.control)) {
        throw new Error(`${label}.ui.control is incompatible with value_type '${entry.value_type}'.`);
    }
    assertOptionalUiMetadata(entry, label);
}

function requireValidValue(entry: WorkflowSettingManifestEntry, value: unknown): WorkflowSettingValue {
    if (!isValueTypeCompatible(entry.value_type, value) || !entry.validate(value)) {
        throw new Error(`Invalid value for workflow setting '${entry.id}'.`);
    }
    return value;
}

function assertMaterializationContext(
    entry: WorkflowSettingManifestEntry,
    context: unknown
): asserts context is WorkflowSettingMaterializationContext {
    if (
        !context
        || typeof context !== 'object'
        || !('target' in context)
        || (context.target !== 'live' && context.target !== 'template')
    ) {
        throw new Error(
            `Invalid materialization context for workflow setting '${entry.id}': target must be 'live' or 'template'.`
        );
    }
}

function freezeEntry(entry: WorkflowSettingManifestEntry): WorkflowSettingManifestEntry {
    return Object.freeze({
        ...entry,
        owner: Object.freeze({ ...entry.owner }),
        cli: Object.freeze({ ...entry.cli }),
        ui: Object.freeze({
            ...entry.ui,
            ...(entry.ui.options !== undefined ? {
                options: Object.freeze(entry.ui.options.map(option => Object.freeze({
                    value: option.value, label: option.label, description: option.description
                })))
            } : {})
        }),
        default_value: Array.isArray(entry.default_value)
            ? Object.freeze([...entry.default_value])
            : entry.default_value
    });
}

function freezeMaterializations(
    entry: WorkflowSettingManifestEntry,
    materializations: readonly WorkflowSettingMaterialization[]
): readonly WorkflowSettingMaterialization[] {
    if (!Array.isArray(materializations) || materializations.length === 0 || materializations.length > 16) {
        throw new Error(`Workflow setting '${entry.id}' must materialize between 1 and 16 bounded changes.`);
    }
    const seenPaths = new Set<string>();
    const frozenMaterializations: WorkflowSettingMaterialization[] = [];
    for (let index = 0; index < materializations.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(materializations, index)) {
            throw new Error(`Workflow setting '${entry.id}' materialization[${index}] must be present.`);
        }
        const materialization = materializations[index];
        const path = requireBoundedString(materialization?.path, `Workflow setting '${entry.id}' materialization[${index}].path`, 200);
        if (!CONFIG_PATH_PATTERN.test(path) || SENSITIVE_TOKEN_PATTERN.test(path)) {
            throw new Error(`Workflow setting '${entry.id}' produced an invalid or secret-bearing materialization path '${path}'.`);
        }
        if (seenPaths.has(path)) {
            throw new Error(`Workflow setting '${entry.id}' produced duplicate materialization path '${path}'.`);
        }
        seenPaths.add(path);
        frozenMaterializations.push(Object.freeze({ path, value: materialization.value }));
    }
    return Object.freeze(frozenMaterializations);
}

export function createWorkflowSettingRegistry(
    definitions: readonly WorkflowSettingManifestEntry[]
): WorkflowSettingRegistry {
    const entries = definitions.map((definition, index) => {
        assertEntry(definition, index);
        return freezeEntry(definition);
    });
    const byId = new Map<string, WorkflowSettingManifestEntry>();
    const keys = new Set<string>();
    const cliFlags = new Set<string>();
    for (const entry of entries) {
        const foldedId = entry.id.toLowerCase();
        const foldedKey = entry.key.toLowerCase();
        const foldedCliFlag = entry.cli.flag.toLowerCase();
        if (byId.has(foldedId)) {
            throw new Error(`Workflow-setting manifest contains duplicate or case-drifted id '${entry.id}'.`);
        }
        if (keys.has(foldedKey)) {
            throw new Error(`Workflow-setting manifest contains duplicate or case-drifted key '${entry.key}'.`);
        }
        if (cliFlags.has(foldedCliFlag)) {
            throw new Error(`Workflow-setting manifest contains duplicate or case-drifted CLI flag '${entry.cli.flag}'.`);
        }
        byId.set(foldedId, entry);
        keys.add(foldedKey);
        cliFlags.add(foldedCliFlag);
    }
    const frozenEntries = Object.freeze(entries);
    const get = (id: string): WorkflowSettingManifestEntry | null => byId.get(id.toLowerCase()) || null;
    const requireEntry = (id: string): WorkflowSettingManifestEntry => {
        const entry = get(id);
        if (!entry) {
            throw new Error(`Unknown workflow setting '${id}'.`);
        }
        return entry;
    };
    return Object.freeze({
        entries: frozenEntries,
        get,
        require: requireEntry,
        validate(id: string, value: unknown): WorkflowSettingValue {
            const entry = requireEntry(id);
            return requireValidValue(entry, value);
        },
        materialize(
            id: string,
            value: unknown,
            context: Readonly<WorkflowSettingMaterializationContext>
        ): readonly WorkflowSettingMaterialization[] {
            const entry = requireEntry(id);
            const validValue = requireValidValue(entry, value);
            assertMaterializationContext(entry, context);
            return freezeMaterializations(entry, entry.materialize(validValue, Object.freeze({ ...context })));
        }
    });
}
