import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupPolicyController } from './backup-policy.controller.js';
import { BackupPolicyService } from './backup-policy.service.js';
import type { BackupPolicyResponseDto } from './dto/backup-policy-response.dto.js';

const MOCK_POLICY: BackupPolicyResponseDto = {
  enabled: true,
  frequency: 'daily',
  retentionCount: 7,
  targetDirectory: '/var/backups',
  updatedAt: '2026-09-21T09:30:52.123Z',
};

describe('BackupPolicyController', () => {
  let controller: BackupPolicyController;
  let service: BackupPolicyService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BackupPolicyController],
      providers: [
        {
          provide: BackupPolicyService,
          useValue: {
            getPolicy: vi.fn().mockResolvedValue(MOCK_POLICY),
            updatePolicy: vi.fn().mockResolvedValue(MOCK_POLICY),
          },
        },
      ],
    }).compile();

    controller = module.get<BackupPolicyController>(BackupPolicyController);
    service = module.get<BackupPolicyService>(BackupPolicyService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates getPolicy to service.getPolicy', async () => {
    const result = await controller.getPolicy();
    expect(result).toBe(MOCK_POLICY);
    expect(service.getPolicy).toHaveBeenCalledOnce();
  });

  it('delegates updatePolicy to service.updatePolicy', async () => {
    const payload = {
      enabled: true,
      frequency: 'daily' as const,
      retentionCount: 7,
      targetDirectory: '/var/backups',
    };
    const result = await controller.updatePolicy(payload);
    expect(result).toBe(MOCK_POLICY);
    expect(service.updatePolicy).toHaveBeenCalledWith(payload);
  });
});
