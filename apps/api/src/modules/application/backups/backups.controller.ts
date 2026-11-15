import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../../../common/http/api-error.js';
import { BackupsService } from './backups.service.js';
import { BackupResponseDto } from './dto/backup-response.dto.js';
import { CreateBackupDto } from './dto/create-backup.dto.js';

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
}
