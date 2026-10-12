export const OPERATOR_CONFIRMATION_MAX_AGE_MS = 1_000_000 * 60 * 1000;
export const OPERATOR_CONFIRMATION_MAX_FUTURE_SKEW_MS = 60 * 1000;

export interface OperatorConfirmationOptions {
    actionLabel: string;
    confirmed: boolean;
    confirmedAtUtc?: string | null;
    instruction: string;
    requireConfirmedAtUtc?: boolean;
}

export function parseOperatorConfirmationYes(value: unknown, optionName = '--operator-confirmed'): boolean {
    if (String(value || '').trim().toLowerCase() !== 'yes') {
        throw new Error(`${optionName} requires the exact value "yes".`);
    }
    return true;
}

export function validateFreshOperatorConfirmation(options: OperatorConfirmationOptions): void {
    if (!options.confirmed) {
        throw new Error(`${options.actionLabel} requires explicit operator confirmation. ${options.instruction}`);
    }

    const confirmedAtUtc = String(options.confirmedAtUtc || '').trim();
    if (!confirmedAtUtc) {
        if (options.requireConfirmedAtUtc) {
            throw new Error(`${options.actionLabel} requires --operator-confirmed-at-utc for fresh operator approval.`);
        }
        return;
    }

    const confirmedAtMs = Date.parse(confirmedAtUtc);
    if (!Number.isFinite(confirmedAtMs)) {
        throw new Error('--operator-confirmed-at-utc must be a valid ISO-8601 timestamp.');
    }

    const ageMs = Date.now() - confirmedAtMs;
    if (ageMs > OPERATOR_CONFIRMATION_MAX_AGE_MS) {
        throw new Error(`${options.actionLabel} operator confirmation is stale; ask the user for a fresh yes/no confirmation.`);
    }
    if (ageMs < -OPERATOR_CONFIRMATION_MAX_FUTURE_SKEW_MS) {
        throw new Error(`${options.actionLabel} operator confirmation timestamp is in the future.`);
    }
}
