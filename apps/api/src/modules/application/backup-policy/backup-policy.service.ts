import fs from 'node:fs';
import path from 'node:path';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { toDbBoolean } from '../../../common/persistence/row-mapping.js';
import { nowIso } from '../../../common/persistence/timestamps.js';
import { DatabaseService } from '../../../database/database.service.js';
import {
  BACKUP_FREQUENCIES,
  type BackupPolicyRow,
  mapBackupPolicyToResponse,
  MAX_RETENTION_COUNT,
} from './backup-policy.types.js';
import type {
  BackupPolicyResponseDto,
  UpdateBackupPolicyDto,
} from './dto/index.js';

/**
 * Owns the single `backup_policy` row.
 *
 * Controls automated backup configuration: whether scheduled backups run,
 * their frequency ('hourly', 'daily', 'weekly'), how many archives to retain,
 * and where archives are written on disk.
 *
 * Singleton contract:
 * The `backup_policy` table enforces `CHECK (id = 1)`. The row is seeded
 * during schema bootstrap migration (`data/backups/seed.sql`). Queries are
 * always scoped to `id = 1`, no second row can ever be inserted, and `id`
 * is never exposed through the public API.
 */
@Injectable()
export class BackupPolicyService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Retrieves the current automatic backup policy.
   *
   * @throws InternalServerErrorException if the singleton row is missing.
   */
  async getPolicy(): Promise<BackupPolicyResponseDto> {
    const row = this.readRow();
    return mapBackupPolicyToResponse(row);
  }

  /**
   * Replaces the singleton backup policy (PUT).
   *
   * PUT is a full replacement: all fields are validated and persisted.
   * If a custom `targetDirectory` is supplied, it is validated for:
   * - Absolute path syntax (relative paths rejected)
   * - Absence of null bytes
   * - Physical existence on disk
   * - Directory type (files rejected)
   * - Write permission by the current process
   *
   * If `targetDirectory` is `null`, it is accepted as using the application's
   * default backup directory (`<dataDir>/backups`).
   *
   * @throws BadRequestException on validation failure or unusable targetDirectory.
   * @throws InternalServerErrorException if the singleton row is missing.
   */
  async updatePolicy(
    dto: UpdateBackupPolicyDto,
    now: string = nowIso(),
  ): Promise<BackupPolicyResponseDto> {
    this.validateDto(dto);

    // Verify row exists before updating; throws 500 if missing
    this.readRow();

    const targetDirectory = this.validateAndResolveTargetDirectory(
      dto.targetDirectory,
    );

    const dbEnabled = toDbBoolean(dto.enabled);

    this.db.run(
      `UPDATE backup_policy
       SET enabled = ?,
           frequency = ?,
           retention_count = ?,
           target_directory = ?,
           updated_at = ?
       WHERE id = ?`,
      [dbEnabled, dto.frequency, dto.retentionCount, targetDirectory, now, 1],
    );

    return {
      enabled: dto.enabled,
      frequency: dto.frequency,
      retentionCount: dto.retentionCount,
      targetDirectory,
      updatedAt: now,
    };
  }

  /**
   * Reads the singleton row with id = 1.
   *
   * @throws InternalServerErrorException if the row does not exist.
   */
  private readRow(): BackupPolicyRow {
    const row = this.db.get<BackupPolicyRow>(
      `SELECT id, enabled, frequency, retention_count, target_directory, updated_at
       FROM backup_policy
       WHERE id = ?`,
      [1],
    );

    if (!row) {
      throw new InternalServerErrorException(
        'Backup policy row is missing from the database',
      );
    }

    return row;
  }

  /**
   * Defensive validation of DTO fields in case invoked directly outside the validation pipe.
   */
  private validateDto(dto: UpdateBackupPolicyDto): void {
    if (typeof dto.enabled !== 'boolean') {
      throw new BadRequestException('enabled must be a boolean');
    }

    if (!BACKUP_FREQUENCIES.includes(dto.frequency)) {
      throw new BadRequestException(
        `frequency must be one of: ${BACKUP_FREQUENCIES.join(', ')}`,
      );
    }

    if (
      typeof dto.retentionCount !== 'number' ||
      !Number.isInteger(dto.retentionCount) ||
      dto.retentionCount < 1
    ) {
      throw new BadRequestException(
        'retentionCount must be a positive integer >= 1',
      );
    }

    if (dto.retentionCount > MAX_RETENTION_COUNT) {
      throw new BadRequestException(
        `retentionCount must not exceed ${MAX_RETENTION_COUNT}`,
      );
    }
  }

  /**
   * Validates that `targetDirectory`, if provided:
   * 1. Is not empty or whitespace.
   * 2. Contains no null bytes.
   * 3. Is an absolute path.
   * 4. Exists on disk.
   * 5. Is a directory (not a regular file).
   * 6. Is writable by the current process.
   *
   * If `targetDirectory` is null, returns null (indicating default application backup location).
   */
  public validateAndResolveTargetDirectory(
    targetDirectory: string | null,
  ): string | null {
    if (targetDirectory === null) {
      return null;
    }

    if (
      typeof targetDirectory !== 'string' ||
      targetDirectory.trim().length === 0
    ) {
      throw new BadRequestException(
        'Target directory must be an absolute path or null',
      );
    }

    if (targetDirectory.includes('\0')) {
      throw new BadRequestException(
        'Target directory path contains illegal null bytes',
      );
    }

    if (!path.isAbsolute(targetDirectory)) {
      throw new BadRequestException(
        `Target directory must be an absolute path: "${targetDirectory}"`,
      );
    }

    const resolved = path.resolve(targetDirectory);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new BadRequestException(
        `Target directory does not exist: "${resolved}"`,
      );
    }

    if (!stat.isDirectory()) {
      throw new BadRequestException(
        `Target path is not a directory: "${resolved}"`,
      );
    }

    try {
      fs.accessSync(resolved, fs.constants.W_OK);
    } catch {
      throw new BadRequestException(
        `Target directory is not writable: "${resolved}"`,
      );
    }

    return resolved;
  }
}
