import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationController } from './application.controller.js';
import { ApplicationService } from './application.service.js';
import type { ResetApplicationResponseDto } from './dto/index.js';

describe('ApplicationController', () => {
  let controller: ApplicationController;
  let service: ApplicationService;

  const mockResetResponse: ResetApplicationResponseDto = {
    status: 'completed',
    message: 'Application reset completed successfully.',
    cleared: {
      agentsCleared: 2,
      chatsCleared: 5,
      messagesCleared: 20,
      memoriesCleared: 4,
      projectsCleared: 1,
      artifactsCleared: 3,
      systemPromptsCleared: 1,
      usageEventsCleared: 10,
      providersCleared: 2,
      modelsCleared: 4,
      filesDeleted: 6,
      backupsPreserved: true,
      providersPreserved: false,
      preResetBackupCreated: false,
      preResetBackupId: null,
    },
    nextSteps: ['Configure providers'],
    resetAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    const mockApplicationService = {
      reset: vi.fn().mockResolvedValue(mockResetResponse),
      isOperationInProgress: false,
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApplicationController],
      providers: [
        {
          provide: ApplicationService,
          useValue: mockApplicationService,
        },
      ],
    }).compile();

    controller = module.get<ApplicationController>(ApplicationController);
    service = module.get<ApplicationService>(ApplicationService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('reset', () => {
    it('executes reset when confirm: "true" is provided in the body', async () => {
      const result = await controller.reset({ confirm: 'true' });
      expect(service.reset).toHaveBeenCalledWith({ confirm: 'true' });
      expect(result).toEqual(mockResetResponse);
    });

    it('executes reset when confirm: "RESET" is provided in the body', async () => {
      const result = await controller.reset({ confirm: 'RESET' });
      expect(service.reset).toHaveBeenCalledWith({ confirm: 'RESET' });
      expect(result).toEqual(mockResetResponse);
    });

    it('executes reset when confirm: "true" is provided via query parameter and body is omitted', async () => {
      const result = await controller.reset(undefined, { confirm: 'true' });
      expect(service.reset).toHaveBeenCalledWith({ confirm: 'true' });
      expect(result).toEqual(mockResetResponse);
    });

    it('executes reset when confirm: "RESET" is provided via query parameter', async () => {
      const result = await controller.reset(undefined, { confirm: 'RESET' });
      expect(service.reset).toHaveBeenCalledWith({ confirm: 'RESET' });
      expect(result).toEqual(mockResetResponse);
    });

    it('forwards reset options along with confirmation', async () => {
      await controller.reset({
        confirm: 'true',
        keepProviders: true,
        keepBackups: false,
        createBackup: true,
      });

      expect(service.reset).toHaveBeenCalledWith({
        confirm: 'true',
        keepProviders: true,
        keepBackups: false,
        createBackup: true,
      });
    });

    it('throws BadRequestException (400) when confirmation is completely missing', async () => {
      await expect(controller.reset(undefined, undefined)).rejects.toThrow(
        BadRequestException,
      );
      await expect(controller.reset({}, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException (400) when confirm is an invalid string', async () => {
      await expect(
        controller.reset({ confirm: 'false' as any }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        controller.reset({ confirm: 'no' as any }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
