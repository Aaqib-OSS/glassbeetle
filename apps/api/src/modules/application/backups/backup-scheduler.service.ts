import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { fromDbBoolean } from '../../../common/persistence/row-mapping.js';
import { nowIso } from '../../../common/persistence/timestamps.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DatabaseService } from '../../../database/database.service.js';
import type { BackupPolicyRow } from '../backup-policy/backup-policy.types.js';
import { BackupsService } from './backups.service.js';

/**
 * Millisecond durations corresponding to configured backup policy frequencies.
 */
export const FREQUENCY_DURATIONS_MS: Record<string, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Default periodic interval between scheduler evaluation loops (1 minute).
 */
export const DEFAULT_CHECK_INTERVAL_MS = 60_000;

/**
 * Default delay after application startup before the first evaluation loop (30 seconds).
 *
 * Prevents large backups from executing immediately upon desktop launch when a user
 * reopens the app after an absence, ensuring the application UI remains responsive.
 */
export const DEFAULT_STARTUP_DELAY_MS = 30_000;

/**
 * Result structure returned by `checkAndRunScheduledBackup`.
 */
export interface ScheduledBackupResult {
  readonly status: 'executed' | 'skipped' | 'failed';
  readonly reason?: string;
  readonly backupId?: string;
  readonly prunedCount?: number;
  readonly error?: string;
  readonly elapsedMs?: number;
  readonly dueInMs?: number;
}

/**
 * In-memory status of scheduled backup execution and failure history.
 */
export interface BackupSchedulerStatus {
  readonly isRunning: boolean;
  readonly isStarted: boolean;
  readonly lastRunAttemptAt: string | null;
  readonly lastSuccessfulRunAt: string | null;
  readonly lastRunStatus: 'success' | 'failure' | null;
  readonly lastRunError: string | null;
  readonly consecutiveFailures: number;
}

/**
 * Options to configure scheduler intervals and behavior, particularly for testing.
 */
export interface BackupSchedulerOptions {
  readonly checkIntervalMs?: number;
  readonly startupDelayMs?: number;
  readonly autoStart?: boolean;
  readonly clock?: () => Date;
}

/**
 * Background scheduler managing automatic backups and retention enforcement.
 *
 * ## Architecture & Engine Choice: Plain Interval vs. @nestjs/schedule
 * The decision to use a lightweight periodic interval loop over `@nestjs/schedule` is driven
 * directly by the application's runtime environment as a desktop application:
 * 1. **Desktop vs. 24/7 Server Lifecycle**: Desktop apps are launched and closed at arbitrary
 *    times. Wall-clock cron expressions (e.g. `@Cron('0 0 * * *')`) assume a server running
 *    continuously through midnight. If a user only opens the app between 9:00 AM and 5:00 PM,
 *    a midnight cron will never trigger. Instead, this scheduler queries the timestamp of the
 *    last successful scheduled backup and asks: *"Has the configured frequency elapsed since
 *    the last scheduled backup?"*. If so, a backup is triggered.
 * 2. **Startup Overdue Catch-up**: When the app opens after a long absence, it runs exactly
 *    one overdue backup after an initial settling delay, rather than triggering multiple runs
 *    for each missed interval.
 * 3. **Zero Extra Dependencies**: Avoids pulling in external scheduling packages while NestJS
 *    lifecycle hooks (`OnApplicationBootstrap`, `OnApplicationShutdown`) cleanly orchestrate
 *    startup delay and graceful shutdown.
 * 4. **Dynamic Policy Updates**: On every evaluation cycle, the service queries the singleton
 *    `backup_policy` row from SQLite. Policy changes (enabling/disabling, changing frequency
 *    or retention) take effect immediately on the next tick without requiring an app restart.
 *
 * ## Retention Policy & Manual Backup Safeguard
 * Retention pruning is destructive and strictly adheres to the following principles:
 * - **Scheduled Backups Only**: Pruning evaluates only rows where `trigger = 'scheduled'`.
 *   User-created manual backups (`trigger = 'manual'`) are **NEVER** deleted by retention.
 *   Users take manual backups intentionally before risky actions; automated pruning must
 *   never delete deliberate user snapshots.
 * - **No Retention on Failed Backup**: If a scheduled backup creation fails, retention is
 *   aborted immediately. Pruning never executes in a way that reduces existing protection.
 * - **Non-Positive Guard**: If `retention_count <= 0` in the database, retention enforcement
 *   aborts safely without deleting any backups.
 *
 * ## Failure Visibility & Schema Limitation
 * A scheduled backup that fails repeatedly is worse than no backup, as the user believes their
 * data is protected. This service tracks failure history and logs escalating `CRITICAL` alerts
 * when consecutive failures occur (especially due to insufficient storage / HTTP 507).
 *
 * *Schema Limitation Note*: The current SQLite `backup_policy` table lacks columns for persisting
 * `last_attempt_at`, `last_error`, and `consecutive_failures`. These are tracked in-memory by
 * `BackupSchedulerStatus`. A follow-up migration can persist these columns so that desktop UI
 * health badges persist across app restarts.
 */
