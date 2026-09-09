export function buildOperatorConfirmationArgs(
    confirmedAtUtc = new Date().toISOString()
): string[] {
    return [
        '--operator-confirmed', 'yes',
        '--operator-confirmed-at-utc', confirmedAtUtc
    ];
}
