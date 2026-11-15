import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Valid triggers for initiating a backup.
 */
export const BACKUP_TRIGGERS = ['manual', 'scheduled'] as const;

/**
 * Union type of accepted backup trigger values.
 */
export type BackupTrigger = (typeof BACKUP_TRIGGERS)[number];

/**
 * Public metadata for a backup archive.
 *
 * Local filesystem paths (`file_path`) are deliberately omitted: exposing
 * host file paths leaks filesystem layout and user directory structure
 * into API responses (see `docs/api-conventions.md`). Instead, `hasArchive`
 * and `isAvailable` report whether the archive file is currently present
 * on disk.
 */
export class BackupResponseDto {
  @ApiProperty({
    description: 'Unique backup identifier (UUIDv7)',
    example: '018f3a9e-0000-7000-8000-000000000001',
  })
  readonly id!: string;

  @ApiProperty({
    description: 'Total size of the compressed backup archive in bytes',
    example: 2048576,
  })
  readonly sizeBytes!: number;

  @ApiProperty({
    description: 'How the backup was triggered',
    enum: BACKUP_TRIGGERS,
    example: 'manual',
  })
  readonly trigger!: BackupTrigger;

  @ApiProperty({
    description: 'Creation timestamp in ISO-8601 UTC format',
    example: '2026-11-15T21:44:41.000Z',
  })
  readonly createdAt!: string;

  @ApiProperty({
    description: 'Whether the backup archive file currently exists on disk',
    example: true,
  })
  readonly hasArchive!: boolean;

  @ApiPropertyOptional({
    description:
      'Alias for hasArchive: whether the archive file exists and is available',
    example: true,
  })
  readonly isAvailable?: boolean;
}
