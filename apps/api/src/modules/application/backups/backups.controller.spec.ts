import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupsController } from './backups.controller.js';
import { BackupsService } from './backups.service.js';
import {
  BackupResponseDto,
  CreateBackupDto,
  ListBackupsQueryDto,
  PaginatedBackupsResponseDto,
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

  beforeEach(async () => {
    const mockBackupsService = {
      createBackup: vi.fn().mockResolvedValue(mockBackupResponse),
      findAll: vi.fn().mockResolvedValue(mockPaginatedResponse),
      findOne: vi.fn().mockResolvedValue(mockBackupResponse),
      deleteBackup: vi.fn().mockResolvedValue(undefined),
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
});
