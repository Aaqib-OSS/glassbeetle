/**
 * Generates a safe, human-readable download filename derived strictly from backup metadata.
 *
 * Pattern: `glassbeetle-backup-<created_at>.tar.gz`
 * Never derives from database `file_path`. Replaces colons with hyphens for cross-platform
 * filesystem compatibility (e.g. Windows/NTFS).
 */
export function generateBackupDownloadFilename(createdAt: string): string {
  const safeTimestamp = createdAt.trim().replace(/:/g, '-');
  return `glassbeetle-backup-${safeTimestamp}.tar.gz`;
}
