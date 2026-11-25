import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BackupSchedulerService } from '../src/modules/application/backups/backup-scheduler.service.js';
import { createTestApp, type TestApp } from './harness/index.js';

describe('Scheduled backups and retention (e2e)', () => {
  let testApp: TestApp;
  let scheduler: BackupSchedulerService;

  beforeAll(async () => {
    testApp = await createTestApp();
    scheduler = testApp.app.get(BackupSchedulerService);
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(() => {
    testApp.reset();
  });

  function setPolicy(options: {
    enabled: boolean;
    frequency?: 'hourly' | 'daily' | 'weekly';
    retentionCount?: number;
  }): void {
    testApp.db.run(
      `UPDATE backup_policy
       SET enabled = ?, frequency = ?, retention_count = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = 1`,
      [
        options.enabled ? 1 : 0,
        options.frequency ?? 'daily',
        options.retentionCount ?? 7,
      ],
    );
  }

  it('runs a scheduled backup when enabled in policy and surfaces it via GET /api/v1/application/backups', async () => {
    // 1. Seed policy as enabled
    setPolicy({ enabled: true, frequency: 'daily', retentionCount: 7 });

    // 2. Trigger scheduler run
    const result = await scheduler.checkAndRunScheduledBackup();
    expect(result.status).toBe('executed');
    expect(result.backupId).toBeDefined();

    // 3. Verify via HTTP API that backup is recorded as scheduled
    const listRes = await testApp
      .request()
      .get('/api/v1/application/backups')
      .expect(200);

    expect(listRes.body.total).toBe(1);
    expect(listRes.body.items[0]).toMatchObject({
      id: result.backupId,
      trigger: 'scheduled',
      hasArchive: true,
      isAvailable: true,
    });

    // 4. Verify trigger filter works
    const scheduledRes = await testApp
      .request()
      .get('/api/v1/application/backups?trigger=scheduled')
      .expect(200);
    expect(scheduledRes.body.total).toBe(1);

    const manualRes = await testApp
      .request()
      .get('/api/v1/application/backups?trigger=manual')
      .expect(200);
    expect(manualRes.body.total).toBe(0);
  });

  it('enforces retention policy on scheduled backups and preserves manual backups end-to-end', async () => {
    // 1. Create a manual backup via API
    const manualRes = await testApp
      .request()
      .post('/api/v1/application/backups')
      .send({ label: 'Manual Pre-operation Snapshot' })
      .expect(201);
    const manualId = manualRes.body.id;

    // 2. Set policy with retention count of 2
    setPolicy({ enabled: true, frequency: 'hourly', retentionCount: 2 });

    // 3. Create 2 scheduled backups
    const s1Result = await scheduler.checkAndRunScheduledBackup();
    expect(s1Result.status).toBe('executed');
    const s1Id = s1Result.backupId!;

    // Move s1 back in time 3 hours
    testApp.db.run(
      "UPDATE backups SET created_at = '2026-06-01T08:00:00.000Z' WHERE id = ?",
      [s1Id],
    );

    const s2Result = await scheduler.checkAndRunScheduledBackup(
      new Date('2026-06-01T10:00:00.000Z'),
    );
    expect(s2Result.status).toBe('executed');
    const s2Id = s2Result.backupId!;

    testApp.db.run(
      "UPDATE backups SET created_at = '2026-06-01T10:00:00.000Z' WHERE id = ?",
      [s2Id],
    );

    // 4. Create 3rd scheduled backup: this must trigger retention and prune s1 (oldest scheduled)
    const s3Result = await scheduler.checkAndRunScheduledBackup(
      new Date('2026-06-01T12:00:00.000Z'),
    );
    expect(s3Result.status).toBe('executed');
    expect(s3Result.prunedCount).toBe(1);
    const s3Id = s3Result.backupId!;

    // 5. Query backups via API:
    // Should have 3 total: manualId, s2Id, s3Id.
    // s1Id should be gone!
    const listRes = await testApp
      .request()
      .get('/api/v1/application/backups')
      .expect(200);

    expect(listRes.body.total).toBe(3);
    const ids = listRes.body.items.map((b: { id: string }) => b.id);
    expect(ids).toContain(manualId);
    expect(ids).toContain(s2Id);
    expect(ids).toContain(s3Id);
    expect(ids).not.toContain(s1Id);

    // Verify physical archive files on disk
    const backupsDir = path.join(testApp.dataDir, 'backups');
    expect(fs.existsSync(path.join(backupsDir, `backup-${s1Id}.tar.gz`))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(backupsDir, `backup-${s2Id}.tar.gz`))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(backupsDir, `backup-${s3Id}.tar.gz`))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(backupsDir, `backup-${manualId}.tar.gz`)),
    ).toBe(true);
  });
});
