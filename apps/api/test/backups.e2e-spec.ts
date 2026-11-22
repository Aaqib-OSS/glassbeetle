import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
      expect(row?.file_path).toBe(`backup-${response.body.id}.tar.gz`);
      expect(row!.file_path).not.toMatch(/[\\/]/);

      const archivePath = path.join(testApp.dataDir, 'backups', row!.file_path);
      expect(fs.existsSync(archivePath)).toBe(true);

      // Verify archive contains manifest, database and files
      const entries: string[] = [];
      await tar.t({
        file: archivePath,
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
      const tempArchive = path.join(testApp.dataDir, 'backups', 'dummy.tar.gz');
      fs.mkdirSync(path.dirname(tempArchive), { recursive: true });
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
      fs.unlinkSync(path.join(testApp.dataDir, 'backups', row!.file_path));

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
      const archivePath = path.join(testApp.dataDir, 'backups', row!.file_path);
      expect(fs.existsSync(archivePath)).toBe(true);

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
      expect(fs.existsSync(archivePath)).toBe(false);
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
      const archivePath = path.join(testApp.dataDir, 'backups', row!.file_path);
      fs.unlinkSync(archivePath);
      expect(fs.existsSync(archivePath)).toBe(false);

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

  describe('GET /api/v1/application/backups/:backupId/download', () => {
    it('downloads backup archive and asserts received bytes are byte-for-byte identical to the archive on disk', async () => {
      testApp.fixtures.createSystemPrompt({ name: 'Backup Download Prompt' });

      const createRes = await testApp
        .request()
        .post('/api/v1/application/backups')
        .send({ label: 'Download Test Snapshot' })
        .expect(201);

      const row = testApp.db.get<{ file_path: string; created_at: string }>(
        'SELECT file_path, created_at FROM backups WHERE id = ?',
        [createRes.body.id],
      );
      const archivePath = path.join(testApp.dataDir, 'backups', row!.file_path);
      const expectedBytes = fs.readFileSync(archivePath);

      const downloadRes = await testApp
        .request()
        .get(`/api/v1/application/backups/${createRes.body.id}/download`)
        .responseType('blob')
        .expect(200);

      expect(downloadRes.body).toEqual(expectedBytes);
      expect(downloadRes.headers['content-type']).toBe('application/gzip');
      expect(downloadRes.headers['content-length']).toBe(
        String(expectedBytes.length),
      );
      expect(downloadRes.headers['accept-ranges']).toBe('bytes');
      expect(downloadRes.headers['x-content-type-options']).toBe('nosniff');
      expect(downloadRes.headers['cache-control']).toContain('no-cache');

      const expectedSafeTimestamp = row!.created_at.replace(/:/g, '-');
      expect(downloadRes.headers['content-disposition']).toBe(
        `attachment; filename="glassbeetle-backup-${expectedSafeTimestamp}.tar.gz"`,
      );
    });

    it('streams a large archive without buffering the whole file into memory', async () => {
      const largeSize = 512 * 1024; // 512 KiB binary payload
      const largeData = Buffer.alloc(largeSize);
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256;
      }

      const backupId = '018f3a9e-0000-7000-8000-000000000555';
      const fileName = `backup-${backupId}.tar.gz`;
      const archivePath = path.join(testApp.dataDir, 'backups', fileName);
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(archivePath, largeData);

      const createdAt = '2026-11-20T12:00:00.000Z';
      testApp.db.run(
        `INSERT INTO backups (id, file_path, size_bytes, trigger, created_at)
         VALUES (?, ?, ?, 'manual', ?)`,
        [backupId, fileName, largeSize, createdAt],
      );

      const createReadStreamSpy = vi.spyOn(fs, 'createReadStream');

      const downloadRes = await testApp
        .request()
        .get(`/api/v1/application/backups/${backupId}/download`)
        .responseType('blob')
        .expect(200);

      expect(createReadStreamSpy).toHaveBeenCalled();
      expect(downloadRes.body).toEqual(largeData);
      expect(downloadRes.headers['content-length']).toBe(String(largeSize));

      createReadStreamSpy.mockRestore();
    });

    it('supports HTTP byte-range requests with 206 Partial Content', async () => {
      const data = Buffer.from('GLASSBEETLE_BACKUP_STREAMING_RANGE_TEST_BYTES');
      const backupId = '018f3a9e-0000-7000-8000-000000000444';
      const fileName = `backup-${backupId}.tar.gz`;
      const archivePath = path.join(testApp.dataDir, 'backups', fileName);
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(archivePath, data);

      testApp.db.run(
        `INSERT INTO backups (id, file_path, size_bytes, trigger, created_at)
         VALUES (?, ?, ?, 'manual', '2026-11-20T12:00:00.000Z')`,
        [backupId, fileName, data.length],
      );

      // Request bytes 0 to 10 inclusive (11 bytes: 'GLASSBEETLE')
      const rangeRes = await testApp
        .request()
        .get(`/api/v1/application/backups/${backupId}/download`)
        .set('Range', 'bytes=0-10')
        .responseType('blob')
        .expect(206);

      expect(rangeRes.body).toEqual(data.subarray(0, 11));
      expect(rangeRes.headers['content-range']).toBe(`bytes 0-10/${data.length}`);
      expect(rangeRes.headers['content-length']).toBe('11');
      expect(rangeRes.headers['content-type']).toBe('application/gzip');
      expect(rangeRes.headers['accept-ranges']).toBe('bytes');
    });

    it('returns 416 Range Not Satisfiable when range is out of bounds', async () => {
      const data = Buffer.from('SHORT_ARCHIVE');
      const backupId = '018f3a9e-0000-7000-8000-000000000333';
      const fileName = `backup-${backupId}.tar.gz`;
      const archivePath = path.join(testApp.dataDir, 'backups', fileName);
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(archivePath, data);

      testApp.db.run(
        `INSERT INTO backups (id, file_path, size_bytes, trigger, created_at)
         VALUES (?, ?, ?, 'manual', '2026-11-20T12:00:00.000Z')`,
        [backupId, fileName, data.length],
      );

      const res = await testApp
        .request()
        .get(`/api/v1/application/backups/${backupId}/download`)
        .set('Range', 'bytes=500-1000')
        .expect(416);

      expect(res.headers['content-range']).toBe(`bytes */${data.length}`);
    });

    it('returns 404 NOT_FOUND for unknown valid UUIDv7 backupId', async () => {
      const res = await testApp
        .request()
        .get(
          '/api/v1/application/backups/018f3a9e-0000-7000-8000-000000000999/download',
        )
        .expect(404);

      expect(res.body).toMatchObject({
        statusCode: 404,
        code: 'BACKUP_NOT_FOUND',
      });
      // Assert no path in response
      expect(JSON.stringify(res.body)).not.toContain(testApp.dataDir);
    });

    it('returns 400 INVALID_IDENTIFIER for malformed ID', async () => {
      await testApp
        .request()
        .get('/api/v1/application/backups/not-a-valid-uuid/download')
        .expect(400);
    });

    it('returns 410 GONE when backup record exists but archive file was deleted externally', async () => {
      const createRes = await testApp
        .request()
        .post('/api/v1/application/backups')
        .expect(201);

      const row = testApp.db.get<{ file_path: string }>(
        'SELECT file_path FROM backups WHERE id = ?',
        [createRes.body.id],
      );
      const archivePath = path.join(testApp.dataDir, 'backups', row!.file_path);
      fs.unlinkSync(archivePath);

      const res = await testApp
        .request()
        .get(`/api/v1/application/backups/${createRes.body.id}/download`)
        .expect(410);

      expect(res.body).toMatchObject({
        statusCode: 410,
        code: 'BACKUP_ARCHIVE_GONE',
        message: 'Backup archive file is missing from disk',
      });
      // Assert no filesystem paths in error response
      expect(JSON.stringify(res.body)).not.toContain(testApp.dataDir);
      expect(JSON.stringify(res.body)).not.toContain(row!.file_path);
    });

    it('rejects a file_path pointing outside the expected backup directory (400 Bad Request)', async () => {
      const escapeId = '018f3a9e-0000-7000-8000-000000000222';
      // Construct a case directly in the database pointing to an outside file
      testApp.db.run(
        `INSERT INTO backups (id, file_path, size_bytes, trigger, created_at)
         VALUES (?, '/tmp/glassbeetle-escaped-backup.tar.gz', 100, 'manual', '2026-11-20T12:00:00.000Z')`,
        [escapeId],
      );

      const res = await testApp
        .request()
        .get(`/api/v1/application/backups/${escapeId}/download`)
        .expect(400);

      expect(res.body).toMatchObject({
        statusCode: 400,
        code: 'INVALID_BACKUP_PATH',
        message: 'Backup archive path escapes the backup directory boundary',
      });
      // Assert no filesystem path is leaked in response
      expect(JSON.stringify(res.body)).not.toContain('/tmp');
      expect(JSON.stringify(res.body)).not.toContain(testApp.dataDir);
    });

    it('rejects a file_path with directory traversal sequences (400 Bad Request)', async () => {
      const traversalId = '018f3a9e-0000-7000-8000-000000000111';
      testApp.db.run(
        `INSERT INTO backups (id, file_path, size_bytes, trigger, created_at)
         VALUES (?, '../../etc/passwd', 100, 'manual', '2026-11-20T12:00:00.000Z')`,
        [traversalId],
      );

      const res = await testApp
        .request()
        .get(`/api/v1/application/backups/${traversalId}/download`)
        .expect(400);

      expect(res.body).toMatchObject({
        statusCode: 400,
        code: 'INVALID_BACKUP_PATH',
      });
      expect(JSON.stringify(res.body)).not.toContain('..');
      expect(JSON.stringify(res.body)).not.toContain(testApp.dataDir);
    });
  });
});
