import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../../database/database.service.js';
import { BackupPolicyService } from './backup-policy.service.js';
import type { BackupPolicyResponseDto } from './dto/backup-policy-response.dto.js';

describe('BackupPolicyService', () => {
  let db: DatabaseService;
  let service: BackupPolicyService;
  let tempBaseDir: string;

  beforeEach(() => {
    db = new DatabaseService();
    db.connect(':memory:');
    service = new BackupPolicyService(db);
    tempBaseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'backup-policy-service-test-'),
    );
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {}
    }
  });

  function policyRows(): Array<Record<string, unknown>> {
    return db.all('SELECT * FROM backup_policy');
  }

  describe('getPolicy', () => {
    it('returns the seeded defaults on a fresh database: disabled, daily, retention 7, null target', async () => {
      const policy: BackupPolicyResponseDto = await service.getPolicy();

      expect(policy).toEqual({
        enabled: false,
        frequency: 'daily',
        retentionCount: 7,
        targetDirectory: null,
        updatedAt: expect.any(String),
      });

      // id is never exposed
      expect((policy as any).id).toBeUndefined();
    });

    it('throws InternalServerErrorException when the singleton policy row is missing', async () => {
      db.run('DELETE FROM backup_policy');

      await expect(service.getPolicy()).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('updatePolicy', () => {
    it('updates each field and GET reflects the changes', async () => {
      const customDir = path.join(tempBaseDir, 'custom-backups');
      fs.mkdirSync(customDir, { recursive: true });

      const updated = await service.updatePolicy(
        {
          enabled: true,
          frequency: 'weekly',
          retentionCount: 14,
          targetDirectory: customDir,
        },
        '2026-10-01T12:00:00.000Z',
      );

      expect(updated).toEqual({
        enabled: true,
        frequency: 'weekly',
        retentionCount: 14,
        targetDirectory: customDir,
        updatedAt: '2026-10-01T12:00:00.000Z',
      });

      const reread = await service.getPolicy();
      expect(reread).toEqual(updated);
    });

    it('asserts exactly one policy row exists with id = 1 after several updates', async () => {
      const dir = path.join(tempBaseDir, 'backups-dir');
      fs.mkdirSync(dir, { recursive: true });

      await service.updatePolicy({
        enabled: true,
        frequency: 'hourly',
        retentionCount: 3,
        targetDirectory: dir,
      });

      await service.updatePolicy({
        enabled: false,
        frequency: 'daily',
        retentionCount: 5,
        targetDirectory: null,
      });

      await service.updatePolicy({
        enabled: true,
        frequency: 'weekly',
        retentionCount: 10,
        targetDirectory: dir,
      });

      const rows = policyRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(1);
      expect(rows[0].enabled).toBe(1);
      expect(rows[0].frequency).toBe('weekly');
      expect(rows[0].retention_count).toBe(10);
      expect(rows[0].target_directory).toBe(dir);
    });

    it('performs boolean round-trip for enabled between API and storage', async () => {
      // Seeded as 0 in storage
      let row = db.get<{ enabled: number }>(
        'SELECT enabled FROM backup_policy WHERE id = 1',
      );
      expect(row?.enabled).toBe(0);
      expect((await service.getPolicy()).enabled).toBe(false);

      // Update to true -> 1 in storage
      await service.updatePolicy({
        enabled: true,
        frequency: 'daily',
        retentionCount: 7,
        targetDirectory: null,
      });

      row = db.get<{ enabled: number }>(
        'SELECT enabled FROM backup_policy WHERE id = 1',
      );
      expect(row?.enabled).toBe(1);
      expect((await service.getPolicy()).enabled).toBe(true);

      // Update back to false -> 0 in storage
      await service.updatePolicy({
        enabled: false,
        frequency: 'daily',
        retentionCount: 7,
        targetDirectory: null,
      });

      row = db.get<{ enabled: number }>(
        'SELECT enabled FROM backup_policy WHERE id = 1',
      );
      expect(row?.enabled).toBe(0);
      expect((await service.getPolicy()).enabled).toBe(false);
    });

    it('advances updated_at on update', async () => {
      const initial = await service.getPolicy();
      const initialTime = new Date(initial.updatedAt).getTime();

      const time1 = new Date(initialTime + 10_000).toISOString();
      const updated1 = await service.updatePolicy(
        {
          enabled: true,
          frequency: 'hourly',
          retentionCount: 5,
          targetDirectory: null,
        },
        time1,
      );
      expect(updated1.updatedAt).toBe(time1);
      expect(new Date(updated1.updatedAt).getTime()).toBeGreaterThan(
        initialTime,
      );

      const time2 = new Date(initialTime + 20_000).toISOString();
      const updated2 = await service.updatePolicy(
        {
          enabled: false,
          frequency: 'daily',
          retentionCount: 7,
          targetDirectory: null,
        },
        time2,
      );
      expect(updated2.updatedAt).toBe(time2);
      expect(new Date(updated2.updatedAt).getTime()).toBeGreaterThan(
        new Date(time1).getTime(),
      );
    });

    it('accepts each of the three valid frequencies (hourly, daily, weekly)', async () => {
      for (const freq of ['hourly', 'daily', 'weekly'] as const) {
        const result = await service.updatePolicy({
          enabled: false,
          frequency: freq,
          retentionCount: 7,
          targetDirectory: null,
        });
        expect(result.frequency).toBe(freq);
      }
    });

    it('rejects an invalid frequency with BadRequestException', async () => {
      await expect(
        service.updatePolicy({
          enabled: false,
          frequency: 'monthly' as any,
          retentionCount: 7,
          targetDirectory: null,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects retentionCount of 0 and of -1 with BadRequestException', async () => {
      await expect(
        service.updatePolicy({
          enabled: false,
          frequency: 'daily',
          retentionCount: 0,
          targetDirectory: null,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updatePolicy({
          enabled: false,
          frequency: 'daily',
          retentionCount: -1,
          targetDirectory: null,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-integer retentionCount with BadRequestException', async () => {
      await expect(
        service.updatePolicy({
          enabled: false,
          frequency: 'daily',
          retentionCount: 3.5,
          targetDirectory: null,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects retentionCount exceeding MAX_RETENTION_COUNT with BadRequestException', async () => {
      await expect(
        service.updatePolicy({
          enabled: false,
          frequency: 'daily',
          retentionCount: 10_001,
          targetDirectory: null,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-boolean enabled with BadRequestException', async () => {
      await expect(
        service.updatePolicy({
          enabled: 'true' as any,
          frequency: 'daily',
          retentionCount: 7,
          targetDirectory: null,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws InternalServerErrorException on update when the policy row is missing', async () => {
      db.run('DELETE FROM backup_policy');

      await expect(
        service.updatePolicy({
          enabled: true,
          frequency: 'daily',
          retentionCount: 7,
          targetDirectory: null,
        }),
      ).rejects.toThrow(InternalServerErrorException);
    });

    describe('targetDirectory validation', () => {
      it('accepts null targetDirectory and stores null', async () => {
        const result = await service.updatePolicy({
          enabled: false,
          frequency: 'daily',
          retentionCount: 7,
          targetDirectory: null,
        });

        expect(result.targetDirectory).toBeNull();
        const row = db.get<{ target_directory: string | null }>(
          'SELECT target_directory FROM backup_policy WHERE id = 1',
        );
        expect(row?.target_directory).toBeNull();
      });

      it('rejects a relative targetDirectory with a message naming the problem', async () => {
        await expect(
          service.updatePolicy({
            enabled: false,
            frequency: 'daily',
            retentionCount: 7,
            targetDirectory: 'relative/path/to/backups',
          }),
        ).rejects.toThrowError(
          /Target directory must be an absolute path: "relative\/path\/to\/backups"/,
        );
      });

      it('rejects a targetDirectory containing null bytes', async () => {
        await expect(
          service.updatePolicy({
            enabled: false,
            frequency: 'daily',
            retentionCount: 7,
            targetDirectory: '/var/backups\0evil',
          }),
        ).rejects.toThrowError(
          /Target directory path contains illegal null bytes/,
        );
      });

      it('rejects a non-existent targetDirectory with a message naming the problem', async () => {
        const nonExistent = path.join(tempBaseDir, 'does-not-exist-dir');

        await expect(
          service.updatePolicy({
            enabled: false,
            frequency: 'daily',
            retentionCount: 7,
            targetDirectory: nonExistent,
          }),
        ).rejects.toThrowError(
          new RegExp(`Target directory does not exist: "${nonExistent}"`),
        );
      });

      it('rejects a targetDirectory pointing at a file rather than a directory', async () => {
        const filePath = path.join(tempBaseDir, 'regular-file.txt');
        fs.writeFileSync(filePath, 'hello');

        await expect(
          service.updatePolicy({
            enabled: false,
            frequency: 'daily',
            retentionCount: 7,
            targetDirectory: filePath,
          }),
        ).rejects.toThrowError(
          new RegExp(`Target path is not a directory: "${filePath}"`),
        );
      });

      it('rejects a read-only targetDirectory with a message naming the problem', async () => {
        const readOnlyDir = path.join(tempBaseDir, 'read-only-dir');
        fs.mkdirSync(readOnlyDir, { recursive: true });

        if (process.platform !== 'win32') {
          fs.chmodSync(readOnlyDir, 0o444);

          try {
            await expect(
              service.updatePolicy({
                enabled: false,
                frequency: 'daily',
                retentionCount: 7,
                targetDirectory: readOnlyDir,
              }),
            ).rejects.toThrowError(
              new RegExp(`Target directory is not writable: "${readOnlyDir}"`),
            );
          } finally {
            fs.chmodSync(readOnlyDir, 0o755);
          }
        }
      });
    });
  });
});
