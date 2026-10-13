import { DEFAULT_METRICS_MAX_LINES } from '../../runtime/toxin-metrics';
import type { RetentionPolicy } from './cleanup-types';

const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_BACKUPS = 10;
const DEFAULT_MAX_TASK_EVENTS = 50;
const DEFAULT_MAX_REVIEWS = 100;
const DEFAULT_MAX_WORKING_PLANS = 100;
const DEFAULT_MAX_UPDATE_REPORTS = 10;
const DEFAULT_MAX_UPDATE_ROLLBACKS = 10;
const DEFAULT_MAX_BUNDLE_BACKUPS = 10;
const DEFAULT_MAX_AGGREGATE_LINES = 10000;
const DEFAULT_MAX_METRICS_LINES = DEFAULT_METRICS_MAX_LINES;

export interface RetentionPolicyDefaultMetadata {
    flag: string;
    optionKey: string;
    policyKey: keyof RetentionPolicy;
    label: string;
}

export const RETENTION_POLICY_DEFAULTS = Object.freeze([
    { flag: '--max-age-days', optionKey: 'maxAgeDays', policyKey: 'maxAgeDays', label: 'days' },
    { flag: '--max-backups', optionKey: 'maxBackups', policyKey: 'maxBackups', label: 'backups' },
    { flag: '--max-task-events', optionKey: 'maxTaskEvents', policyKey: 'maxTaskEvents', label: 'task events' },
    { flag: '--max-reviews', optionKey: 'maxReviews', policyKey: 'maxReviews', label: 'review sets' },
    { flag: '--max-working-plans', optionKey: 'maxWorkingPlans', policyKey: 'maxWorkingPlans', label: 'working plans' },
    { flag: '--max-update-reports', optionKey: 'maxUpdateReports', policyKey: 'maxUpdateReports', label: 'update reports' },
    { flag: '--max-update-rollbacks', optionKey: 'maxUpdateRollbacks', policyKey: 'maxUpdateRollbacks', label: 'rollbacks' },
    { flag: '--max-bundle-backups', optionKey: 'maxBundleBackups', policyKey: 'maxBundleBackups', label: 'bundle backups' },
    { flag: '--max-aggregate-lines', optionKey: 'maxAggregateLines', policyKey: 'maxAggregateLines', label: 'aggregate task-event lines' },
    { flag: '--max-metrics-lines', optionKey: 'maxMetricsLines', policyKey: 'maxMetricsLines', label: 'metrics lines' }
] satisfies RetentionPolicyDefaultMetadata[]);

export function buildDefaultRetentionPolicy(): RetentionPolicy {
    return {
        maxAgeDays: DEFAULT_MAX_AGE_DAYS,
        maxBackups: DEFAULT_MAX_BACKUPS,
        maxTaskEvents: DEFAULT_MAX_TASK_EVENTS,
        maxReviews: DEFAULT_MAX_REVIEWS,
        maxWorkingPlans: DEFAULT_MAX_WORKING_PLANS,
        maxUpdateReports: DEFAULT_MAX_UPDATE_REPORTS,
        maxUpdateRollbacks: DEFAULT_MAX_UPDATE_ROLLBACKS,
        maxBundleBackups: DEFAULT_MAX_BUNDLE_BACKUPS,
        maxAggregateLines: DEFAULT_MAX_AGGREGATE_LINES,
        maxMetricsLines: DEFAULT_MAX_METRICS_LINES
    };
}