@Injectable()
export class BackupSchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(BackupSchedulerService.name);

  private startupTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isStarted = false;
  private isShuttingDown = false;
  private isRunning = false;
  private activeBackupPromise: Promise<ScheduledBackupResult> | null = null;

  // Status tracking
  private lastRunAttemptAt: string | null = null;
  private lastSuccessfulRunAt: string | null = null;
  private lastRunStatus: 'success' | 'failure' | null = null;
  private lastRunError: string | null = null;
  private consecutiveFailures = 0;

  private readonly checkIntervalMs: number;
  private readonly startupDelayMs: number;
  private readonly clock: () => Date;
  private readonly autoStart: boolean;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly backupsService: BackupsService,
    @Optional() private readonly appConfigService?: AppConfigService,
    @Optional() options?: BackupSchedulerOptions,
  ) {
    this.checkIntervalMs =
      options?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.startupDelayMs = options?.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
    this.clock = options?.clock ?? (() => new Date());

    // By default, do not automatically arm background timers in test environment
    // unless explicitly instructed via options.autoStart
    const isTest = this.appConfigService?.nodeEnv === 'test';
    this.autoStart = options?.autoStart ?? !isTest;
  }

  /**
   * Initializes background timers once all NestJS modules have bootstrapped.
   */
  onApplicationBootstrap(): void {
    if (this.autoStart) {
      this.start();
    }
  }

  /**
   * Cleans up timers and allows any in-flight backup to complete during application shutdown.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * Starts the background evaluation cycle: arms the startup delay timer, followed by
   * the recurring interval timer.
   */
  start(): void {
    if (this.isStarted || this.isShuttingDown) {
      return;
    }

    this.isStarted = true;
    this.logger.log(
      `Backup scheduler started (startupDelay=${this.startupDelayMs}ms, checkInterval=${this.checkIntervalMs}ms)`,
    );

    this.startupTimer = setTimeout(async () => {
      this.startupTimer = null;
      if (this.isShuttingDown) {
        return;
      }

      await this.safeCheckAndRun();

      if (!this.isShuttingDown) {
        this.intervalTimer = setInterval(async () => {
          await this.safeCheckAndRun();
        }, this.checkIntervalMs);
        this.intervalTimer.unref?.();
      }
    }, this.startupDelayMs);

    this.startupTimer.unref?.();
  }

  /**
   * Stops the scheduler and waits for any active backup in flight to finish gracefully.
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;
    this.isStarted = false;

    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    if (this.activeBackupPromise) {
      this.logger.log(
        'Waiting for active scheduled backup to finish before shutdown...',
      );
      try {
        await this.activeBackupPromise;
      } catch {}
      this.activeBackupPromise = null;
    }

    this.logger.log('Backup scheduler stopped cleanly.');
  }

  /**
   * Evaluates the current backup policy and runs a scheduled backup if due.
   *
   * Callable on demand by the periodic timer or directly in test harnesses.
   *
   * @param overrideNow - Optional Date override for deterministic testing without timers.
   * @returns Outcome of the evaluation loop.
   */
  async checkAndRunScheduledBackup(
    overrideNow?: Date,
  ): Promise<ScheduledBackupResult> {
    if (this.isShuttingDown) {
      return { status: 'skipped', reason: 'shutting_down' };
    }

    if (this.isRunning) {
      this.logger.debug?.(
        'Scheduled backup skipped: a backup check or run is already in progress',
      );
      return { status: 'skipped', reason: 'already_running' };
    }

    // 1. Read singleton backup policy directly from SQLite
    let policy: BackupPolicyRow | undefined;
    try {
      policy = this.databaseService.get<BackupPolicyRow>(
        `SELECT id, enabled, frequency, retention_count, target_directory, updated_at
         FROM backup_policy
         WHERE id = 1`,
      );
    } catch (dbError) {
      this.logger.error(
        `Failed to read backup_policy from database: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
      );
      return { status: 'skipped', reason: 'database_error' };
    }

    if (!policy) {
      this.logger.warn(
        'No backup_policy row found in database (id=1). Scheduled backups disabled.',
      );
      return { status: 'skipped', reason: 'missing_policy' };
    }

    if (!fromDbBoolean(policy.enabled)) {
      return { status: 'skipped', reason: 'disabled' };
    }

    const frequencyMs = FREQUENCY_DURATIONS_MS[policy.frequency];
    if (!frequencyMs) {
      this.logger.error(
        `Unknown backup frequency configured in policy: "${policy.frequency}"`,
      );
      return { status: 'skipped', reason: 'invalid_frequency' };
    }

    // 2. Query newest scheduled backup to determine elapsed time
    const lastBackupRow = this.databaseService.get<{ created_at: string }>(
      `SELECT created_at FROM backups WHERE trigger = 'scheduled' ORDER BY created_at DESC, id DESC LIMIT 1`,
    );

    const currentTimeMs = (overrideNow ?? this.clock()).getTime();
    let isDue = false;
    let elapsedMs: number | undefined;

    if (!lastBackupRow) {
      // No prior scheduled backup ever ran; backup is due immediately
      isDue = true;
    } else {
      const lastBackupTimeMs = Date.parse(lastBackupRow.created_at);
      if (Number.isNaN(lastBackupTimeMs)) {
        this.logger.warn(
          `Invalid timestamp in newest scheduled backup record: "${lastBackupRow.created_at}". Treating backup as overdue.`,
        );
        isDue = true;
      } else {
        elapsedMs = currentTimeMs - lastBackupTimeMs;
        if (elapsedMs >= frequencyMs) {
          isDue = true;
        }
      }
    }

    if (!isDue) {
      const dueInMs = frequencyMs - (elapsedMs ?? 0);
      return {
        status: 'skipped',
        reason: 'not_due',
        elapsedMs,
        dueInMs: Math.max(0, dueInMs),
      };
    }

    // 3. Execute scheduled backup
    this.isRunning = true;
    const backupExecutionPromise = this.executeBackupAndRetention(policy);
    this.activeBackupPromise = backupExecutionPromise;

    try {
      return await backupExecutionPromise;
    } finally {
      this.isRunning = false;
      this.activeBackupPromise = null;
    }
  }

  /**
   * Returns the current in-memory status and failure history of the scheduler.
   */
  getStatus(): BackupSchedulerStatus {
    return {
      isRunning: this.isRunning,
      isStarted: this.isStarted,
      lastRunAttemptAt: this.lastRunAttemptAt,
      lastSuccessfulRunAt: this.lastSuccessfulRunAt,
      lastRunStatus: this.lastRunStatus,
      lastRunError: this.lastRunError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * Safe wrapper around `checkAndRunScheduledBackup` that swallows exceptions to prevent
   * unhandled promise rejections on background timer ticks.
   */
  private async safeCheckAndRun(): Promise<void> {
    try {
      await this.checkAndRunScheduledBackup();
    } catch (unexpectedError) {
      this.logger.error(
        `Unexpected error during scheduled backup cycle: ${unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError)}`,
      );
    }
  }

  /**
   * Executes backup creation, followed by retention pruning if successful, and records state.
   */
  private async executeBackupAndRetention(
    policy: BackupPolicyRow,
  ): Promise<ScheduledBackupResult> {
    const attemptTime = nowIso();
    this.lastRunAttemptAt = attemptTime;

    this.logger.log(
      `Starting scheduled backup (frequency=${policy.frequency}, retentionCount=${policy.retention_count})...`,
    );

    try {
      // 1. Create scheduled backup
      const backup = await this.backupsService.createBackup({
        trigger: 'scheduled',
      });

      // 2. Enforce retention ONLY after successful creation
      let prunedCount = 0;
      try {
        const pruned = await this.backupsService.enforceRetention(
          policy.retention_count,
        );
        prunedCount = pruned.length;
      } catch (retentionError) {
        this.logger.error(
          `Retention enforcement encountered an error after scheduled backup: ${retentionError instanceof Error ? retentionError.message : String(retentionError)}`,
        );
      }

      // 3. Record success and reset consecutive failures
      this.lastSuccessfulRunAt = attemptTime;
      this.lastRunStatus = 'success';
      this.lastRunError = null;
      this.consecutiveFailures = 0;

      this.logger.log(
        `Scheduled backup completed successfully: id=${backup.id}, retentionPruned=${prunedCount}`,
      );

      return {
        status: 'executed',
        backupId: backup.id,
        prunedCount,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.lastRunStatus = 'failure';
      this.lastRunError = errorMessage;
      this.consecutiveFailures++;

      // Surface specific high-impact error conditions
      if (
        error instanceof HttpException &&
        error.getStatus() === HttpStatus.INSUFFICIENT_STORAGE
      ) {
        this.logger.error(
          `CRITICAL: Scheduled backup failed due to insufficient disk space: ${errorMessage}. Automated backups will retry on the next cycle once disk space is freed.`,
        );
      } else if (this.consecutiveFailures > 1) {
        this.logger.error(
          `CRITICAL: Scheduled backup has failed repeatedly (${this.consecutiveFailures} consecutive failures). Last error: "${errorMessage}". User data protection is degraded!`,
        );
      } else {
        this.logger.error(`Scheduled backup failed: ${errorMessage}`);
      }

      return {
        status: 'failed',
        error: errorMessage,
      };
    }
  }
}
