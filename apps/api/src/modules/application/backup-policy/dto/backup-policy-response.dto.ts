import { ApiProperty } from '@nestjs/swagger';
import {
  BACKUP_FREQUENCIES,
  type BackupFrequency,
} from '../backup-policy.types.js';

/**
 * Public API representation of the automatic backup policy.
 *
 * The policy is a singleton settings object controlling whether backups run
 * automatically, how frequently they run, how many backup archives are retained,
 * and where archives are written on the local filesystem.
 *
 * The internal singleton row `id` is deliberately excluded from the API representation.
 */
export class BackupPolicyResponseDto {
  @ApiProperty({
    description: 'Whether scheduled backups run automatically',
    example: false,
  })
  readonly enabled!: boolean;

  @ApiProperty({
    description: 'How often scheduled backups run',
    enum: BACKUP_FREQUENCIES,
    example: 'daily',
  })
  readonly frequency!: BackupFrequency;

  @ApiProperty({
    type: 'integer',
    description:
      'Number of backup archives retained before older ones are pruned (positive integer >= 1)',
    example: 7,
  })
  readonly retentionCount!: number;

  @ApiProperty({
    type: String,
    description:
      'Absolute filesystem path where backup archives are written, or null to use the default location under the application data directory (<dataDir>/backups)',
    example: '/var/backups/glassbeetle',
    nullable: true,
  })
  readonly targetDirectory!: string | null;

  @ApiProperty({
    description: 'Timestamp of the last policy update in ISO-8601 UTC format',
    example: '2026-09-21T09:30:52.123Z',
  })
  readonly updatedAt!: string;
}

