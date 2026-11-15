import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../../../common/http/api-error.js';
import { ParseUuidV7Pipe } from '../../../common/identifiers/index.js';
import { type PaginatedResponse } from '../../../common/pagination/paginated-response.dto.js';
import { BackupsService } from './backups.service.js';
import {
  BackupResponseDto,
  CreateBackupDto,
  ListBackupsQueryDto,
  PaginatedBackupsResponseDto,
} from './dto/index.js';

/**
 * Controller exposing `/application/backups`.
 *
 * Backups are full self-contained archives containing a consistent database
 * snapshot, the file storage tree, and a manifest describing version and file
 * inventory.
 */
@ApiTags('application')
@Controller('application/backups')
export class BackupsController {
  constructor(private readonly backupsService: BackupsService) {}

  /**
   * `POST /application/backups` — create a backup archive on demand.
   *
   * Creates a consistent database snapshot via SQLite VACUUM INTO, archives the
   * file storage tree, writes manifest.json, and records the backup metadata.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a backup archive',
    description: `Creates an on-demand, self-contained backup archive containing:
1. \`manifest.json\`: format version, timestamp, application version, database schema version, and file inventory.
2. \`database.sqlite\`: consistent snapshot of the SQLite database created via \`VACUUM INTO\`.
3. \`files/\`: full copy of the application file storage tree (agent pictures, project images, artifact files).

The master encryption key is deliberately excluded from the archive to preserve cryptographic separation of provider credentials at rest. Restoring on a new host will require provider API keys to be re-entered.

Concurrency: simultaneous backups are disallowed; concurrent requests receive \`409 Conflict\`.`,
  })
  @ApiBody({
    type: CreateBackupDto,
    required: false,
    description: 'Optional label or note for the backup',
  })
  @ApiCreatedResponse({
    description: 'Backup created successfully',
    type: BackupResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Target backup directory is invalid or unwritable',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'A backup is already in progress',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.INSUFFICIENT_STORAGE,
    description: 'Insufficient disk space to create the backup',
    type: ApiErrorResponseDto,
  })
  @ApiInternalServerErrorResponse({
    description: 'Backup creation failed; partial files cleaned up',
    type: ApiErrorResponseDto,
  })
  async create(@Body() dto?: CreateBackupDto): Promise<BackupResponseDto> {
    return this.backupsService.createBackup({
      trigger: 'manual',
      label: dto?.label,
      note: dto?.note,
    });
  }

  /**
   * `GET /application/backups` — list backup archives.
   *
   * Returns a paginated list of backups, sorted newest first by default.
   */
  @Get()
  @ApiOperation({
    summary: 'List backup archives',
    description:
      'Retrieves stored backup records with pagination, sorting, and trigger filtering. Sorted newest first by default. Never exposes raw filesystem paths.',
  })
  @ApiOkResponse({
    description: 'Paginated list of backup archives',
    type: PaginatedBackupsResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid pagination, sorting, or trigger filter parameters',
    type: ApiErrorResponseDto,
  })
  async findAll(
    @Query() query: ListBackupsQueryDto,
  ): Promise<PaginatedResponse<BackupResponseDto>> {
    return this.backupsService.findAll(query);
  }

  /**
   * `GET /application/backups/:backupId` — retrieve a single backup's metadata.
   *
   * Returns metadata and reports whether the archive is physically present on disk.
   */
  @Get(':backupId')
  @ApiOperation({
    summary: 'Retrieve backup metadata',
    description:
      'Retrieves metadata for a single backup archive. Reports whether the archive file currently exists on disk without exposing filesystem paths.',
  })
  @ApiParam({
    name: 'backupId',
    description: 'Unique backup identifier (UUIDv7)',
    example: '018f3a9e-0000-7000-8000-000000000001',
  })
  @ApiOkResponse({
    description: 'Backup metadata retrieved successfully',
    type: BackupResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'backupId is not a valid UUIDv7 identifier',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No backup found with that ID',
    type: ApiErrorResponseDto,
  })
  async findOne(
    @Param('backupId', ParseUuidV7Pipe) backupId: string,
  ): Promise<BackupResponseDto> {
    return this.backupsService.findOne(backupId);
  }

  /**
   * `DELETE /application/backups/:backupId` — delete a backup archive.
   *
   * Removes both the database record and the physical archive file on disk.
   * Irreversible; does not affect active application data.
   */
  @Delete(':backupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a backup archive',
    description:
      'Permanently deletes the backup database record and removes the archive file from disk. Deletion is irreversible and does not affect the active database or current application data.',
  })
  @ApiParam({
    name: 'backupId',
    description: 'Unique backup identifier (UUIDv7)',
    example: '018f3a9e-0000-7000-8000-000000000001',
  })
  @ApiNoContentResponse({
    description: 'Backup record and archive file successfully deleted',
  })
  @ApiBadRequestResponse({
    description: 'backupId is not a valid UUIDv7 identifier',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No backup found with that ID',
    type: ApiErrorResponseDto,
  })
  async remove(
    @Param('backupId', ParseUuidV7Pipe) backupId: string,
  ): Promise<void> {
    await this.backupsService.deleteBackup(backupId);
  }
}
