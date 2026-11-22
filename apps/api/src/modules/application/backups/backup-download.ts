import path from 'node:path';

/**
 * Byte range representation for partial content streaming.
 */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

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

/**
 * Formats a `Content-Disposition` header according to RFC 6266 and RFC 5987.
 */
export function formatContentDisposition(
  disposition: 'attachment' | 'inline',
  filename?: string,
): string {
  if (!filename) {
    return disposition;
  }

  // Remove control characters, quotes, and backslashes
  const basename = path.posix.basename(filename.trim().replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const stripped = basename.replace(/[\x00-\x1f\x7f\r\n]/g, '');
  const sanitized = stripped.replace(/["\\]/g, '_').trim();

  if (!sanitized || /^\.*$/.test(sanitized)) {
    return disposition;
  }

  const asciiFallback = sanitized.replace(/[^\x20-\x7E]/g, '_');
  const isPureAsciiNoSpecial =
    asciiFallback === sanitized && !/[;,\s]/.test(sanitized);

  if (isPureAsciiNoSpecial) {
    return `${disposition}; filename="${asciiFallback}"`;
  }

  const encodedUtf8 = encodeURIComponent(sanitized);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodedUtf8}`;
}

/**
 * Parses an HTTP `Range` header (RFC 7233) for a single byte range.
 *
 * Supports:
 * - Explicit ranges: `bytes=0-499`
 * - Prefix ranges: `bytes=500-` (from offset 500 to end of file)
 * - Suffix ranges: `bytes=-300` (last 300 bytes of file)
 *
 * Returns:
 * - `{ start, end }` for a satisfiable byte range.
 * - `null` if the header is absent, malformed, or uses a unit other than `bytes`.
 * - `'unsatisfiable'` if the range cannot be satisfied for the given resource size.
 */
export function parseRangeHeader(
  rangeHeader: string | undefined,
  totalSize: number,
): ByteRange | null | 'unsatisfiable' {
  if (!rangeHeader || typeof rangeHeader !== 'string') {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return null;
  }

  const [, startStr, endStr] = match;
  if (!startStr && !endStr) {
    return null;
  }

  let start: number;
  let end: number;

  if (!startStr) {
    // Suffix range: bytes=-N (last N bytes)
    const suffixLength = parseInt(endStr, 10);
    if (suffixLength <= 0 || isNaN(suffixLength)) {
      return 'unsatisfiable';
    }
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else if (!endStr) {
    // Prefix range: bytes=N- (from offset N to end of file)
    start = parseInt(startStr, 10);
    end = totalSize - 1;
  } else {
    // Explicit range: bytes=N-M
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
  }

  if (
    isNaN(start) ||
    isNaN(end) ||
    start < 0 ||
    start > end ||
    start >= totalSize ||
    end >= totalSize
  ) {
    return 'unsatisfiable';
  }

  return { start, end };
}
