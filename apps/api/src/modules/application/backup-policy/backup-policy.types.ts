import type { BackupPolicyResponseDto } from './dto/backup-policy-response.dto.js';
import { fromDbBoolean } from '../../../common/persistence/row-mapping.js';

/**
 * Allowed frequencies for automatic backup scheduling.
 *
 * Constrained by the database CHECK constraint:
 * `CHECK (frequency IN ('hourly', 'daily', 'weekly'))`
 */
export const BACKUP_FREQUENCIES = ['hourly', 'daily', 'weekly'] as const;

/**
 * Frequency at which automated backups are executed.
 */
export type BackupFrequency = (typeof BACKUP_FREQUENCIES)[number];

/**
 * Maximum accepted retention count to prevent unreasonable storage retention configurations.
 */
export const MAX_RETENTION_COUNT = 10_000;

/**
 * Raw database row shape for the `backup_policy` SQLite table.
 */
export interface BackupPolicyRow {
  readonly id: number;
  readonly enabled: number;
  readonly frequency: BackupFrequency;
  readonly retention_count: number;
  readonly target_directory: string | null;
  readonly updated_at: string;
}

/**
 * Maps a `backup_policy` database row to the public API response DTO.
 *
 * Note: `id` is an internal singleton constraint implementation detail
 * (`CHECK (id = 1)`) and is never exposed in the API response.
 */
export function mapBackupPolicyToResponse(
  row: BackupPolicyRow,
): BackupPolicyResponseDto {
  return {
    enabled: fromDbBoolean(row.enabled),
    frequency: row.frequency,
    retentionCount: row.retention_count,
    targetDirectory: row.target_directory,
    updatedAt: row.updated_at,
  };
}

