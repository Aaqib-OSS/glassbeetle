import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../../../common/persistence/identifiers.js';
import { nowIso } from '../../../common/persistence/timestamps.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DatabaseService } from '../../../database/database.service.js';
import { FileStorageService } from '../../../file-storage/file-storage.service.js';
import { TestFixtures } from '../../../../test/harness/fixtures.js';
import { BackupsService } from './backups.service.js';
import { BackupManifest } from './backups.types.js';

describe('BackupsService', () => {
  let tempBaseDir: string;
  let testDataDir: string;
  let testStorageDir: string;
  let testBackupTargetDir: string;
  let dbService: DatabaseService;
  let fileStorageService: FileStorageService;
  let backupsService: BackupsService;
  let fixtures: TestFixtures;

  beforeEach(async () => {
    tempBaseDir = path.join(os.tmpdir(), `glassbeetle-backups-test-${newId()}`);
    testDataDir = path.join(tempBaseDir, 'data');
    testStorageDir = path.join(testDataDir, 'storage');
    testBackupTargetDir = path.join(tempBaseDir, 'custom-backups');

    fs.mkdirSync(testDataDir, { recursive: true });
    fs.mkdirSync(testStorageDir, { recursive: true });
    fs.mkdirSync(testBackupTargetDir, { recursive: true });

    const mockAppConfig = {
      dataDir: testDataDir,
      databasePath: path.join(testDataDir, 'test.db'),
    } as AppConfigService;

    dbService = new DatabaseService(mockAppConfig);
    dbService.connect(path.join(testDataDir, 'test.db'));

    fileStorageService = new FileStorageService(mockAppConfig, testStorageDir);
    await fileStorageService.onModuleInit();

    backupsService = new BackupsService(
      dbService,
      fileStorageService,
      mockAppConfig,
    );

    fixtures = new TestFixtures(dbService);
  });

  afterEach(async () => {
    dbService.close();
    try {
      if (fs.existsSync(tempBaseDir)) {
        await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
      }
    } catch {}
    vi.restoreAllMocks();
  });

  it('creates a backup against a seeded database and asserts archive exists, is recorded, and contains all three components', async () => {
    // 1. Seed database
    const prompt = fixtures.createSystemPrompt({ name: 'Backup Test Prompt' });
    const provider = fixtures.createProvider({ name: 'Anthropic Test' });
    const model = fixtures.createModel({
      provider_id: provider.id,
      display_name: 'Claude 3.5 Sonnet',
    });
    const agent = fixtures.createAgent({
      name: 'Test Agent',
      system_prompt_id: prompt.id,
      model_id: model.id,
    });
    const chat = fixtures.createChat({ agent_id: agent.id, title: 'Chat 1' });
    fixtures.createMessage({ chat_id: chat.id, content: 'Hello Glassbeetle!' });

    // 2. Seed file storage
    const avatarContent = Buffer.from('fake image content avatar');
    const avatarResult = await fileStorageService.write(
      'pictures',
      avatarContent,
      {
        declaredMimeType: 'image/png',
      },
    );

    const artifactContent = Buffer.from('console.log("hello world");');
    const artifactResult = await fileStorageService.write(
      'artifacts',
      artifactContent,
      {
        declaredMimeType: 'text/plain',
      },
    );

    // 3. Create backup
    const result = await backupsService.createBackup({
      trigger: 'manual',
      label: 'Full Test Backup',
      note: 'Comprehensive test archive verification',
    });

    // 4. Assert response shape
    expect(result.id).toBeDefined();
    expect(result.trigger).toBe('manual');
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.createdAt).toBeDefined();

    // 5. Assert row recorded in backups table
    const backupRow = dbService.get<{
      id: string;
      file_path: string;
      size_bytes: number;
      trigger: string;
      created_at: string;
    }>('SELECT * FROM backups WHERE id = ?', [result.id]);

    expect(backupRow).toBeDefined();
    expect(backupRow?.id).toBe(result.id);
    expect(backupRow?.trigger).toBe('manual');
    expect(backupRow?.size_bytes).toBe(result.sizeBytes);

    const archivePath = path.join(testDataDir, 'backups', backupRow!.file_path);
    expect(fs.existsSync(archivePath)).toBe(true);

    // Assert size_bytes matches actual file on disk
    const diskStat = await fs.promises.stat(archivePath);
    expect(diskStat.size).toBe(result.sizeBytes);

    // 6. Inspect archive contents
    const extractDir = path.join(tempBaseDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    await tar.x({
      file: archivePath,
      cwd: extractDir,
    });

    expect(fs.existsSync(path.join(extractDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, 'database.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, 'files'))).toBe(true);

    // 7. Verify manifest.json
    const manifestRaw = await fs.promises.readFile(
      path.join(extractDir, 'manifest.json'),
      'utf8',
    );
    const manifest: BackupManifest = JSON.parse(manifestRaw);

    expect(manifest.formatVersion).toBe(1);
    expect(manifest.appVersion).toBe('0.1.0');
    expect(manifest.createdAt).toBe(result.createdAt);
    expect(manifest.databaseSchemaVersion).toBeDefined();
    expect(manifest.label).toBe('Full Test Backup');
    expect(manifest.note).toBe('Comprehensive test archive verification');
    expect(manifest.fileInventory).toBeInstanceOf(Array);
    expect(manifest.fileInventory.length).toBe(2);

    const relativeAvatarPath = `files/${avatarResult.reference}`;
    const avatarInventory = manifest.fileInventory.find(
      (f) => f.path === relativeAvatarPath,
    );
    expect(avatarInventory).toBeDefined();
    expect(avatarInventory?.sizeBytes).toBe(avatarContent.length);
    expect(avatarInventory?.sha256).toBe(
      createHash('sha256').update(avatarContent).digest('hex'),
    );

    // 8. Extract database snapshot and assert it opens and contains the seeded rows
    const snapshotDb = new Database(path.join(extractDir, 'database.sqlite'));
    try {
      const snapPrompt = snapshotDb
        .prepare('SELECT * FROM system_prompts WHERE id = ?')
        .get(prompt.id) as { name: string };
      expect(snapPrompt?.name).toBe('Backup Test Prompt');

      const snapAgent = snapshotDb
        .prepare('SELECT * FROM agents WHERE id = ?')
        .get(agent.id) as { name: string };
      expect(snapAgent?.name).toBe('Test Agent');

      const snapChat = snapshotDb
        .prepare('SELECT * FROM chats WHERE id = ?')
        .get(chat.id) as { title: string };
      expect(snapChat?.title).toBe('Chat 1');

      const snapMessage = snapshotDb
        .prepare('SELECT * FROM messages WHERE chat_id = ?')
        .get(chat.id) as { content: string };
      expect(snapMessage?.content).toBe('Hello Glassbeetle!');
    } finally {
      snapshotDb.close();
    }

    // 9. Assert file storage contents intact in files/
    const extractedAvatar = await fs.promises.readFile(
      path.join(extractDir, 'files', avatarResult.reference),
    );
    expect(extractedAvatar).toEqual(avatarContent);

    const extractedArtifact = await fs.promises.readFile(
      path.join(extractDir, 'files', artifactResult.reference),
    );
    expect(extractedArtifact).toEqual(artifactContent);
  });

  it('uses target_directory from backup_policy when configured', async () => {
    // Configure target_directory in backup_policy table
    dbService.run(
      'UPDATE backup_policy SET target_directory = ?, updated_at = ? WHERE id = 1',
      [testBackupTargetDir, nowIso()],
    );

    const result = await backupsService.createBackup({ trigger: 'scheduled' });
    expect(result.trigger).toBe('scheduled');

    const backupRow = dbService.get<{ file_path: string }>(
      'SELECT file_path FROM backups WHERE id = ?',
      [result.id],
    );
    expect(backupRow?.file_path).toBe(`backup-${result.id}.tar.gz`);
    expect(path.isAbsolute(backupRow!.file_path)).toBe(false);
    expect(backupRow!.file_path).not.toMatch(/[\\/]/);
    expect(
      fs.existsSync(path.join(testBackupTargetDir, backupRow!.file_path)),
    ).toBe(true);
  });

  it('stores only the archive filename in file_path', async () => {
    const result = await backupsService.createBackup();
    const row = dbService.get<{ file_path: string }>(
      'SELECT file_path FROM backups WHERE id = ?',
      [result.id],
    );

    expect(row?.file_path).toBe(`backup-${result.id}.tar.gz`);
    expect(path.isAbsolute(row!.file_path)).toBe(false);
    expect(row!.file_path).not.toMatch(/[\\/]/);
  });

  it('resolves legacy absolute file_path values against the target directory', async () => {
    const id = '018f3a9e-0000-7000-8000-000000000123';
    const legacyPath = path.join(testBackupTargetDir, `backup-${id}.tar.gz`);
    fs.writeFileSync(legacyPath, 'legacy archive bytes');

    dbService.run(
      'UPDATE backup_policy SET target_directory = ?, updated_at = ? WHERE id = 1',
      [testBackupTargetDir, nowIso()],
    );
    dbService.run(
      `INSERT INTO backups (id, file_path, size_bytes, trigger, created_at)
       VALUES (?, ?, ?, 'manual', ?)`,
      [id, legacyPath, 20, nowIso()],
    );

    const found = await backupsService.findOne(id);
    expect(found.hasArchive).toBe(true);
    expect(found.isAvailable).toBe(true);

    await backupsService.deleteBackup(id);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it('resolves a backup through the storage root after that root moves to a different mount', async () => {
    const result = await backupsService.createBackup();
    const row = dbService.get<{ file_path: string }>(
      'SELECT file_path FROM backups WHERE id = ?',
      [result.id],
    );

    // The stored reference is relative, not the absolute path of the machine
    // that produced the archive.
    expect(path.isAbsolute(row!.file_path)).toBe(false);

    // Simulate moving the storage root to a different mount: keep the backup
    // under its backups bucket there, remove the original, and point a fresh
    // service instance (with a fresh FileStorageService root) at the new mount.
    const movedRoot = path.join(tempBaseDir, 'moved-mount');
    const movedStorageRoot = path.join(movedRoot, 'storage');
    const movedBackupDir = path.join(movedStorageRoot, 'backups');
    fs.mkdirSync(movedBackupDir, { recursive: true });
    fs.copyFileSync(
      path.join(testDataDir, 'backups', row!.file_path),
      path.join(movedBackupDir, row!.file_path),
    );
    fs.unlinkSync(path.join(testDataDir, 'backups', row!.file_path));

    dbService.run(
      'UPDATE backup_policy SET target_directory = ?, updated_at = ? WHERE id = 1',
      [movedBackupDir, nowIso()],
    );

    const movedConfig = {
      dataDir: movedRoot,
      databasePath: path.join(movedRoot, 'test.db'),
    } as AppConfigService;
    const movedStorageService = new FileStorageService(movedConfig);
    await movedStorageService.onModuleInit();
    const movedBackupsService = new BackupsService(
      dbService,
      movedStorageService,
      movedConfig,
    );

    expect(movedStorageService.storageRoot).toBe(movedStorageRoot);

    const found = await movedBackupsService.findOne(result.id);
    expect(found.hasArchive).toBe(true);
    expect(found.isAvailable).toBe(true);
  });

  it('serialises backups and throws 409 Conflict when a backup is already in progress', async () => {
    // Simulate active backup by setting flag
    (backupsService as any).isBackupInProgress = true;

    await expect(backupsService.createBackup()).rejects.toThrow(
      ConflictException,
    );

    // Reset flag and verify it succeeds
    (backupsService as any).isBackupInProgress = false;
    const result = await backupsService.createBackup();
    expect(result).toBeDefined();
  });

  it('creates a backup while concurrent database writes are happening, ensuring a valid openable snapshot', async () => {
    fixtures.createSystemPrompt({ name: 'Base Prompt' });

    // Simulate concurrent database writes during VACUUM INTO / execution
    const writePromises = Array.from({ length: 5 }, (_, i) => {
      return Promise.resolve().then(() => {
        fixtures.createSystemPrompt({ name: `Concurrent Prompt ${i}` });
      });
    });

    const [backupResult] = await Promise.all([
      backupsService.createBackup(),
      ...writePromises,
    ]);

    expect(backupResult).toBeDefined();

    const backupRow = dbService.get<{ file_path: string }>(
      'SELECT file_path FROM backups WHERE id = ?',
      [backupResult.id],
    );

    const extractDir = path.join(tempBaseDir, 'concurrent-extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    await tar.x({
      file: path.join(testDataDir, 'backups', backupRow!.file_path),
      cwd: extractDir,
    });

    const snapshotDb = new Database(path.join(extractDir, 'database.sqlite'));
    try {
      const basePrompt = snapshotDb
        .prepare('SELECT * FROM system_prompts WHERE name = ?')
        .get('Base Prompt');
      expect(basePrompt).toBeDefined();
    } finally {
      snapshotDb.close();
    }
  });

  it('simulates a failure mid-creation; asserts no partial archive remains and no row was recorded', async () => {
    const writeSpy = vi
      .spyOn(fs.promises, 'writeFile')
      .mockRejectedValueOnce(
        new Error('Simulated I/O disk failure during manifest writing'),
      );

    await expect(backupsService.createBackup()).rejects.toThrow(
      InternalServerErrorException,
    );

    // Assert no row was recorded
    const rows = dbService.all('SELECT * FROM backups');
    expect(rows).toEqual([]);

    // Assert no partial or final archives exist in target dir
    const defaultBackupDir = path.join(testDataDir, 'backups');
    if (fs.existsSync(defaultBackupDir)) {
      const files = fs.readdirSync(defaultBackupDir);
      expect(
        files.filter((f) => f.endsWith('.tar.gz') || f.endsWith('.tmp')),
      ).toEqual([]);
    }

    writeSpy.mockRestore();
  });

  it('throws BadRequestException when target directory does not exist or is unwritable', async () => {
    const invalidDir = path.join(tempBaseDir, 'non-existent-directory-12345');
    dbService.run(
      'UPDATE backup_policy SET target_directory = ?, updated_at = ? WHERE id = 1',
      [invalidDir, nowIso()],
    );

    await expect(backupsService.createBackup()).rejects.toThrow(
      BadRequestException,
    );

    // Also test unwritable directory
    const readOnlyDir = path.join(tempBaseDir, 'read-only-dir');
    fs.mkdirSync(readOnlyDir, { recursive: true });
    // On POSIX platforms, test permissions
    if (process.platform !== 'win32') {
      fs.chmodSync(readOnlyDir, 0o444);
      dbService.run(
        'UPDATE backup_policy SET target_directory = ?, updated_at = ? WHERE id = 1',
        [readOnlyDir, nowIso()],
      );

      await expect(backupsService.createBackup()).rejects.toThrow(
        BadRequestException,
      );

      fs.chmodSync(readOnlyDir, 0o755);
    }
  });

  it('detects insufficient disk space and throws 507 Insufficient Storage', async () => {
    if (typeof fs.statfsSync === 'function') {
      const statfsSpy = vi.spyOn(fs, 'statfsSync').mockReturnValue({
        bavail: 0,
        bsize: 4096,
        blocks: 1000,
        bfree: 0,
        type: 0,
        ffree: 0,
        files: 0,
      } as any);

      await expect(backupsService.createBackup()).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(HttpException);
          expect((err as HttpException).getStatus()).toBe(
            HttpStatus.INSUFFICIENT_STORAGE,
          );
          return true;
        },
      );

      statfsSpy.mockRestore();
    }
  });

  it('never leaks provider credentials into log output during backup operations', async () => {
    const rawSecretApiKey = 'sk-ant-api03-super-secret-production-token-12345';
    fixtures.createCredential(undefined, {
      masked_preview: 'sk-ant-…12345',
      encrypted_value: Buffer.from(rawSecretApiKey),
    });

    const logs: string[] = [];
    const logSpy = vi
      .spyOn((backupsService as any).logger, 'log')
      .mockImplementation((msg: string) => logs.push(msg));
    const errorSpy = vi
      .spyOn((backupsService as any).logger, 'error')
      .mockImplementation((msg: string) => logs.push(msg));
    const warnSpy = vi
      .spyOn((backupsService as any).logger, 'warn')
      .mockImplementation((msg: string) => logs.push(msg));

    await backupsService.createBackup();

    for (const log of logs) {
      expect(log).not.toContain(rawSecretApiKey);
      expect(log).not.toContain('encrypted_value');
    }

    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  describe('findAll', () => {
    it('returns empty collection with total 0 when no backups exist', async () => {
      const result = await backupsService.findAll();
      expect(result).toEqual({
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
      });
    });

    it('returns backups sorted newest first by default, with pagination and trigger filter', async () => {
      dbService.run(
        'UPDATE backup_policy SET target_directory = ?, updated_at = ? WHERE id = 1',
        [testBackupTargetDir, nowIso()],
      );

      // Seed 3 backups with distinct timestamps
      const fakeArchive = path.join(testBackupTargetDir, 'dummy.tar.gz');
      fs.writeFileSync(fakeArchive, 'dummy bytes');

      dbService.run(
        `INSERT INTO backups (id, file_path, size_bytes, trigger, created_at)
         VALUES
         ('018f3a9e-0000-7000-8000-000000000001', ?, 100, 'manual', '2026-11-10T10:00:00.000Z'),
         ('018f3a9e-0000-7000-8000-000000000002', ?, 200, 'scheduled', '2026-11-12T10:00:00.000Z'),
         ('018f3a9e-0000-7000-8000-000000000003', ?, 300, 'manual', '2026-11-15T10:00:00.000Z')`,
        [fakeArchive, fakeArchive, fakeArchive],
      );

      // Default findAll should sort newest first (2026-11-15 first)
      const listDefault = await backupsService.findAll();
      expect(listDefault.total).toBe(3);
      expect(listDefault.items).toHaveLength(3);
      expect(listDefault.items[0].id).toBe(
        '018f3a9e-0000-7000-8000-000000000003',
      );
      expect(listDefault.items[1].id).toBe(
        '018f3a9e-0000-7000-8000-000000000002',
      );
      expect(listDefault.items[2].id).toBe(
        '018f3a9e-0000-7000-8000-000000000001',
      );

      // Assert no item exposes file_path
      for (const item of listDefault.items) {
        expect((item as any).file_path).toBeUndefined();
        expect((item as any).filePath).toBeUndefined();
        expect(item.hasArchive).toBe(true);
      }

      // Test trigger filter: 'manual'
      const manualOnly = await backupsService.findAll({
        trigger: 'manual',
      } as any);
      expect(manualOnly.total).toBe(2);
      expect(manualOnly.items.every((i) => i.trigger === 'manual')).toBe(true);

      // Test trigger filter: 'scheduled'
      const scheduledOnly = await backupsService.findAll({
        trigger: 'scheduled',
      } as any);
      expect(scheduledOnly.total).toBe(1);
      expect(scheduledOnly.items[0].id).toBe(
        '018f3a9e-0000-7000-8000-000000000002',
      );

      // Test pagination: limit 1, offset 1
      const paginated = await backupsService.findAll({
        limit: 1,
        offset: 1,
      } as any);
      expect(paginated.total).toBe(3);
      expect(paginated.limit).toBe(1);
      expect(paginated.offset).toBe(1);
      expect(paginated.items).toHaveLength(1);
      expect(paginated.items[0].id).toBe(
        '018f3a9e-0000-7000-8000-000000000002',
      );

      // Test invalid trigger filter throws BadRequestException
      await expect(
        backupsService.findAll({ trigger: 'invalid_trigger' as any } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findOne & findById', () => {
    it('returns backup metadata and reports archive presence', async () => {
      const backupResult = await backupsService.createBackup({
        trigger: 'manual',
        label: 'Retrieve Test',
      });

      const retrieved = await backupsService.findOne(backupResult.id);
      expect(retrieved).toMatchObject({
        id: backupResult.id,
        trigger: 'manual',
        sizeBytes: backupResult.sizeBytes,
        createdAt: backupResult.createdAt,
        hasArchive: true,
        isAvailable: true,
      });
      expect((retrieved as any).file_path).toBeUndefined();
      expect((retrieved as any).filePath).toBeUndefined();
    });

    it('reports hasArchive: false when the archive file is removed externally', async () => {
      const backupResult = await backupsService.createBackup();
      const row = dbService.get<{ file_path: string }>(
        'SELECT file_path FROM backups WHERE id = ?',
        [backupResult.id],
      );

      // Remove archive file on disk externally
      fs.unlinkSync(path.join(testDataDir, 'backups', row!.file_path));

      const retrieved = await backupsService.findOne(backupResult.id);
      expect(retrieved.id).toBe(backupResult.id);
      expect(retrieved.hasArchive).toBe(false);
      expect(retrieved.isAvailable).toBe(false);
    });

    it('throws NotFoundException (404) when retrieving unknown ID', async () => {
      await expect(
        backupsService.findOne('018f3a9e-0000-7000-8000-000000000999'),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns null from findById when unknown ID is queried', async () => {
      const found = await backupsService.findById(
        '018f3a9e-0000-7000-8000-000000000999',
      );
      expect(found).toBeNull();
    });
  });

  describe('deleteBackup', () => {
    it('removes both the database row and the archive file from disk', async () => {
      const backupResult = await backupsService.createBackup();
      const row = dbService.get<{ file_path: string }>(
        'SELECT file_path FROM backups WHERE id = ?',
        [backupResult.id],
      );
      const archivePath = path.join(testDataDir, 'backups', row!.file_path);
      expect(fs.existsSync(archivePath)).toBe(true);

      await backupsService.deleteBackup(backupResult.id);

      // Verify row is deleted
      const checkRow = dbService.get('SELECT * FROM backups WHERE id = ?', [
        backupResult.id,
      ]);
      expect(checkRow).toBeUndefined();

      // Verify file is unlinked from disk
      expect(fs.existsSync(archivePath)).toBe(false);
    });

    it('succeeds and removes database row when archive file is already missing on disk', async () => {
      const backupResult = await backupsService.createBackup();
      const row = dbService.get<{ file_path: string }>(
        'SELECT file_path FROM backups WHERE id = ?',
        [backupResult.id],
      );

      // Manually delete file before calling deleteBackup
      const archivePath = path.join(testDataDir, 'backups', row!.file_path);
      fs.unlinkSync(archivePath);
      expect(fs.existsSync(archivePath)).toBe(false);

      await backupsService.deleteBackup(backupResult.id);

      // Verify row was removed cleanly
      const checkRow = dbService.get('SELECT * FROM backups WHERE id = ?', [
        backupResult.id,
      ]);
      expect(checkRow).toBeUndefined();
    });

    it('throws NotFoundException (404) when deleting unknown backup ID', async () => {
      await expect(
        backupsService.deleteBackup('018f3a9e-0000-7000-8000-000000000999'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
