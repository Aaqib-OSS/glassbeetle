import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  BACKUP_FREQUENCIES,
  type BackupFrequency,
  MAX_RETENTION_COUNT,
} from '../backup-policy.types.js';

/**
 * Request payload for updating the backup policy (PUT).
 *
 * Semantics:
 * PUT specifies a full replacement of the singleton policy object. All fields
 * (`enabled`, `frequency`, `retentionCount`, `targetDirectory`) are required.
 *
 * Field semantics:
 * - `enabled`: boolean controlling whether automatic scheduled backups are active.
 * - `frequency`: cadence of scheduled backups ('hourly' | 'daily' | 'weekly').
 * - `retentionCount`: positive integer >= 1 specifying how many backup archives
 *   are kept. Lowering this value does not retroactively prune archives immediately;
 *   pruning is enforced during the next scheduled backup run.
 * - `targetDirectory`: user-specified absolute path to a writable directory on disk.
 *   Set to `null` to use the default backup directory under the application data
 *   directory (`<dataDir>/backups`). Relative paths, non-existent paths, files,
 *   unwritable directories, or paths containing null bytes are rejected with a 400 Bad Request.
 */
export class UpdateBackupPolicyDto {
  @ApiProperty({
    description: 'Whether scheduled backups run automatically',
    example: true,
  })
  @IsBoolean({ message: 'enabled must be a boolean' })
  readonly enabled!: boolean;

  @ApiProperty({
    description: 'How often scheduled backups run',
    enum: BACKUP_FREQUENCIES,
    example: 'daily',
  })
  @IsIn(BACKUP_FREQUENCIES, {
    message: `frequency must be one of: ${BACKUP_FREQUENCIES.join(', ')}`,
  })
  readonly frequency!: BackupFrequency;

  @ApiProperty({
    type: 'integer',
    description:
      'Number of backup archives retained before older ones are pruned. Must be a positive integer between 1 and 10000.',
    example: 7,
    minimum: 1,
    maximum: MAX_RETENTION_COUNT,
  })
  @IsInt({ message: 'retentionCount must be an integer' })
  @Min(1, { message: 'retentionCount must be at least 1' })
  @Max(MAX_RETENTION_COUNT, {
    message: `retentionCount must not exceed ${MAX_RETENTION_COUNT}`,
  })
  readonly retentionCount!: number;

  @ApiProperty({
    type: String,
    description:
      'Absolute filesystem path where backup archives will be stored, or null to use the default location under the application data directory. Must exist, be a directory, and be writable.',
    example: '/var/backups/glassbeetle',
    nullable: true,
  })
  @ValidateIf((_obj, val) => val !== null)
  @IsString({ message: 'targetDirectory must be a string or null' })
  readonly targetDirectory!: string | null;
}

