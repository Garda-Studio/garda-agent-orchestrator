import type { FullSuiteCommandProvenance } from '../../../../gates/full-suite/full-suite-validation';
import { inspectValidationCommand } from '../../../../core/validation-command-contract';

export interface FullSuiteCommandContractResult {
    supported: boolean;
    provenance: FullSuiteCommandProvenance;
    violation: string | null;
}

export function validateFullSuiteCommandContract(command: string): FullSuiteCommandContractResult {
    const admission = inspectValidationCommand(command, 'test');
    return { supported: admission.supported, violation: admission.violation,
        provenance: { schema_version: 1, source: 'workflow_config.full_suite_validation.command',
            execution_mode: 'DIRECT_ARGV', validation_status: admission.supported ? 'PASSED' : 'REJECTED',
            rejection_reason: admission.rejection_reason, detected_syntax: admission.detected_syntax,
            ...(admission.descriptor ? { command_descriptor: admission.descriptor } : {}) } };
}
