import { ApiProperty } from '@nestjs/swagger';

/**
 * Outcome of credential verification following a database restore.
 */
export class RestoreCredentialsOutcomeDto {
  @ApiProperty({
    description: 'Whether the restored database contains any encrypted provider credentials.',
    example: true,
  })
  hasCredentials!: boolean;

  @ApiProperty({
    description:
      'Whether provider credentials in the restored database could be decrypted using the active master key.',
    example: true,
  })
  canDecrypt!: boolean;

  @ApiProperty({
    description:
      'Whether the user must re-enter provider credentials (e.g. if restored on a new host without the original master.key).',
    example: false,
  })
  requiresReentry!: boolean;

  @ApiProperty({
    description: 'Explanatory message describing credential state and necessary action.',
    example: 'Provider credentials successfully verified with the active master key.',
  })
  message!: string;
}

/**
 * Response DTO returned by `POST /application/backups/:backupId/restore`.
 *
 * Communicates what was restored (database, file count, schema version) and
 * what subsequent steps the user must take (re-entering credentials, restarting the application).
 */
export class RestoreBackupResponseDto {
  @ApiProperty({
    description: 'Unique identifier of the restored backup (UUIDv7).',
    example: '018f3a9e-0000-7000-8000-000000000001',
  })
  backupId!: string;

  @ApiProperty({
    description: 'Timestamp when the restore completed in ISO-8601 UTC format.',
    example: '2026-11-24T12:00:00.000Z',
  })
  restoredAt!: string;

  @ApiProperty({
    description: 'Whether the SQLite database was successfully replaced and reopened.',
    example: true,
  })
  databaseRestored!: boolean;

  @ApiProperty({
    description: 'Number of files restored to the application file storage tree.',
    example: 42,
  })
  filesRestored!: number;

  @ApiProperty({
    description: 'Database schema migration version of the restored database.',
    example: '007_chat_owner_set_null',
  })
  databaseSchemaVersion!: string;

  @ApiProperty({
    description: 'Application version recorded in the backup archive manifest.',
    example: '0.1.0',
  })
  appVersion!: string;

  @ApiProperty({
    description: 'Detailed outcome of provider credential verification after restore.',
    type: RestoreCredentialsOutcomeDto,
  })
  credentials!: RestoreCredentialsOutcomeDto;

  @ApiProperty({
    description: 'Convenience flag indicating whether provider credentials must be re-entered.',
    example: false,
  })
  requiresCredentialReentry!: boolean;

  @ApiProperty({
    description:
      'Whether an application restart is recommended to refresh in-memory caches and background services.',
    example: true,
  })
  requiresRestart!: boolean;

  @ApiProperty({
    description: 'Plain-language checklist of actions the user must now take.',
    type: [String],
    example: ['Restart the application to reload running services with the restored state.'],
  })
  actionsRequired!: string[];

  @ApiProperty({
    description: 'High-level summary of the restore outcome.',
    example: 'Application data restored successfully from backup.',
  })
  message!: string;
}

