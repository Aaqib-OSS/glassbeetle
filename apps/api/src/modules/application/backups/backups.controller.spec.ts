import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PassThrough, Readable } from 'node:stream';
import { Test, TestingModule } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupsController } from './backups.controller.js';
import { BackupsService } from './backups.service.js';
import {
  BackupResponseDto,
  CreateBackupDto,
  ListBackupsQueryDto,
  PaginatedBackupsResponseDto,
  RestoreBackupResponseDto,
} from './dto/index.js';

describe('BackupsController', () => {
  let controller: BackupsController;
  let service: BackupsService;

  const mockBackupResponse: BackupResponseDto = {
    id: '018f3a9e-0000-7000-8000-000000000001',
    sizeBytes: 1048576,
    trigger: 'manual',
    createdAt: '2026-11-15T21:44:41.000Z',
    hasArchive: true,
    isAvailable: true,
  };

  const mockPaginatedResponse: PaginatedBackupsResponseDto = {
    items: [mockBackupResponse],
    total: 1,
    limit: 50,
    offset: 0,
  };

  const mockRestoreResponse: RestoreBackupResponseDto = {
    backupId: mockBackupResponse.id,
    restoredAt: '2026-11-24T12:00:00.000Z',
    databaseRestored: true,
    filesRestored: 5,
    databaseSchemaVersion: '007_chat_owner_set_null',
    appVersion: '0.1.0',
    credentials: {
      hasCredentials: false,
      canDecrypt: true,
      requiresReentry: false,
      message: 'No provider credentials stored in restored backup.',
    },
    requiresCredentialReentry: false,
    requiresRestart: true,
    actionsRequired: [
      'Restart the application to reload running services with the restored state',
    ],
    message: 'Backup restored successfully.',
  };

  beforeEach(async () => {
    const mockArchiveStreamInfo = {
      id: mockBackupResponse.id,
      createdAt: mockBackupResponse.createdAt,
      sizeBytes: mockBackupResponse.sizeBytes,
      openStream: vi.fn(() => Readable.from(Buffer.from('test archive bytes'))),
    };

    const mockBackupsService = {
      createBackup: vi.fn().mockResolvedValue(mockBackupResponse),
      findAll: vi.fn().mockResolvedValue(mockPaginatedResponse),
      findOne: vi.fn().mockResolvedValue(mockBackupResponse),
      deleteBackup: vi.fn().mockResolvedValue(undefined),
      getBackupArchive: vi.fn().mockResolvedValue(mockArchiveStreamInfo),
      restoreBackup: vi.fn().mockResolvedValue(mockRestoreResponse),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BackupsController],
      providers: [
        {
          provide: BackupsService,
          useValue: mockBackupsService,
        },
      ],
    }).compile();

    controller = module.get<BackupsController>(BackupsController);
    service = module.get<BackupsService>(BackupsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /application/backups', () => {
    it('creates a manual backup with optional label and note', async () => {
      const dto: CreateBackupDto = {
        label: 'Pre-upgrade snapshot',
        note: 'Snapshot before updating providers',
      };

      const result = await controller.create(dto);

      expect(service.createBackup).toHaveBeenCalledWith({
        trigger: 'manual',
        label: 'Pre-upgrade snapshot',
        note: 'Snapshot before updating providers',
      });
      expect(result).toEqual(mockBackupResponse);
    });

    it('creates a manual backup when body is omitted', async () => {
      const result = await controller.create(undefined);

      expect(service.createBackup).toHaveBeenCalledWith({
        trigger: 'manual',
        label: undefined,
        note: undefined,
      });
      expect(result).toEqual(mockBackupResponse);
    });

    it('propagates ConflictException (409) when a backup is already in progress', async () => {
      vi.spyOn(service, 'createBackup').mockRejectedValueOnce(
        new ConflictException('A backup is already in progress'),
      );

      await expect(controller.create()).rejects.toThrow(ConflictException);
    });

    it('propagates BadRequestException (400) when target directory is invalid', async () => {
      vi.spyOn(service, 'createBackup').mockRejectedValueOnce(
        new BadRequestException(
          'Configured backup target directory does not exist',
        ),
      );

      await expect(controller.create()).rejects.toThrow(BadRequestException);
    });

    it('propagates HttpException (507) when disk space is insufficient', async () => {
      vi.spyOn(service, 'createBackup').mockRejectedValueOnce(
        new HttpException(
          'Insufficient disk space to create backup',
          HttpStatus.INSUFFICIENT_STORAGE,
        ),
      );

      await expect(controller.create()).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(
          HttpStatus.INSUFFICIENT_STORAGE,
        );
        return true;
      });
    });
  });

  describe('GET /application/backups', () => {
    it('delegates to service.findAll with query parameters and returns paginated collection', async () => {
      const query: ListBackupsQueryDto = {
        limit: 10,
        offset: 0,
        trigger: 'manual',
      };

      const result = await controller.findAll(query);

      expect(service.findAll).toHaveBeenCalledWith(query);
      expect(result).toEqual(mockPaginatedResponse);
    });
  });

  describe('GET /application/backups/:backupId', () => {
    it('delegates to service.findOne and returns backup metadata', async () => {
      const result = await controller.findOne(mockBackupResponse.id);

      expect(service.findOne).toHaveBeenCalledWith(mockBackupResponse.id);
      expect(result).toEqual(mockBackupResponse);
    });

    it('propagates NotFoundException (404) when backup does not exist', async () => {
      vi.spyOn(service, 'findOne').mockRejectedValueOnce(
        new NotFoundException({
          code: 'BACKUP_NOT_FOUND',
          message: 'No backup found with that ID',
        }),
      );

      await expect(
        controller.findOne('018f3a9e-0000-7000-8000-000000000999'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('DELETE /application/backups/:backupId', () => {
    it('delegates to service.deleteBackup and returns 204 (undefined)', async () => {
      const result = await controller.remove(mockBackupResponse.id);

      expect(service.deleteBackup).toHaveBeenCalledWith(mockBackupResponse.id);
      expect(result).toBeUndefined();
    });

    it('propagates NotFoundException (404) when backup does not exist', async () => {
      vi.spyOn(service, 'deleteBackup').mockRejectedValueOnce(
        new NotFoundException({
          code: 'BACKUP_NOT_FOUND',
          message: 'No backup found with that ID',
        }),
      );

      await expect(
        controller.remove('018f3a9e-0000-7000-8000-000000000999'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('POST /application/backups/:backupId/restore', () => {
    it('restores backup with body { confirm: "true" }', async () => {
      const result = await controller.restore(
        mockBackupResponse.id,
        { confirm: 'true' },
        undefined,
      );

      expect(service.restoreBackup).toHaveBeenCalledWith(
        mockBackupResponse.id,
        { confirm: 'true' },
      );
      expect(result).toEqual(mockRestoreResponse);
    });

    it('restores backup with query { confirm: "true" } when body is omitted', async () => {
      const result = await controller.restore(
        mockBackupResponse.id,
        undefined,
        { confirm: 'true' },
      );

      expect(service.restoreBackup).toHaveBeenCalledWith(
        mockBackupResponse.id,
        { confirm: 'true' },
      );
      expect(result).toEqual(mockRestoreResponse);
    });

    it('throws BadRequestException (400) when confirmation is missing', async () => {
      await expect(
        controller.restore(mockBackupResponse.id, undefined, undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException (400) when confirm is not "true"', async () => {
      await expect(
        controller.restore(mockBackupResponse.id, { confirm: 'false' as any }),
      ).rejects.toThrow(BadRequestException);
    });

    it('propagates NotFoundException (404) when backup does not exist or archive missing', async () => {
      vi.spyOn(service, 'restoreBackup').mockRejectedValueOnce(
        new NotFoundException({
          code: 'BACKUP_NOT_FOUND',
          message: 'No backup found with that ID',
        }),
      );

      await expect(
        controller.restore(mockBackupResponse.id, { confirm: 'true' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('propagates ConflictException (409) when schema version is incompatible', async () => {
      vi.spyOn(service, 'restoreBackup').mockRejectedValueOnce(
        new ConflictException({
          code: 'INCOMPATIBLE_SCHEMA_VERSION',
          message: 'Incompatible schema version',
        }),
      );

      await expect(
        controller.restore(mockBackupResponse.id, { confirm: 'true' }),
      ).rejects.toThrow(ConflictException);
    });

    it('propagates UnprocessableEntityException (422) when archive is corrupt', async () => {
      vi.spyOn(service, 'restoreBackup').mockRejectedValueOnce(
        new UnprocessableEntityException({
          code: 'CORRUPT_ARCHIVE',
          message: 'Archive is corrupt',
        }),
      );

      await expect(
        controller.restore(mockBackupResponse.id, { confirm: 'true' }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('propagates InternalServerErrorException (500) when restore fails', async () => {
      vi.spyOn(service, 'restoreBackup').mockRejectedValueOnce(
        new InternalServerErrorException({
          code: 'RESTORE_FAILED',
          message: 'Restore failed and was rolled back',
        }),
      );

      await expect(
        controller.restore(mockBackupResponse.id, { confirm: 'true' }),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('GET /application/backups/:backupId/download', () => {
    function createMockExpressResponse() {
      const headers: Record<string, string> = {};
      const res: any = new PassThrough();
      res.headersSent = false;
      res.statusCode = 200;

      const originalDestroy = res.destroy.bind(res);
      let destroyed = false;
      let destroyError: unknown = null;
      res.destroy = vi.fn((err?: unknown) => {
        destroyed = true;
        destroyError = err;
        return originalDestroy(err as any);
      });

      res.setHeader = vi.fn((key: string, value: string) => {
        headers[key.toLowerCase()] = String(value);
      });
      res.status = vi.fn((code: number) => {
        res.statusCode = code;
        return res;
      });
      res.socket = {
        setTimeout: vi.fn(),
      };

      return {
        res,
        getHeaders: () => headers,
        getStatusCode: () => res.statusCode,
        isEnded: () => res.writableEnded,
        isDestroyed: () => destroyed,
        getDestroyError: () => destroyError,
      };
    }

    it('streams full archive with 200, Content-Type, Content-Length, and attachment disposition', async () => {
      const mockReq: Partial<Request> = {
        headers: {},
        socket: { setTimeout: vi.fn() } as any,
      };
      const mock = createMockExpressResponse();

      await controller.download(
        mockBackupResponse.id,
        mockReq as Request,
        mock.res as Response,
      );

      expect(service.getBackupArchive).toHaveBeenCalledWith(
        mockBackupResponse.id,
      );
      expect(mock.getStatusCode()).toBe(200);
      expect(mock.getHeaders()['content-type']).toBe('application/gzip');
      expect(mock.getHeaders()['content-length']).toBe(
        String(mockBackupResponse.sizeBytes),
      );
      expect(mock.getHeaders()['accept-ranges']).toBe('bytes');
      expect(mock.getHeaders()['content-disposition']).toBe(
        'attachment; filename="glassbeetle-backup-2026-11-15T21-44-41.000Z.tar.gz"',
      );
      expect(mock.getHeaders()['x-content-type-options']).toBe('nosniff');
    });

    it('supports Range requests with 206 Partial Content', async () => {
      const mockReq: Partial<Request> = {
        headers: { range: 'bytes=0-499' },
        socket: { setTimeout: vi.fn() } as any,
      };
      const mock = createMockExpressResponse();

      await controller.download(
        mockBackupResponse.id,
        mockReq as Request,
        mock.res as Response,
      );

      expect(mock.getStatusCode()).toBe(206);
      expect(mock.getHeaders()['content-range']).toBe(
        `bytes 0-499/${mockBackupResponse.sizeBytes}`,
      );
      expect(mock.getHeaders()['content-length']).toBe('500');
    });

    it('returns 416 Range Not Satisfiable when range exceeds archive size', async () => {
      const mockReq: Partial<Request> = {
        headers: { range: 'bytes=9999999-99999999' },
        socket: { setTimeout: vi.fn() } as any,
      };
      const mock = createMockExpressResponse();

      await controller.download(
        mockBackupResponse.id,
        mockReq as Request,
        mock.res as Response,
      );

      expect(mock.getStatusCode()).toBe(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
      expect(mock.getHeaders()['content-range']).toBe(
        `bytes */${mockBackupResponse.sizeBytes}`,
      );
      expect(mock.isEnded()).toBe(true);
    });

    it('propagates NotFoundException (404) when backup does not exist', async () => {
      vi.spyOn(service, 'getBackupArchive').mockRejectedValueOnce(
        new NotFoundException({
          code: 'BACKUP_NOT_FOUND',
          message: 'No backup found with that ID',
        }),
      );

      const mockReq: Partial<Request> = { headers: {} };
      const mock = createMockExpressResponse();

      await expect(
        controller.download(
          '018f3a9e-0000-7000-8000-000000000999',
          mockReq as Request,
          mock.res as Response,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('propagates GoneException (410) when archive file is missing from disk', async () => {
      vi.spyOn(service, 'getBackupArchive').mockRejectedValueOnce(
        new GoneException({
          code: 'BACKUP_ARCHIVE_GONE',
          message: 'Backup archive file is missing from disk',
        }),
      );

      const mockReq: Partial<Request> = { headers: {} };
      const mock = createMockExpressResponse();

      await expect(
        controller.download(
          mockBackupResponse.id,
          mockReq as Request,
          mock.res as Response,
        ),
      ).rejects.toThrow(GoneException);
    });

    it('destroys connection on stream error after headers are sent', async () => {
      const failingStream = new Readable({
        read() {
          // Push a chunk to simulate started stream
          this.push('chunk 1');
          // Then emit error
          process.nextTick(() => {
            this.emit('error', new Error('Simulated read failure mid-stream'));
          });
        },
      });

      vi.spyOn(service, 'getBackupArchive').mockResolvedValueOnce({
        id: mockBackupResponse.id,
        createdAt: mockBackupResponse.createdAt,
        sizeBytes: 1000,
        openStream: () => failingStream as any,
      });

      const mockReq: Partial<Request> = {
        headers: {},
        socket: { setTimeout: vi.fn() } as any,
      };
      const mock = createMockExpressResponse();
      // Simulate headers already sent
      mock.res.headersSent = true;

      await controller.download(
        mockBackupResponse.id,
        mockReq as Request,
        mock.res as Response,
      );

      expect(mock.isDestroyed()).toBe(true);
    });
  });
});
