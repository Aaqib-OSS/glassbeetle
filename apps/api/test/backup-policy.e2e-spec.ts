import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './harness/index.js';

describe('Backup policy endpoints (e2e)', () => {
  let testApp: TestApp;
  let tempBaseDir: string;

  beforeAll(async () => {
    testApp = await createTestApp();
    tempBaseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'backup-policy-e2e-test-'),
    );
  });

  afterAll(async () => {
    await testApp.close();
    if (fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {}
    }
  });

  beforeEach(() => {
    testApp.reset();
  });

  function policyRows(): Array<Record<string, unknown>> {
    return testApp.db.all('SELECT * FROM backup_policy');
  }

  describe('GET /api/v1/application/backup-policy', () => {
    it('returns seeded defaults on a fresh database: disabled, daily, retention 7, null target', async () => {
      const response = await testApp
        .request()
        .get('/api/v1/application/backup-policy')
        .expect(200);

      expect(response.body).toEqual({
        enabled: false,
        frequency: 'daily',
        retentionCount: 7,
        targetDirectory: null,
        updatedAt: expect.any(String),
      });

      // Assert id is not exposed
      expect(response.body.id).toBeUndefined();
    });

    it('returns 500 when the singleton policy row is missing from the database', async () => {
      testApp.db.run('DELETE FROM backup_policy');

      const response = await testApp
        .request()
        .get('/api/v1/application/backup-policy')
        .expect(500);

      expect(response.body).toMatchObject({
        statusCode: 500,
        message: expect.stringMatching(/missing/i),
      });
    });
  });

  describe('PUT /api/v1/application/backup-policy', () => {
    it('updates each field and GET reflects the changes', async () => {
      const customDir = path.join(tempBaseDir, 'e2e-custom-backups');
      fs.mkdirSync(customDir, { recursive: true });

      const putResponse = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: true,
          frequency: 'weekly',
          retentionCount: 14,
          targetDirectory: customDir,
        })
        .expect(200);

      expect(putResponse.body).toEqual({
        enabled: true,
        frequency: 'weekly',
        retentionCount: 14,
        targetDirectory: customDir,
        updatedAt: expect.any(String),
      });
      expect(putResponse.body.id).toBeUndefined();

      const getResponse = await testApp
        .request()
        .get('/api/v1/application/backup-policy')
        .expect(200);

      expect(getResponse.body).toEqual(putResponse.body);
    });

    it('ensures exactly one policy row exists with id = 1 after several updates', async () => {
      const dir = path.join(tempBaseDir, 'e2e-updates-dir');
      fs.mkdirSync(dir, { recursive: true });

      await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: true,
          frequency: 'hourly',
          retentionCount: 3,
          targetDirectory: dir,
        })
        .expect(200);

      await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: false,
          frequency: 'daily',
          retentionCount: 5,
          targetDirectory: null,
        })
        .expect(200);

      await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: true,
          frequency: 'weekly',
          retentionCount: 10,
          targetDirectory: dir,
        })
        .expect(200);

      const rows = policyRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(1);
      expect(rows[0].enabled).toBe(1);
      expect(rows[0].frequency).toBe('weekly');
      expect(rows[0].retention_count).toBe(10);
      expect(rows[0].target_directory).toBe(dir);
    });

    it('performs boolean round-trip for enabled between API and storage', async () => {
      // Initially 0 in storage, false in API
      const initial = await testApp
        .request()
        .get('/api/v1/application/backup-policy')
        .expect(200);
      expect(initial.body.enabled).toBe(false);

      let row = testApp.db.get<{ enabled: number }>(
        'SELECT enabled FROM backup_policy WHERE id = 1',
      );
      expect(row?.enabled).toBe(0);

      // Update to true
      const putRes1 = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: true,
          frequency: 'daily',
          retentionCount: 7,
          targetDirectory: null,
        })
        .expect(200);
      expect(putRes1.body.enabled).toBe(true);

      row = testApp.db.get<{ enabled: number }>(
        'SELECT enabled FROM backup_policy WHERE id = 1',
      );
      expect(row?.enabled).toBe(1);

      // Update back to false
      const putRes2 = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: false,
          frequency: 'daily',
          retentionCount: 7,
          targetDirectory: null,
        })
        .expect(200);
      expect(putRes2.body.enabled).toBe(false);

      row = testApp.db.get<{ enabled: number }>(
        'SELECT enabled FROM backup_policy WHERE id = 1',
      );
      expect(row?.enabled).toBe(0);
    });

    it('advances updated_at on update', async () => {
      const initial = await testApp
        .request()
        .get('/api/v1/application/backup-policy')
        .expect(200);

      // Wait 10ms to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 15));

      const updated = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: true,
          frequency: 'hourly',
          retentionCount: 14,
          targetDirectory: null,
        })
        .expect(200);

      expect(new Date(updated.body.updatedAt).getTime()).toBeGreaterThan(
        new Date(initial.body.updatedAt).getTime(),
      );
    });

    it('accepts each of the three valid frequencies (hourly, daily, weekly)', async () => {
      for (const freq of ['hourly', 'daily', 'weekly'] as const) {
        const response = await testApp
          .request()
          .put('/api/v1/application/backup-policy')
          .send({
            enabled: false,
            frequency: freq,
            retentionCount: 7,
            targetDirectory: null,
          })
          .expect(200);

        expect(response.body.frequency).toBe(freq);
      }
    });

    it('returns 400 for an invalid frequency', async () => {
      const response = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: false,
          frequency: 'monthly',
          retentionCount: 7,
          targetDirectory: null,
        })
        .expect(400);

      expect(response.body.message).toBe('Request validation failed');
      expect(response.body.details.join(' ')).toMatch(
        /frequency must be one of/i,
      );
    });

    it('returns 400 for retentionCount of 0 and of -1', async () => {
      const resZero = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: false,
          frequency: 'daily',
          retentionCount: 0,
          targetDirectory: null,
        })
        .expect(400);

      expect(resZero.body.message).toBe('Request validation failed');
      expect(resZero.body.details.join(' ')).toMatch(
        /retentionCount must be at least 1/i,
      );

      const resNeg = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: false,
          frequency: 'daily',
          retentionCount: -1,
          targetDirectory: null,
        })
        .expect(400);

      expect(resNeg.body.message).toBe('Request validation failed');
      expect(resNeg.body.details.join(' ')).toMatch(
        /retentionCount must be at least 1/i,
      );
    });

    it('returns 400 for non-integer retentionCount', async () => {
      const res = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: false,
          frequency: 'daily',
          retentionCount: 3.5,
          targetDirectory: null,
        })
        .expect(400);

      expect(res.body.message).toBe('Request validation failed');
      expect(res.body.details.join(' ')).toMatch(
        /retentionCount must be an integer/i,
      );
    });

    it('returns 400 when unknown properties are passed', async () => {
      const res = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          id: 1,
          enabled: false,
          frequency: 'daily',
          retentionCount: 7,
          targetDirectory: null,
        })
        .expect(400);

      expect(res.body.message).toBe('Request validation failed');
      expect(res.body.details.join(' ')).toMatch(
        /property id should not exist/i,
      );
    });

    it('returns 400 when relative targetDirectory is provided', async () => {
      const res = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: false,
          frequency: 'daily',
          retentionCount: 7,
          targetDirectory: 'relative/backup/dir',
        })
        .expect(400);

      expect(res.body.message).toMatch(
        /Target directory must be an absolute path: "relative\/backup\/dir"/,
      );
    });

    it('returns 400 when targetDirectory contains null bytes', async () => {
      const res = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: false,
          frequency: 'daily',
          retentionCount: 7,
          targetDirectory: '/tmp/backups\0evil',
        })
        .expect(400);

      expect(res.body.message).toMatch(
        /Target directory path contains illegal null bytes/,
      );
    });

    it('returns 400 when targetDirectory does not exist', async () => {
      const nonExistent = path.join(tempBaseDir, 'non-existent-e2e-dir');

      const res = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: false,
          frequency: 'daily',
          retentionCount: 7,
          targetDirectory: nonExistent,
        })
        .expect(400);

      expect(res.body.message).toMatch(
        new RegExp(`Target directory does not exist: "${nonExistent}"`),
      );
    });

    it('returns 400 when targetDirectory points at a regular file', async () => {
      const fileTarget = path.join(tempBaseDir, 'e2e-regular-file.txt');
      fs.writeFileSync(fileTarget, 'dummy file');

      const res = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: false,
          frequency: 'daily',
          retentionCount: 7,
          targetDirectory: fileTarget,
        })
        .expect(400);

      expect(res.body.message).toMatch(
        new RegExp(`Target path is not a directory: "${fileTarget}"`),
      );
    });

    it('returns 400 when targetDirectory is a read-only directory', async () => {
      const readOnlyDir = path.join(tempBaseDir, 'e2e-read-only-dir');
      fs.mkdirSync(readOnlyDir, { recursive: true });

      if (process.platform !== 'win32') {
        fs.chmodSync(readOnlyDir, 0o444);

        try {
          const res = await testApp
            .request()
            .put('/api/v1/application/backup-policy')
            .send({
              enabled: false,
              frequency: 'daily',
              retentionCount: 7,
              targetDirectory: readOnlyDir,
            })
            .expect(400);

          expect(res.body.message).toMatch(
            new RegExp(`Target directory is not writable: "${readOnlyDir}"`),
          );
        } finally {
          fs.chmodSync(readOnlyDir, 0o755);
        }
      }
    });

    it('returns 500 when updating a missing policy row', async () => {
      testApp.db.run('DELETE FROM backup_policy');

      const res = await testApp
        .request()
        .put('/api/v1/application/backup-policy')
        .send({
          enabled: true,
          frequency: 'daily',
          retentionCount: 7,
          targetDirectory: null,
        })
        .expect(500);

      expect(res.body).toMatchObject({
        statusCode: 500,
        message: expect.stringMatching(/missing/i),
      });
    });
  });
});
