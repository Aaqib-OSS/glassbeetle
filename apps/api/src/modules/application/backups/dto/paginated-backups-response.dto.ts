import { ApiProperty } from '@nestjs/swagger';
import type { PaginatedResponse } from '../../../../common/pagination/paginated-response.dto.js';
import { BackupResponseDto } from './backup-response.dto.js';

/**
 * Paginated collection envelope for backup archives returned by `GET /application/backups`.
 */
export class PaginatedBackupsResponseDto implements PaginatedResponse<BackupResponseDto> {
  @ApiProperty({
    type: [BackupResponseDto],
    description: 'Items in the current page',
  })
  readonly items!: readonly BackupResponseDto[];

  @ApiProperty({
    example: 7,
    description: 'Total number of items matching filters',
  })
  readonly total!: number;

  @ApiProperty({
    example: 50,
    description: 'Maximum number of items returned per page',
  })
  readonly limit!: number;

  @ApiProperty({
    example: 0,
    description: 'Offset of the first item returned',
  })
  readonly offset!: number;
}
