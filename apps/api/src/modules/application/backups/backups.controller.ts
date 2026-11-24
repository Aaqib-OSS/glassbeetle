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
  Req,
  Res,
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
import type { Request, Response } from 'express';
import { ApiErrorResponseDto } from '../../../common/http/api-error.js';
import { parseRangeHeader } from '../../../common/http/byte-range.js';
import { formatContentDisposition } from '../../../common/http/content-disposition.js';
import { ParseUuidV7Pipe } from '../../../common/identifiers/index.js';
import { type PaginatedResponse } from '../../../common/pagination/paginated-response.dto.js';
import { BackupsService } from './backups.service.js';
import type { BackupArchiveStreamInfo } from './backups.types.js';
import { generateBackupDownloadFilename } from './backup-download.js';
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
   * `GET /application/backups/:backupId/download` — download a backup archive.
   *
   * Streams the backup archive (.tar.gz) directly to the client with attachment disposition,
   * Content-Length based on fresh filesystem stat, and support for HTTP Range requests.
   */
  @Get(':backupId/download')
  @ApiOperation({
    summary: 'Download a backup archive',
    description: `Streams the backup archive (.tar.gz) as a binary attachment.

Security & Integrity:
- Backups are streamed directly from disk to prevent high memory consumption.
- Content-Disposition attachment filename is derived strictly from backup creation timestamp metadata, never from database file paths.
- Content-Length is calculated from a fresh filesystem stat to allow accurate client download progress.
- Supports HTTP byte-range requests (RFC 7233) for resuming interrupted downloads.
- Read errors occurring after headers are sent immediately terminate the connection rather than appending an error payload to a corrupted archive.
- Sensitive credentials: Note that downloaded archives contain the application database snapshot. Downloaded archives must be treated as sensitive and stored securely.

Status codes:
- 200: Archive streamed successfully.
- 206: Partial content streamed (range request).
- 400: backupId is invalid or stored file path escapes backup directory boundary.
- 404: The backup does not exist in the database.
- 410: The backup record exists, but the archive file is missing from disk (chosen over 404 to distinguish known from non-existent backups).
- 416: Requested byte range is unsatisfiable.
- 500: Read failure while streaming the archive.`,
  })
  @ApiParam({
    name: 'backupId',
    description: 'Unique backup identifier (UUIDv7)',
    example: '018f3a9e-0000-7000-8000-000000000001',
  })
  @ApiOkResponse({
    description: 'Archive streamed successfully',
    schema: {
      type: 'string',
      format: 'binary',
    },
  })
  @ApiResponse({
    status: HttpStatus.PARTIAL_CONTENT,
    description: 'Partial content streamed (range request)',
    schema: {
      type: 'string',
      format: 'binary',
    },
  })
  @ApiNotFoundResponse({
    description: 'The backup does not exist in the database',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.GONE,
    description:
      'The backup record exists, but the archive file is missing from disk',
    type: ApiErrorResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'backupId is invalid or stored file path escapes backup directory',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
    description: 'Requested byte range is out of bounds',
  })
  @ApiInternalServerErrorResponse({
    description: 'Read failure while streaming the archive',
    type: ApiErrorResponseDto,
  })
  async download(
    @Param('backupId', ParseUuidV7Pipe) backupId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const archiveInfo = await this.backupsService.getBackupArchive(backupId);
    await this.serveBackupArchive(archiveInfo, req, res);
  }

  /**
   * Serves backup archive stream with standard security headers, Content-Disposition,
   * fresh Content-Length, and byte-range request handling.
   */
  private async serveBackupArchive(
    archive: BackupArchiveStreamInfo,
    req: Request,
    res: Response,
  ): Promise<void> {
    // Disable socket timeouts for large archive streaming
    req.socket?.setTimeout(0);
    res.socket?.setTimeout(0);

    const filename = generateBackupDownloadFilename(archive.createdAt);
    const disposition = formatContentDisposition('attachment', filename);
    const contentType = 'application/gzip';
    const totalSize = archive.sizeBytes;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache, private');

    const rangeHeader = Array.isArray(req.headers.range)
      ? req.headers.range[0]
      : req.headers.range;

    const rangeResult = rangeHeader
      ? parseRangeHeader(rangeHeader, totalSize)
      : null;

    if (rangeResult === 'unsatisfiable') {
      res.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      res.end();
      return;
    }

    if (rangeResult) {
      const { start, end } = rangeResult;
      const contentLength = end - start + 1;
      res.status(HttpStatus.PARTIAL_CONTENT);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Content-Length', String(contentLength));

      const stream = archive.openStream({ start, end });
      await this.pipeStreamToResponse(stream, res);
      return;
    }

    res.status(HttpStatus.OK);
    res.setHeader('Content-Length', String(totalSize));

    const stream = archive.openStream();
    await this.pipeStreamToResponse(stream, res);
  }

  /**
   * Pipes an archive readable stream to the response with robust error handling.
   *
   * If a stream read error occurs after headers are sent, destroys the response
   * socket immediately to terminate the connection rather than appending an error
   * envelope that would corrupt the downloaded archive.
   */
  private pipeStreamToResponse(
    stream: NodeJS.ReadableStream,
    res: Response,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      stream.on('error', (err) => {
        if (res.headersSent) {
          // Headers already sent; status code cannot be changed.
          // Terminate the socket connection to signal failure to client and prevent corrupted archive download.
          res.destroy(err);
          resolve();
        } else {
          reject(err);
        }
      });

      res.on('error', (err) => {
        if (
          'destroy' in stream &&
          typeof (stream as any).destroy === 'function'
        ) {
          (stream as any).destroy(err);
        }
        resolve();
      });

      res.on('close', () => {
        if (
          'destroy' in stream &&
          typeof (stream as any).destroy === 'function'
        ) {
          (stream as any).destroy();
        }
        resolve();
      });

      stream.on('end', () => {
        resolve();
      });

      stream.pipe(res);
    });
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
