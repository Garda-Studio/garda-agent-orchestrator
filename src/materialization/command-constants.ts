import { resolveBundleName } from '../core/constants';

export function getNodeBundleCliCommand(): string {
    return `node ${resolveBundleName()}/bin/garda.js`;
}
export function getNodeGateCommandPrefix(): string {
    return `${getNodeBundleCliCommand()} gate`;
}
export function getNodeHumanCommitCommand(): string {
    return `${getNodeGateCommandPrefix()} human-commit --task-id "<task-id>" --message "<message>"`;
}
export function getNodeInteractiveUpdateCommand(): string {
    return `${getNodeBundleCliCommand()} update --target-root "." --init-answers-path "${resolveBundleName()}/runtime/init-answers.json"`;
}
export function getNodeNonInteractiveUpdateCommand(): string {
    return `${getNodeBundleCliCommand()} update --target-root "." --init-answers-path "${resolveBundleName()}/runtime/init-answers.json" --apply --no-prompt`;
}

/** Which CLI generated guidance names: the deployed bundle, or the Garda source checkout itself. */
export type GardaCliMode = 'deployed' | 'source';
export const GARDA_SOURCE_CLI_COMMAND = 'node bin/garda.js';
export function getGardaCliCommand(mode: GardaCliMode = 'deployed'): string {
    return mode === 'source' ? GARDA_SOURCE_CLI_COMMAND : getNodeBundleCliCommand();
}
export function getGardaGateCommandPrefix(mode: GardaCliMode = 'deployed'): string {
    return `${getGardaCliCommand(mode)} gate`;
}
