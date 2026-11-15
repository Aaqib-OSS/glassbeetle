import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { newId } from '../../../common/persistence/identifiers.js';
import { nowIso } from '../../../common/persistence/timestamps.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { resolveDefaultDataDir } from '../../../config/data-dir.js';
import { DatabaseService } from '../../../database/database.service.js';
import { FileStorageService } from '../../../file-storage/file-storage.service.js';
import {
  type BackupFileInventoryItem,
  type BackupManifest,
  type CreateBackupOptions,
} from './backups.types.js';
import { BackupResponseDto } from './dto/backup-response.dto.js';

/**
 * Current backup archive format specification version.
 */
export const BACKUP_FORMAT_VERSION = 1;

/**
 * Fallback application version string if unresolvable.
 */
export const DEFAULT_APP_VERSION = '0.1.0';

/**
 * Service managing backup creation and archive recording.
 *
 * ## Archive Format
 * A backup archive is a single gzipped tar file (`.tar.gz`) containing:
 * - `manifest.json`: Format version, creation timestamp, app version, database schema
 *   version, optional user label/note, and a file inventory with SHA-256 hashes.
 * - `database.sqlite`: A consistent snapshot of the SQLite database created via
 *   `VACUUM INTO`. Does not use raw file copies so that WAL journal frames are
 *   checkpointed into a clean, standalone database file.
 * - `files/`: Mirror of the file storage directory (agent pictures, project images,
 *   artifact blobs).
 *
 * ## Encryption Key Decision & Threat Model
 * Provider credentials (`provider_credentials`) store API keys encrypted with AES-256-GCM.
 * The 256-bit master key (`master.key`) lives in the user data directory with restrictive
 * permissions (`0600`), separate from the SQLite database (`glassbeetle.db`).
 *
 * **Deliberate Security Decision**: Backup archives intentionally **EXCLUDE** `master.key`.
 * Bundling the master key with the database snapshot inside an archive would eliminate the
 * cryptographic separation between ciphertext and encryption keys whenever users export,
 * share, or sync archives to external storage.
 *
 * Consequently, restoring a backup on a new device will require provider API keys to be
 * re-entered, ensuring sensitive credentials are never leaked via synced backup files.
 *
 * ## Concurrency
 * Backups are serialised: concurrent backups are disallowed. If a backup is already
 * running, subsequent requests immediately fail with `409 Conflict`.
 */
