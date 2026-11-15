import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/pagination/pagination-query.dto.js';
import { BACKUP_TRIGGERS, type BackupTrigger } from './backup-response.dto.js';

/**
 * Query parameters for `GET /application/backups`.
 *
 * Supports pagination (`limit`, `offset`), sorting (`sort`, `order`), and
 * filtering by trigger source (`trigger`).
 */
export class ListBackupsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: "Filter backups by trigger source ('manual' or 'scheduled')",
    enum: BACKUP_TRIGGERS,
    example: 'manual',
  })
  @IsOptional()
  @IsEnum(BACKUP_TRIGGERS, {
    message: "trigger must be 'manual' or 'scheduled'",
  })
  readonly trigger?: BackupTrigger;
}

