import { HttpException, HttpStatus } from '@nestjs/common';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../../../common/persistence/identifiers.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DatabaseService } from '../../../database/database.service.js';
import { FileStorageService } from '../../../file-storage/file-storage.service.js';
import { BackupSchedulerService } from './backup-scheduler.service.js';
import { BackupsService } from './backups.service.js';

describe('BackupSchedulerService', () => {
  let tempBaseDir: string;
  let testDataDir: string;
  let testStorageDir: string;
  let dbService: DatabaseService;
  let fileStorageService: FileStorageService;
  let backupsService: BackupsService;
  let schedulerService: BackupSchedulerService;
  let mockCurrentTime: Date;

  beforeEach(async () => {
    tempBaseDir = path.join(
      os.tmpdir(),
      `glassbeetle-scheduler-test-${newId()}`,
    );
    testDataDir = path.join(tempBaseDir, 'data');
    testStorageDir = path.join(testDataDir, 'storage');

    fs.mkdirSync(testDataDir, { recursive: true });
    fs.mkdirSync(testStorageDir, { recursive: true });

    const mockAppConfig = {
      dataDir: testDataDir,
      databasePath: path.join(testDataDir, 'test.db'),
      nodeEnv: 'test',
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

    // Initial simulated time: 2026-06-01T12:00:00.000Z
    mockCurrentTime = new Date('2026-06-01T12:00:00.000Z');

    schedulerService = new BackupSchedulerService(
      dbService,
      backupsService,
      mockAppConfig,
      {
        autoStart: false,
        clock: () => mockCurrentTime,
        startupDelayMs: 100,
        checkIntervalMs: 500,
      },
    );
  });

  afterEach(async () => {
    await schedulerService.stop();
    dbService.close();
    try {
      if (fs.existsSync(tempBaseDir)) {
        await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
      }
    } catch {}
    vi.restoreAllMocks();
  });

  function setPolicy(options: {
    enabled: boolean;
    frequency?: 'hourly' | 'daily' | 'weekly';
    retentionCount?: number;
  }): void {
    dbService.run(
      `UPDATE backup_policy
       SET enabled = ?, frequency = ?, retention_count = ?, updated_at = ?
       WHERE id = 1`,
      [
        options.enabled ? 1 : 0,
        options.frequency ?? 'daily',
        options.retentionCount ?? 7,
        mockCurrentTime.toISOString(),
      ],
    );
  }

  it('does nothing while policy enabled is false', async () => {
    setPolicy({ enabled: false, frequency: 'daily' });

    const result = await schedulerService.checkAndRunScheduledBackup();

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('disabled');

    const countRow = dbService.get<{ total: number }>(
      'SELECT COUNT(*) as total FROM backups',
    );
    expect(countRow?.total).toBe(0);
  });

  it('runs a scheduled backup when enabled is true and no prior scheduled backup exists', async () => {
    setPolicy({ enabled: true, frequency: 'daily' });

    const result = await schedulerService.checkAndRunScheduledBackup();

    expect(result.status).toBe('executed');
    expect(result.backupId).toBeDefined();

    const row = dbService.get<{ trigger: string; created_at: string }>(
      'SELECT trigger, created_at FROM backups WHERE id = ?',
      [result.backupId!],
    );
    expect(row?.trigger).toBe('scheduled');
  });

  it('does not run a backup when the configured frequency has not yet elapsed', async () => {
    setPolicy({ enabled: true, frequency: 'daily' });

    // Seed a scheduled backup 10 hours ago
    const lastBackupTime = new Date('2026-06-01T02:00:00.000Z');
    const prevBackup = await backupsService.createBackup({
      trigger: 'scheduled',
    });
    dbService.run('UPDATE backups SET created_at = ? WHERE id = ?', [
      lastBackupTime.toISOString(),
      prevBackup.id,
    ]);

    // Current time is 12:00:00 (10 hours elapsed, daily requires 24 hours)
    const result = await schedulerService.checkAndRunScheduledBackup();

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('not_due');
    expect(result.elapsedMs).toBe(10 * 60 * 60 * 1000);
    expect(result.dueInMs).toBe(14 * 60 * 60 * 1000);

    const countRow = dbService.get<{ total: number }>(
      'SELECT COUNT(*) as total FROM backups',
    );
    expect(countRow?.total).toBe(1);
  });

  it('runs a scheduled backup when the configured frequency has elapsed', async () => {
    setPolicy({ enabled: true, frequency: 'daily' });

    // Seed a scheduled backup 25 hours ago
    const lastBackupTime = new Date('2026-05-31T11:00:00.000Z');
    const prevBackup = await backupsService.createBackup({
      trigger: 'scheduled',
    });
    dbService.run('UPDATE backups SET created_at = ? WHERE id = ?', [
      lastBackupTime.toISOString(),
      prevBackup.id,
    ]);

    // Current time is 2026-06-01T12:00:00.000Z (25 hours elapsed)
    const result = await schedulerService.checkAndRunScheduledBackup();

    expect(result.status).toBe('executed');
    expect(result.backupId).toBeDefined();

    const allScheduled = dbService.all<{ id: string; trigger: string }>(
      "SELECT id, trigger FROM backups WHERE trigger = 'scheduled'",
    );
    expect(allScheduled).toHaveLength(2);
  });

  it('respects different frequencies: hourly (1h), daily (24h), weekly (7d)', async () => {
    const prevBackup = await backupsService.createBackup({
      trigger: 'scheduled',
    });
    const baseline = new Date('2026-06-01T00:00:00.000Z');
    dbService.run('UPDATE backups SET created_at = ? WHERE id = ?', [
      baseline.toISOString(),
      prevBackup.id,
    ]);

    // Hourly: 59 minutes elapsed -> not due; 61 minutes elapsed -> due
    setPolicy({ enabled: true, frequency: 'hourly' });
    mockCurrentTime = new Date('2026-06-01T00:59:00.000Z');
    expect((await schedulerService.checkAndRunScheduledBackup()).status).toBe(
      'skipped',
    );

    mockCurrentTime = new Date('2026-06-01T01:01:00.000Z');
    const hourlyRun = await schedulerService.checkAndRunScheduledBackup();
    expect(hourlyRun.status).toBe('executed');

    // Update the newest backup to be baseline for weekly test
    dbService.run('UPDATE backups SET created_at = ? WHERE id = ?', [
      baseline.toISOString(),
      hourlyRun.backupId!,
    ]);

    // Weekly: 6 days elapsed -> not due; 8 days elapsed -> due
    setPolicy({ enabled: true, frequency: 'weekly' });
    mockCurrentTime = new Date('2026-06-07T00:00:00.000Z'); // 6 days
    expect((await schedulerService.checkAndRunScheduledBackup()).status).toBe(
      'skipped',
    );

    mockCurrentTime = new Date('2026-06-09T00:00:00.000Z'); // 8 days
    const weeklyRun = await schedulerService.checkAndRunScheduledBackup();
    expect(weeklyRun.status).toBe('executed');
  });

  it('runs exactly one overdue backup after a long gap, not one per missed interval', async () => {
    setPolicy({ enabled: true, frequency: 'daily' });

    // Seed a scheduled backup 10 days ago (10 missed intervals!)
    const oldBackup = await backupsService.createBackup({
      trigger: 'scheduled',
    });
    dbService.run(
      "UPDATE backups SET created_at = '2026-05-22T12:00:00.000Z' WHERE id = ?",
      [oldBackup.id],
    );

    // First cycle after opening app at 2026-06-01T12:00:00.000Z
    const run1 = await schedulerService.checkAndRunScheduledBackup();
    expect(run1.status).toBe('executed');

    // Second cycle run 1 minute later
    mockCurrentTime = new Date('2026-06-01T12:01:00.000Z');
    const run2 = await schedulerService.checkAndRunScheduledBackup();

    expect(run2.status).toBe('skipped');
    expect(run2.reason).toBe('not_due');

    // Exactly 2 scheduled backups exist in total (the initial 10-day-old one + 1 new catch-up)
    const countRow = dbService.get<{ total: number }>(
      "SELECT COUNT(*) as total FROM backups WHERE trigger = 'scheduled'",
    );
    expect(countRow?.total).toBe(2);
  });

  it('enforces retention: prunes oldest scheduled backups beyond retentionCount, deleting rows and files', async () => {
    setPolicy({ enabled: true, frequency: 'hourly', retentionCount: 2 });

    // Create 2 existing scheduled backups
    const b1 = await backupsService.createBackup({ trigger: 'scheduled' });
    const b2 = await backupsService.createBackup({ trigger: 'scheduled' });
    dbService.run(
      "UPDATE backups SET created_at = '2026-06-01T08:00:00.000Z' WHERE id = ?",
      [b1.id],
    );
    dbService.run(
      "UPDATE backups SET created_at = '2026-06-01T09:00:00.000Z' WHERE id = ?",
      [b2.id],
    );

    const b1Path = path.join(testDataDir, 'backups', `backup-${b1.id}.tar.gz`);
    const b2Path = path.join(testDataDir, 'backups', `backup-${b2.id}.tar.gz`);
    expect(fs.existsSync(b1Path)).toBe(true);
    expect(fs.existsSync(b2Path)).toBe(true);

    // Run scheduled backup at 12:00:00 (more than 1 hour since b2).
    // Total scheduled backups will become 3; retentionCount is 2, so b1 must be pruned.
    const result = await schedulerService.checkAndRunScheduledBackup();

    expect(result.status).toBe('executed');
    expect(result.prunedCount).toBe(1);

    // b1 is pruned: row gone, file gone
    expect(await backupsService.findById(b1.id)).toBeNull();
    expect(fs.existsSync(b1Path)).toBe(false);

    // b2 and new backup are retained
    expect(await backupsService.findById(b2.id)).not.toBeNull();
    expect(fs.existsSync(b2Path)).toBe(true);
    expect(await backupsService.findById(result.backupId!)).not.toBeNull();
  });

  it('prominently preserves manual backups during retention: manual backups are NEVER pruned', async () => {
    setPolicy({ enabled: true, frequency: 'hourly', retentionCount: 1 });

    // User creates deliberate manual backups
    const manual1 = await backupsService.createBackup({ trigger: 'manual' });
    const manual2 = await backupsService.createBackup({ trigger: 'manual' });

    // And 1 scheduled backup 2 hours ago
    const sched1 = await backupsService.createBackup({ trigger: 'scheduled' });
    dbService.run(
      "UPDATE backups SET created_at = '2026-06-01T10:00:00.000Z' WHERE id = ?",
      [sched1.id],
    );

    const manual1Path = path.join(
      testDataDir,
      'backups',
      `backup-${manual1.id}.tar.gz`,
    );
    const manual2Path = path.join(
      testDataDir,
      'backups',
      `backup-${manual2.id}.tar.gz`,
    );
    const sched1Path = path.join(
      testDataDir,
      'backups',
      `backup-${sched1.id}.tar.gz`,
    );

    // Run scheduled backup at 12:00:00.
    // retentionCount is 1: sched1 will be pruned to retain 1 scheduled backup.
    // BOTH manual backups MUST be preserved!
    const result = await schedulerService.checkAndRunScheduledBackup();

    expect(result.status).toBe('executed');
    expect(result.prunedCount).toBe(1);

    // Sched1 was pruned
    expect(await backupsService.findById(sched1.id)).toBeNull();
    expect(fs.existsSync(sched1Path)).toBe(false);

    // Manual backups were NOT touched
    expect(await backupsService.findById(manual1.id)).not.toBeNull();
    expect(await backupsService.findById(manual2.id)).not.toBeNull();
    expect(fs.existsSync(manual1Path)).toBe(true);
    expect(fs.existsSync(manual2Path)).toBe(true);
  });

  it('defensively refuses to prune when retention_count in database is 0', async () => {
    // Seed 0 retention count in database directly
    dbService.run(
      "UPDATE backup_policy SET enabled = 1, frequency = 'hourly', retention_count = 0 WHERE id = 1",
    );

    const b1 = await backupsService.createBackup({ trigger: 'scheduled' });
    dbService.run(
      "UPDATE backups SET created_at = '2026-06-01T08:00:00.000Z' WHERE id = ?",
      [b1.id],
    );

    const result = await schedulerService.checkAndRunScheduledBackup();

    expect(result.status).toBe('executed');
    expect(result.prunedCount).toBe(0);

    // Neither backup was deleted
    expect(await backupsService.findById(b1.id)).not.toBeNull();
    expect(await backupsService.findById(result.backupId!)).not.toBeNull();
  });

  it('never runs destructive retention if backup creation fails', async () => {
    setPolicy({ enabled: true, frequency: 'hourly', retentionCount: 1 });

    const b1 = await backupsService.createBackup({ trigger: 'scheduled' });
    dbService.run(
      "UPDATE backups SET created_at = '2026-06-01T08:00:00.000Z' WHERE id = ?",
      [b1.id],
    );

    const enforceRetentionSpy = vi.spyOn(backupsService, 'enforceRetention');

    // Simulate backup creation failure
    vi.spyOn(backupsService, 'createBackup').mockRejectedValueOnce(
      new Error('Disk write failed'),
    );

    const result = await schedulerService.checkAndRunScheduledBackup();

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Disk write failed');

    // Retention must NEVER have been called!
    expect(enforceRetentionSpy).not.toHaveBeenCalled();

    // Existing backup remains untouched
    expect(await backupsService.findById(b1.id)).not.toBeNull();
  });

  it('handles failures without disabling the feature and retries on the next cycle', async () => {
    setPolicy({ enabled: true, frequency: 'daily' });

    // Cycle 1: simulated temporary error
    const createBackupSpy = vi.spyOn(backupsService, 'createBackup');
    createBackupSpy.mockRejectedValueOnce(
      new Error('Simulated network/IO error'),
    );

    const failRun = await schedulerService.checkAndRunScheduledBackup();
    expect(failRun.status).toBe('failed');

    const statusAfterFail = schedulerService.getStatus();
    expect(statusAfterFail.consecutiveFailures).toBe(1);
    expect(statusAfterFail.lastRunStatus).toBe('failure');
    expect(statusAfterFail.lastRunError).toBe('Simulated network/IO error');

    // Cycle 2: error condition is gone; scheduler retries automatically
    const successRun = await schedulerService.checkAndRunScheduledBackup();
    expect(successRun.status).toBe('executed');

    const statusAfterSuccess = schedulerService.getStatus();
    expect(statusAfterSuccess.consecutiveFailures).toBe(0);
    expect(statusAfterSuccess.lastRunStatus).toBe('success');
    expect(statusAfterSuccess.lastRunError).toBeNull();
    expect(statusAfterSuccess.lastSuccessfulRunAt).toBeDefined();
  });

  it('prevents concurrent or overlapping backup runs', async () => {
    setPolicy({ enabled: true, frequency: 'daily' });

    let resolveBackup!: () => void;
    const slowBackupPromise = new Promise<any>((resolve) => {
      resolveBackup = () => resolve({ id: 'mock-slow-backup' });
    });

    vi.spyOn(backupsService, 'createBackup').mockImplementationOnce(
      () => slowBackupPromise,
    );

    // Start first run (in flight)
    const run1Promise = schedulerService.checkAndRunScheduledBackup();

    // Trigger second run concurrently while run 1 is active
    const run2 = await schedulerService.checkAndRunScheduledBackup();

    expect(run2.status).toBe('skipped');
    expect(run2.reason).toBe('already_running');

    // Let run 1 finish
    resolveBackup();
    const run1 = await run1Promise;
    expect(run1.status).toBe('executed');
  });

  it('picks up policy changes on the next cycle without requiring a restart', async () => {
    // Start with disabled
    setPolicy({ enabled: false, frequency: 'daily' });
    const cycle1 = await schedulerService.checkAndRunScheduledBackup();
    expect(cycle1.status).toBe('skipped');
    expect(cycle1.reason).toBe('disabled');

    // User enables backups in database
    setPolicy({ enabled: true, frequency: 'daily' });
    const cycle2 = await schedulerService.checkAndRunScheduledBackup();
    expect(cycle2.status).toBe('executed');

    const b2Id = cycle2.backupId!;
    const b2Row = dbService.get<{ created_at: string }>(
      'SELECT created_at FROM backups WHERE id = ?',
      [b2Id],
    )!;
    const b2Time = new Date(b2Row.created_at);

    // Advance 2 hours from last backup. On daily schedule, not due.
    mockCurrentTime = new Date(b2Time.getTime() + 2 * 60 * 60 * 1000);
    const cycle3 = await schedulerService.checkAndRunScheduledBackup();
    expect(cycle3.status).toBe('skipped');
    expect(cycle3.reason).toBe('not_due');

    // User changes frequency to 'hourly' in database without restart.
    // 2 hours have elapsed, which is >= 1 hour, so now it is due!
    setPolicy({ enabled: true, frequency: 'hourly' });
    const cycle4 = await schedulerService.checkAndRunScheduledBackup();
    expect(cycle4.status).toBe('executed');
  });

  it('reports critical error log when disk space is insufficient (HTTP 507)', async () => {
    setPolicy({ enabled: true, frequency: 'daily' });

    vi.spyOn(backupsService, 'createBackup').mockRejectedValueOnce(
      new HttpException(
        'Insufficient disk space. Available: 0 bytes',
        HttpStatus.INSUFFICIENT_STORAGE,
      ),
    );

    const result = await schedulerService.checkAndRunScheduledBackup();
    expect(result.status).toBe('failed');
    expect(schedulerService.getStatus().lastRunError).toContain(
      'Insufficient disk space',
    );
  });

  it('manages timer lifecycle cleanly with start, stop, and waits for in-flight backup', async () => {
    vi.useFakeTimers();

    const timerScheduler = new BackupSchedulerService(
      dbService,
      backupsService,
      undefined,
      {
        autoStart: true,
        startupDelayMs: 50,
        checkIntervalMs: 200,
      },
    );

    const checkSpy = vi
      .spyOn(timerScheduler, 'checkAndRunScheduledBackup')
      .mockResolvedValue({ status: 'skipped', reason: 'mock_test' });

    // Arms timers on bootstrap
    timerScheduler.onApplicationBootstrap();
    expect(timerScheduler.getStatus().isStarted).toBe(true);

    // Advance time past startup delay (50ms)
    await vi.advanceTimersByTimeAsync(60);
    expect(checkSpy).toHaveBeenCalledTimes(1);

    // Advance past check interval (200ms)
    await vi.advanceTimersByTimeAsync(200);
    expect(checkSpy).toHaveBeenCalledTimes(2);

    // Shutdown cleanly
    await timerScheduler.onApplicationShutdown();
    expect(timerScheduler.getStatus().isStarted).toBe(false);

    // Advance again; no further invocations should occur
    await vi.advanceTimersByTimeAsync(500);
    expect(checkSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
