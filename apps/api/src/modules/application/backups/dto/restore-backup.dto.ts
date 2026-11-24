import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Equals, IsOptional } from 'class-validator';

/**
 * Body DTO for the backup restore endpoint (`POST /application/backups/:backupId/restore`).
 *
 * Restoring from a backup is an irreversible, destructive operation that replaces
 * the active database and file storage tree. Callers must supply explicit confirmation
 * either in the JSON request body (`{ "confirm": "true" }`) or via query parameter (`?confirm=true`).
 */
export class RestoreBackupDto {
  @ApiPropertyOptional({
    description:
      'Explicit safety confirmation. Must be explicitly set to "true" to authorize destructive restore.',
    example: 'true',
    type: String,
  })
  @IsOptional()
  @Transform(({ value }) => (value === true ? 'true' : value))
  @Equals('true', {
    message: 'confirm must be "true" to authorize restore',
  })
  confirm?: string;
}

/**
 * Query parameter DTO for the backup restore endpoint.
 */
export class RestoreBackupQueryDto {
  @ApiPropertyOptional({
    description:
      'Explicit safety confirmation via query parameter. Must be set to "true" to authorize destructive restore.',
    example: 'true',
    type: String,
  })
  @IsOptional()
  @Equals('true', {
    message: 'confirm must be "true" to authorize restore',
  })
  confirm?: string;
}

