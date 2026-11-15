import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Optional request payload when creating a backup on demand.
 *
 * Callers can supply an optional label or note to document the context
 * (e.g. before an upgrade or major configuration change).
 */
export class CreateBackupDto {
  @ApiPropertyOptional({
    description: 'Optional short label for the backup',
    example: 'Pre-migration snapshot',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly label?: string;

  @ApiPropertyOptional({
    description: 'Optional descriptive note providing context for this backup',
    example:
      'Snapshot taken before updating system prompt templates and models.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly note?: string;
}
