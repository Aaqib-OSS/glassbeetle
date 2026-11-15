import type { BackupTrigger } from './dto/backup-response.dto.js';

/**
 * An individual entry in the backup archive's file inventory.
 */
export interface BackupFileInventoryItem {
  /** Relative path within the archive, e.g. "files/pictures/018f3a9e-....jpg" */
  readonly path: string;
  /** Uncompressed size of the file in bytes */
  readonly sizeBytes: number;
  /** Hex-encoded SHA-256 digest of the file contents */
  readonly sha256: string;
}

/**
 * Schema for `manifest.json` embedded at the root of every backup archive.
 *
 * Provides compatibility and integrity information for the restore process.
 */
export interface BackupManifest {
  /** Format version of the backup archive structure (currently 1) */
  readonly formatVersion: number;
  /** Creation timestamp in ISO-8601 UTC format */
  readonly createdAt: string;
  /** Application version that produced this archive */
  readonly appVersion: string;
  /** Latest applied SQLite schema migration or version string */
  readonly databaseSchemaVersion: string;
  /** Optional user-supplied short label */
  readonly label?: string | null;
  /** Optional user-supplied descriptive note */
  readonly note?: string | null;
  /** Inventory of files included in the files/ directory */
  readonly fileInventory: readonly BackupFileInventoryItem[];
}

/**
 * Row layout in the SQLite `backups` table.
 */
export interface BackupRecordRow {
  readonly id: string;
  readonly file_path: string;
  readonly size_bytes: number;
  readonly trigger: BackupTrigger;
  readonly created_at: string;
}

/**
 * Options accepted by {@link BackupsService.createBackup}.
 */
export interface CreateBackupOptions {
  /** Whether the backup was triggered manually or by the background scheduler */
  readonly trigger?: BackupTrigger;
  /** Optional context label */
  readonly label?: string;
  /** Optional context note */
  readonly note?: string;
}