@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);
  private isBackupInProgress = false;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly fileStorageService: FileStorageService,
    @Optional() private readonly appConfigService?: AppConfigService,
  ) {}

  /**
   * Creates a self-contained backup archive and records its metadata.
   *
   * Callable on demand by the HTTP controller (trigger = 'manual') or by the
   * background backup scheduler (trigger = 'scheduled').
   *
   * @param options - Backup parameters including trigger source, optional label and note.
   * @returns Metadata of the newly created backup.
   * @throws ConflictException (409) if a backup is already in progress.
   * @throws BadRequestException (400) if the target directory is invalid or unwritable.
   * @throws HttpException (507) if detectable disk space is insufficient.
   * @throws InternalServerErrorException (500) if creation fails.
   */
  async createBackup(
    options: CreateBackupOptions = {},
  ): Promise<BackupResponseDto> {
    if (this.isBackupInProgress) {
      throw new ConflictException('A backup is already in progress');
    }

    this.isBackupInProgress = true;

    const id = newId();
    const createdAt = nowIso();
    const trigger = options.trigger ?? 'manual';

    let stagingDir: string | undefined;
    let partialArchivePath: string | undefined;
    let finalArchivePath: string | undefined;

    try {
      const targetDir = this.resolveTargetDirectory();
      stagingDir = path.join(os.tmpdir(), `glassbeetle-backup-${id}`);
      partialArchivePath = path.join(targetDir, `backup-${id}.tar.gz.tmp`);
      finalArchivePath = path.join(targetDir, `backup-${id}.tar.gz`);

      this.checkDiskSpace(targetDir);

      // Create staging directories
      await fs.promises.mkdir(stagingDir, { recursive: true });
      const stagingFilesDir = path.join(stagingDir, 'files');
      await fs.promises.mkdir(stagingFilesDir, { recursive: true });

      // 1. Snapshot database consistently with VACUUM INTO
      const dbSnapshotPath = path.join(stagingDir, 'database.sqlite');
      this.databaseService.db.prepare('VACUUM INTO ?').run(dbSnapshotPath);

      // 2. Copy file storage tree into files/ and collect inventory
      const fileInventory: BackupFileInventoryItem[] = [];
      const storageRoot = this.fileStorageService.storageRoot;
      await this.copyStorageTree(
        storageRoot,
        stagingFilesDir,
        'files',
        fileInventory,
      );

      // 3. Write manifest.json
      const manifest: BackupManifest = {
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt,
        appVersion: this.getAppVersion(),
        databaseSchemaVersion: this.getDatabaseSchemaVersion(),
        label: options.label?.trim() || null,
        note: options.note?.trim() || null,
        fileInventory,
      };

      await fs.promises.writeFile(
        path.join(stagingDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8',
      );

      // 4. Stream archive creation
      await tar.create(
        {
          gzip: true,
          file: partialArchivePath,
          cwd: stagingDir,
        },
        ['manifest.json', 'database.sqlite', 'files'],
      );

      // Atomic rename of partial archive to final archive
      await fs.promises.rename(partialArchivePath, finalArchivePath);

      const stats = await fs.promises.stat(finalArchivePath);
      const sizeBytes = stats.size;

      // 5. Record metadata in the database
      this.databaseService.run(
        `INSERT INTO backups (id, file_path, size_bytes, trigger, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, finalArchivePath, sizeBytes, trigger, createdAt],
      );

      this.logger.log(
        `Backup created successfully: id=${id}, sizeBytes=${sizeBytes}, trigger=${trigger}`,
      );

      return {
        id,
        sizeBytes,
        trigger,
        createdAt,
      };
    } catch (error) {
      this.logger.error(
        `Backup creation failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      // Clean up partial archive if left behind
      try {
        if (partialArchivePath && existsSync(partialArchivePath)) {
          await fs.promises.unlink(partialArchivePath);
        }
      } catch {}

      // Clean up final archive if write failed after creation
      try {
        if (finalArchivePath && existsSync(finalArchivePath)) {
          await fs.promises.unlink(finalArchivePath);
        }
      } catch {}

      // Clean up database row if partially recorded
      try {
        this.databaseService.run('DELETE FROM backups WHERE id = ?', [id]);
      } catch {}

      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException(
        `Backup creation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      // Always remove temporary staging directory
      try {
        if (stagingDir && existsSync(stagingDir)) {
          await fs.promises.rm(stagingDir, { recursive: true, force: true });
        }
      } catch (cleanupError) {
        this.logger.warn(
          `Failed to clean up backup staging directory: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }

      this.isBackupInProgress = false;
    }
  }

  /**
   * Resolves and verifies the target directory for writing backups.
   *
   * @returns Absolute path to a writable directory on disk.
   * @throws BadRequestException if the directory is missing, not a directory, or not writable.
   */
  private resolveTargetDirectory(): string {
    let configuredDir: string | null = null;
    try {
      const policy = this.databaseService.get<{
        target_directory: string | null;
      }>('SELECT target_directory FROM backup_policy WHERE id = 1');
      configuredDir = policy?.target_directory ?? null;
    } catch {
      // backup_policy might be unavailable or unmigrated in custom test setups
    }

    if (configuredDir && configuredDir.trim().length > 0) {
      const sanitized = configuredDir.trim();
      if (sanitized.includes('\0')) {
        throw new BadRequestException(
          'Target backup directory path contains illegal null bytes',
        );
      }

      const resolved = path.resolve(sanitized);
      if (!existsSync(resolved)) {
        throw new BadRequestException(
          `Configured backup target directory does not exist: "${resolved}"`,
        );
      }

      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        throw new BadRequestException(
          `Configured backup target path is not a directory: "${resolved}"`,
        );
      }

      try {
        fs.accessSync(resolved, fs.constants.W_OK);
      } catch {
        throw new BadRequestException(
          `Configured backup target directory is not writable: "${resolved}"`,
        );
      }

      return resolved;
    }

    // Default fallback under application data directory
    const dataDir = this.appConfigService?.dataDir ?? resolveDefaultDataDir();
    const defaultDir = path.resolve(dataDir, 'backups');
    mkdirSync(defaultDir, { recursive: true });

    try {
      fs.accessSync(defaultDir, fs.constants.W_OK);
    } catch {
      throw new BadRequestException(
        `Default backup directory is not writable: "${defaultDir}"`,
      );
    }

    return defaultDir;
  }

  /**
   * Probes available storage on the destination filesystem before writing.
   *
   * @throws HttpException (507 Insufficient Storage) if disk space is below required threshold.
   */
  private checkDiskSpace(targetDir: string): void {
    try {
      if (typeof fs.statfsSync !== 'function') {
        return;
      }

      let dbEstimatedBytes = 0;
      try {
        const pageCountRow = this.databaseService.db
          .prepare('PRAGMA page_count')
          .get() as { page_count?: number } | undefined;
        const pageSizeRow = this.databaseService.db
          .prepare('PRAGMA page_size')
          .get() as { page_size?: number } | undefined;
        const pageCount = pageCountRow?.page_count ?? 0;
        const pageSize = pageSizeRow?.page_size ?? 4096;
        dbEstimatedBytes = pageCount * pageSize;
      } catch {
        dbEstimatedBytes = 5 * 1024 * 1024;
      }

      let storageBytes = 0;
      const storageRoot = this.fileStorageService.storageRoot;
      if (existsSync(storageRoot)) {
        storageBytes = this.calculateDirectorySize(storageRoot);
      }

      // Safety estimate: snapshot + storage copy + compressed archive + 5 MB headroom
      const estimatedRequiredBytes =
        (dbEstimatedBytes + storageBytes) * 2 + 5 * 1024 * 1024;

      const stat = fs.statfsSync(targetDir);
      const freeBytes = BigInt(stat.bavail) * BigInt(stat.bsize);

      if (freeBytes < BigInt(estimatedRequiredBytes)) {
        throw new HttpException(
          `Insufficient disk space. Available: ${freeBytes} bytes, estimated required: ${estimatedRequiredBytes} bytes`,
          HttpStatus.INSUFFICIENT_STORAGE,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      // Ignore system statfs probing errors on unsupporting platforms
    }
  }

  /**
   * Recursively computes the total size in bytes of files in a directory.
   */
  private calculateDirectorySize(dir: string): number {
    let totalBytes = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          totalBytes += this.calculateDirectorySize(fullPath);
        } else if (entry.isFile()) {
          totalBytes += fs.statSync(fullPath).size;
        }
      }
    } catch {
      // Best-effort calculation
    }
    return totalBytes;
  }

  /**
   * Recursively copies a storage tree into staging and records inventory items.
   */
  private async copyStorageTree(
    sourceDir: string,
    targetDir: string,
    archivePrefix: string,
    inventory: BackupFileInventoryItem[],
  ): Promise<void> {
    if (!existsSync(sourceDir)) {
      return;
    }

    const entries = await fs.promises.readdir(sourceDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const srcPath = path.join(sourceDir, entry.name);
      const dstPath = path.join(targetDir, entry.name);
      const relArchivePath = `${archivePrefix}/${entry.name}`;

      if (entry.isDirectory()) {
        await fs.promises.mkdir(dstPath, { recursive: true });
        await this.copyStorageTree(srcPath, dstPath, relArchivePath, inventory);
      } else if (entry.isFile()) {
        await fs.promises.copyFile(srcPath, dstPath);
        const stat = await fs.promises.stat(dstPath);
        const content = await fs.promises.readFile(dstPath);
        const sha256 = createHash('sha256').update(content).digest('hex');

        inventory.push({
          path: relArchivePath,
          sizeBytes: stat.size,
          sha256,
        });
      }
    }
  }

  /**
   * Retrieves the current database schema migration version name.
   */
  private getDatabaseSchemaVersion(): string {
    try {
      const row = this.databaseService.get<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY id DESC LIMIT 1',
      );
      if (row?.name) {
        return row.name;
      }
    } catch {}

    try {
      const pragma = this.databaseService.get<{ user_version: number }>(
        'PRAGMA user_version',
      );
      if (pragma?.user_version !== undefined) {
        return String(pragma.user_version);
      }
    } catch {}

    return 'initial_bootstrap';
  }

  /**
   * Returns application version for backup manifest compatibility checking.
   */
  private getAppVersion(): string {
    return DEFAULT_APP_VERSION;
  }
}
