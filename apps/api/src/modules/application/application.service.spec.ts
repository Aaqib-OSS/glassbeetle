import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../../common/persistence/identifiers.js';
import { nowIso } from '../../common/persistence/timestamps.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { FileStorageService } from '../../file-storage/file-storage.service.js';
import { TestFixtures } from '../../../test/harness/fixtures.js';
import { ApplicationService } from './application.service.js';
import { BackupsService } from './backups/backups.service.js';

describe('ApplicationService', () => {
  let tempBaseDir: string;
  let testDataDir: string;
  let testStorageDir: string;
  let dbService: DatabaseService;
  let fileStorageService: FileStorageService;
  let backupsService: BackupsService;
  let applicationService: ApplicationService;
  let fixtures: TestFixtures;

  beforeEach(async () => {
    tempBaseDir = path.join(os.tmpdir(), `glassbeetle-reset-test-${newId()}`);
    testDataDir = path.join(tempBaseDir, 'data');
    testStorageDir = path.join(testDataDir, 'storage');

    fs.mkdirSync(testDataDir, { recursive: true });
    fs.mkdirSync(testStorageDir, { recursive: true });

    // Create a mock master.key in dataDir
    const masterKeyPath = path.join(testDataDir, 'master.key');
    fs.writeFileSync(masterKeyPath, Buffer.alloc(32, 0x42), { mode: 0o600 });

    const mockAppConfig = {
      dataDir: testDataDir,
      databasePath: path.join(testDataDir, 'test.db'),
      defaultUserName: 'Alice Tester',
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

    applicationService = new ApplicationService(
      dbService,
      fileStorageService,
      backupsService,
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

  describe('Confirmation & Concurrency Validation', () => {
    it('throws BadRequestException (400) when confirmation is missing', async () => {
      await expect(applicationService.reset({})).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        applicationService.reset({ confirm: undefined }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException (400) when confirmation is invalid', async () => {
      await expect(
        applicationService.reset({ confirm: 'false' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        applicationService.reset({ confirm: 'anything_else' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException (409) when reset is already in progress', async () => {
      (applicationService as any).isResetInProgress = true;
      await expect(
        applicationService.reset({ confirm: 'true' }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException (409) when a backup or restore is in progress', async () => {
      vi.spyOn(backupsService, 'isOperationInProgress', 'get').mockReturnValue(
        true,
      );
      await expect(
        applicationService.reset({ confirm: 'true' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Resetting already-empty installation', () => {
    it('succeeds on an empty database without throwing', async () => {
      const response = await applicationService.reset({ confirm: 'true' });
      expect(response.status).toBe('completed');
      expect(response.cleared.agentsCleared).toBe(0);
      expect(response.cleared.chatsCleared).toBe(0);

      // Verify backup_policy exists with defaults
      const policy = dbService.get<{
        enabled: number;
        frequency: string;
        retention_count: number;
        target_directory: string | null;
      }>('SELECT * FROM backup_policy WHERE id = 1');
      expect(policy).toBeDefined();
      expect(policy?.enabled).toBe(0);
      expect(policy?.frequency).toBe('daily');
      expect(policy?.retention_count).toBe(7);
      expect(policy?.target_directory).toBeNull();
    });
  });

  describe('Fully Populated Database Reset', () => {
    it('clears all user content, unlinks files, resets singletons, and preserves backups and master.key', async () => {
      // 1. Populate database with test fixtures
      const prompt = fixtures.createSystemPrompt({ name: 'System Prompt 1' });
      const provider = fixtures.createProvider({ name: 'Provider 1' });
      const model = fixtures.createModel({ provider_id: provider.id });
      fixtures.createCredential(provider.id);

      // Stored files
      const pic = await fileStorageService.write(
        'pictures',
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
        { extension: 'jpg' },
      );
      const projImg = await fileStorageService.write(
        'project-images',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        { extension: 'png' },
      );
      const artBlob = await fileStorageService.write(
        'artifacts',
        Buffer.from('hello artifact world'),
      );

      const agent = fixtures.createAgent({
        name: 'Agent 1',
        system_prompt_id: prompt.id,
        model_id: model.id,
        picture_path: pic.reference,
      });
      fixtures.createAgentMemory({ agent_id: agent.id });
      const team = fixtures.createTeam({ name: 'Team 1' });
      fixtures.createTeamMember(team.id, agent.id);
      const project = fixtures.createProject({
        name: 'Project 1',
        image_path: projImg.reference,
      });
      const chat = fixtures.createChat({
        agent_id: agent.id,
        project_id: project.id,
      });
      fixtures.createMessage({ chat_id: chat.id });
      fixtures.createSharedMemory({ content: 'Global memory note' });
      const artifact = fixtures.createArtifact({
        project_id: project.id,
        chat_id: chat.id,
        agent_id: agent.id,
        file_path: artBlob.reference,
      });
      fixtures.createArtifactVersion({
        artifact_id: artifact.id,
        version: 2,
        file_path: artBlob.reference,
      });
      fixtures.createUsageEvent({
        agent_id: agent.id,
        provider_id: provider.id,
        model_id: model.id,
        chat_id: chat.id,
      });

      // Modify singletons
      dbService.run(
        "UPDATE backup_policy SET enabled = 1, frequency = 'weekly', retention_count = 14 WHERE id = 1",
      );
      dbService.run(
        "UPDATE user_profile SET display_name = 'Custom Name', about = 'Something about me' WHERE singleton = 1",
      );
      dbService.run(
        "UPDATE spend_budget SET limit_usd = 50.0, period = 'daily' WHERE singleton = 1",
      );

      // Create a mock backup row and archive file
      const backupId = newId();
      const backupFileName = `backup-${backupId}.tar.gz`;
      const backupDir = path.join(testDataDir, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const backupFilePath = path.join(backupDir, backupFileName);
      fs.writeFileSync(backupFilePath, 'mock backup content');
      dbService.run(
        'INSERT INTO backups (id, file_path, size_bytes, trigger, created_at) VALUES (?, ?, ?, ?, ?)',
        [backupId, backupFileName, 19, 'manual', nowIso()],
      );

      // Verify files exist before reset
      expect(await fileStorageService.exists(pic.reference)).toBe(true);
      expect(await fileStorageService.exists(projImg.reference)).toBe(true);
      expect(await fileStorageService.exists(artBlob.reference)).toBe(true);
      expect(fs.existsSync(backupFilePath)).toBe(true);

      // 2. Perform reset
      const response = await applicationService.reset({ confirm: 'RESET' });
      expect(response.status).toBe('completed');
      expect(response.cleared.agentsCleared).toBe(1);
      expect(response.cleared.chatsCleared).toBe(1);
      expect(response.cleared.messagesCleared).toBe(1);
      expect(response.cleared.memoriesCleared).toBe(2); // 1 agent + 1 shared
      expect(response.cleared.projectsCleared).toBe(1);
      expect(response.cleared.artifactsCleared).toBe(2); // 1 artifact + 1 version
      expect(response.cleared.systemPromptsCleared).toBe(1);
      expect(response.cleared.usageEventsCleared).toBe(1);
      expect(response.cleared.providersCleared).toBe(1);
      expect(response.cleared.modelsCleared).toBe(1);
      expect(response.cleared.backupsPreserved).toBe(true);
      expect(response.cleared.filesDeleted).toBeGreaterThanOrEqual(3);

      // 3. Assert database tables are empty
      const count = (table: string) =>
        (dbService.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count ?? 0);

      expect(count('agents')).toBe(0);
      expect(count('agent_memories')).toBe(0);
      expect(count('teams')).toBe(0);
      expect(count('team_members')).toBe(0);
      expect(count('projects')).toBe(0);
      expect(count('chats')).toBe(0);
      expect(count('messages')).toBe(0);
      expect(count('shared_memories')).toBe(0);
      expect(count('artifacts')).toBe(0);
      expect(count('artifact_versions')).toBe(0);
      expect(count('system_prompts')).toBe(0);
      expect(count('usage_events')).toBe(0);
      expect(count('providers')).toBe(0);
      expect(count('models')).toBe(0);
      expect(count('provider_credentials')).toBe(0);

      // 4. Assert backups survived
      expect(count('backups')).toBe(1);
      expect(fs.existsSync(backupFilePath)).toBe(true);

      // 5. Assert stored files are gone
      expect(await fileStorageService.exists(pic.reference)).toBe(false);
      expect(await fileStorageService.exists(projImg.reference)).toBe(false);
      expect(await fileStorageService.exists(artBlob.reference)).toBe(false);

      // 6. Assert master.key preserved
      const masterKeyPath = path.join(testDataDir, 'master.key');
      expect(fs.existsSync(masterKeyPath)).toBe(true);

      // 7. Assert singletons reset to defaults
      const policy = dbService.get<{
        enabled: number;
        frequency: string;
        retention_count: number;
        target_directory: string | null;
      }>('SELECT * FROM backup_policy WHERE id = 1');
      expect(policy?.enabled).toBe(0);
      expect(policy?.frequency).toBe('daily');
      expect(policy?.retention_count).toBe(7);
      expect(policy?.target_directory).toBeNull();

      const profile = dbService.get<{
        display_name: string;
        about: string | null;
        picture_path: string | null;
      }>('SELECT * FROM user_profile WHERE singleton = 1');
      expect(profile?.display_name).toBe('Alice Tester');
      expect(profile?.about).toBeNull();
      expect(profile?.picture_path).toBeNull();

      const budget = dbService.get<{
        limit_usd: number | null;
        period: string;
      }>('SELECT * FROM spend_budget WHERE singleton = 1');
      expect(budget?.limit_usd).toBeNull();
      expect(budget?.period).toBe('monthly');
    });

    it('preserves providers, models, and credentials when keepProviders: true', async () => {
      const provider = fixtures.createProvider({ name: 'Preserved Provider' });
      const model = fixtures.createModel({ provider_id: provider.id });
      fixtures.createCredential(provider.id);
      fixtures.createAgent({ name: 'Ephemeral Agent', model_id: model.id });

      const response = await applicationService.reset({
        confirm: 'true',
        keepProviders: true,
      });

      expect(response.cleared.providersPreserved).toBe(true);
      expect(response.cleared.providersCleared).toBe(0);
      expect(response.cleared.modelsCleared).toBe(0);
      expect(response.cleared.agentsCleared).toBe(1);

      const count = (table: string) =>
        (dbService.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count ?? 0);

      expect(count('providers')).toBe(1);
      expect(count('models')).toBe(1);
      expect(count('provider_credentials')).toBe(1);
      expect(count('agents')).toBe(0);
    });

    it('creates an automatic safety backup before reset when createBackup: true', async () => {
      fixtures.createAgent({ name: 'Pre-Backup Agent' });

      const createBackupSpy = vi.spyOn(backupsService, 'createBackup');

      const response = await applicationService.reset({
        confirm: 'true',
        createBackup: true,
      });

      expect(createBackupSpy).toHaveBeenCalled();
      expect(response.cleared.preResetBackupCreated).toBe(true);
      expect(response.cleared.preResetBackupId).toBeDefined();
    });

    it('rolls back database modifications when a mid-reset database error occurs', async () => {
      fixtures.createAgent({ name: 'Agent Before Failure' });

      // Simulate mid-transaction SQL failure
      vi.spyOn(dbService, 'run').mockImplementation((sql: string) => {
        if (sql.includes('DELETE FROM agents')) {
          throw new Error('Simulated SQLite disk error mid-transaction');
        }
        return dbService.db.prepare(sql).run();
      });

      await expect(
        applicationService.reset({ confirm: 'true' }),
      ).rejects.toThrow(InternalServerErrorException);

      // Verify agent was NOT deleted due to transaction rollback
      const agentCount = dbService.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM agents',
      );
      expect(agentCount?.count).toBe(1);
    });
  });
});
