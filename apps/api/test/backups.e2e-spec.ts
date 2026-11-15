import fs from 'node:fs';
import * as tar from 'tar';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './harness/index.js';

describe('Backups endpoints (e2e)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(() => {
    testApp.reset();
  });

  describe('POST /api/v1/application/backups', () => {
    it('creates a backup archive on demand and returns 201 with metadata', async () => {
      // Seed a prompt so database has test content
      testApp.fixtures.createSystemPrompt({ name: 'E2E System Prompt' });

      const response = await testApp
        .request()
        .post('/api/v1/application/backups')
        .send({
          label: 'E2E Test Snapshot',
          note: 'Verification of POST /api/v1/application/backups',
        })
        .expect(201);

      expect(response.body).toMatchObject({
        trigger: 'manual',
      });
      expect(typeof response.body.id).toBe('string');
      expect(typeof response.body.sizeBytes).toBe('number');
      expect(response.body.sizeBytes).toBeGreaterThan(0);
      expect(typeof response.body.createdAt).toBe('string');
      expect(response.body.file_path).toBeUndefined();
      expect(response.body.filePath).toBeUndefined();

      // Check database record
      const row = testApp.db.get<{
        id: string;
        file_path: string;
        size_bytes: number;
        trigger: string;
        created_at: string;
      }>('SELECT * FROM backups WHERE id = ?', [response.body.id]);

      expect(row).toBeDefined();
      expect(row?.trigger).toBe('manual');
      expect(row?.size_bytes).toBe(response.body.sizeBytes);
      expect(fs.existsSync(row!.file_path)).toBe(true);

      // Verify archive contains manifest, database and files
      const entries: string[] = [];
      await tar.t({
        file: row!.file_path,
        onentry: (entry) => entries.push(entry.path),
      });

      expect(entries).toContain('manifest.json');
      expect(entries).toContain('database.sqlite');
      expect(
        entries.some((e) => e === 'files/' || e.startsWith('files/')),
      ).toBe(true);
    });

    it('creates a backup successfully when request body is empty', async () => {
      const response = await testApp
        .request()
        .post('/api/v1/application/backups')
        .send({})
        .expect(201);

      expect(response.body.id).toBeDefined();
      expect(response.body.trigger).toBe('manual');
      expect(response.body.sizeBytes).toBeGreaterThan(0);
    });

    it('rejects unknown properties in request body with 400 Bad Request', async () => {
      const response = await testApp
        .request()
        .post('/api/v1/application/backups')
        .send({
          unknownField: 'illegal',
        })
        .expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
      });
    });

    it('rejects invalid property types with 400 Bad Request', async () => {
      const response = await testApp
        .request()
        .post('/api/v1/application/backups')
        .send({
          label: 12345, // Must be string
        })
        .expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
      });
    });
  });
});
