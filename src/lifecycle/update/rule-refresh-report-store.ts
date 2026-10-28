import * as path from 'node:path';
import { writeContainedFile } from '../../core/contained-filesystem';
import { withLifecycleRuntimeMutationGenerationForPath } from '../runtime-mutation-generation';

export function writeRuleRefreshReportFile(targetRoot: string, destination: string, content: string | Buffer): void {
    withLifecycleRuntimeMutationGenerationForPath(destination, 'lifecycle-rule-refresh-report-write', () => {
        writeContainedFile(targetRoot, destination, content);
    });
}

export function replacedRulesDirectory(bundleRoot: string, refreshId: string): string {
    return path.join(bundleRoot, 'runtime/update-reports', refreshId + '-replaced-rules');
}
