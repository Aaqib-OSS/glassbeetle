import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
        hasArchive: true,
        isAvailable: true,
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
      expect(response.body.hasArchive).toBe(true);
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

  describe('GET /api/v1/application/backups', () => {
    it('returns 200 with empty collection when no backups exist', async () => {
      const response = await testApp
        .request()
        .get('/api/v1/application/backups')
        .expect(200);

      expect(response.body).toEqual({
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
      });
    });

    it('returns backups sorted newest first by default, with pagination and trigger filter', async () => {
      const tempArchive = path.join(os.tmpdir(), 'dummy.tar.gz');
      fs.writeFileSync(tempArchive, 'dummy bytes');

      testApp.db.run(
        `INSERT INTO backups (id, file_path, size_bytes, trigger, created_at)
         VALUES
         ('018f3a9e-0000-7000-8000-000000000001', ?, 100, 'manual', '2026-11-10T10:00:00.000Z'),
         ('018f3a9e-0000-7000-8000-000000000002', ?, 200, 'scheduled', '2026-11-12T10:00:00.000Z'),
         ('018f3a9e-0000-7000-8000-000000000003', ?, 300, 'manual', '2026-11-15T10:00:00.000Z')`,
        [tempArchive, tempArchive, tempArchive],
      );

      // Default query: newest first (2026-11-15 first)
      const listResponse = await testApp
        .request()
        .get('/api/v1/application/backups')
        .expect(200);

      expect(listResponse.body.total).toBe(3);
      expect(listResponse.body.items).toHaveLength(3);
      expect(listResponse.body.items[0].id).toBe(
        '018f3a9e-0000-7000-8000-000000000003',
      );
      expect(listResponse.body.items[1].id).toBe(
        '018f3a9e-0000-7000-8000-000000000002',
      );
      expect(listResponse.body.items[2].id).toBe(
        '018f3a9e-0000-7000-8000-000000000001',
      );

      // Verify no response body contains absolute file path
      for (const item of listResponse.body.items) {
        expect(item.file_path).toBeUndefined();
        expect(item.filePath).toBeUndefined();
        expect(item.hasArchive).toBe(true);
      }

      // Filter by trigger=scheduled
      const scheduledResponse = await testApp
        .request()
        .get('/api/v1/application/backups?trigger=scheduled')
        .expect(200);

      expect(scheduledResponse.body.total).toBe(1);
      expect(scheduledResponse.body.items).toHaveLength(1);
      expect(scheduledResponse.body.items[0].id).toBe(
        '018f3a9e-0000-7000-8000-000000000002',
      );

      // Pagination
      const pageResponse = await testApp
        .request()
        .get('/api/v1/application/backups?limit=1&offset=1')
        .expect(200);

      expect(pageResponse.body.total).toBe(3);
      expect(pageResponse.body.limit).toBe(1);
      expect(pageResponse.body.offset).toBe(1);
      expect(pageResponse.body.items[0].id).toBe(
        '018f3a9e-0000-7000-8000-000000000002',
      );

      // Invalid trigger filter returns 400
      await testApp
        .request()
        .get('/api/v1/application/backups?trigger=invalid_trigger')
        .expect(400);
    });
  });

  describe('GET /api/v1/application/backups/:backupId', () => {
    it('retrieves backup metadata and reports archive presence', async () => {
      const createRes = await testApp
        .request()
        .post('/api/v1/application/backups')
        .send({ label: 'Single retrieve' })
        .expect(201);

      const retrieveRes = await testApp
        .request()
        .get(`/api/v1/application/backups/${createRes.body.id}`)
        .expect(200);

      expect(retrieveRes.body).toMatchObject({
        id: createRes.body.id,
        trigger: 'manual',
        sizeBytes: createRes.body.sizeBytes,
        hasArchive: true,
        isAvailable: true,
      });
      expect(retrieveRes.body.file_path).toBeUndefined();
      expect(retrieveRes.body.filePath).toBeUndefined();
    });

    it('reports hasArchive: false when the archive file is removed externally', async () => {
      const createRes = await testApp
        .request()
        .post('/api/v1/application/backups')
        .expect(201);

      const row = testApp.db.get<{ file_path: string }>(
        'SELECT file_path FROM backups WHERE id = ?',
        [createRes.body.id],
      );

      // Unlink archive file externally
      fs.unlinkSync(row!.file_path);

      const retrieveRes = await testApp
        .request()
        .get(`/api/v1/application/backups/${createRes.body.id}`)
        .expect(200);

      expect(retrieveRes.body.id).toBe(createRes.body.id);
      expect(retrieveRes.body.hasArchive).toBe(false);
      expect(retrieveRes.body.isAvailable).toBe(false);
    });

    it('returns 404 NOT_FOUND for unknown valid UUIDv7', async () => {
      await testApp
        .request()
        .get('/api/v1/application/backups/018f3a9e-0000-7000-8000-000000000999')
        .expect(404);
    });

    it('returns 400 INVALID_IDENTIFIER for malformed ID', async () => {
      await testApp
        .request()
        .get('/api/v1/application/backups/not-a-uuid')
        .expect(400);
    });
  });

  describe('DELETE /api/v1/application/backups/:backupId', () => {
    it('deletes both the database row and the archive file on disk', async () => {
      const createRes = await testApp
        .request()
        .post('/api/v1/application/backups')
        .expect(201);

      const row = testApp.db.get<{ file_path: string }>(
        'SELECT file_path FROM backups WHERE id = ?',
        [createRes.body.id],
      );
      expect(fs.existsSync(row!.file_path)).toBe(true);

      await testApp
        .request()
        .delete(`/api/v1/application/backups/${createRes.body.id}`)
        .expect(204);

      // Verify row is gone
      const checkRow = testApp.db.get('SELECT * FROM backups WHERE id = ?', [
        createRes.body.id,
      ]);
      expect(checkRow).toBeUndefined();

      // Verify file is gone
      expect(fs.existsSync(row!.file_path)).toBe(false);
    });

    it('succeeds with 204 and removes database row when archive file was already removed externally', async () => {
      const createRes = await testApp
        .request()
        .post('/api/v1/application/backups')
        .expect(201);

      const row = testApp.db.get<{ file_path: string }>(
        'SELECT file_path FROM backups WHERE id = ?',
        [createRes.body.id],
      );

      // Manually remove file first
      fs.unlinkSync(row!.file_path);
      expect(fs.existsSync(row!.file_path)).toBe(false);

      await testApp
        .request()
        .delete(`/api/v1/application/backups/${createRes.body.id}`)
        .expect(204);

      // Verify row is removed
      const checkRow = testApp.db.get('SELECT * FROM backups WHERE id = ?', [
        createRes.body.id,
      ]);
      expect(checkRow).toBeUndefined();
    });

    it('returns 404 NOT_FOUND when deleting unknown UUIDv7', async () => {
      await testApp
        .request()
        .delete(
          '/api/v1/application/backups/018f3a9e-0000-7000-8000-000000000999',
        )
        .expect(404);
    });

    it('returns 400 INVALID_IDENTIFIER when deleting malformed ID', async () => {
      await testApp
        .request()
        .delete('/api/v1/application/backups/invalid-id')
        .expect(400);
    });
  });
});
