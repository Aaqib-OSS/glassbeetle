import path from 'node:path';

/**
 * Sanitizes a title or filename for safe inclusion in HTTP headers.
 *
 * Prevents:
 * 1. CRLF injection (`\r`, `\n`) which could inject arbitrary HTTP response headers.
 * 2. Directory traversal sequences (`../`, `..\\`).
 * 3. Header parameter breaking via unescaped quotes (`"`) or backslashes (`\`).
 * 4. Control characters (`\x00-\x1f`, `\x7f`).
 */
export function sanitizeFilename(name: string): string {
  if (!name || typeof name !== 'string') {
    return '';
  }

  // Normalize Windows-style separators to forward slashes before getting basename
  const normalizedSlashes = name.trim().replace(/\\/g, '/');
  const base = path.posix.basename(normalizedSlashes);

  // Remove control characters, null bytes, newlines, carriage returns
  // eslint-disable-next-line no-control-regex
  const stripped = base.replace(/[\x00-\x1f\x7f\r\n]/g, '');

  // Strip quotes and backslashes to prevent header injection or escaping
  const cleaned = stripped.replace(/["\\]/g, '_').trim();

  // If after sanitization the string is empty or solely dots, reject as empty
  if (/^\.*$/.test(cleaned)) {
    return '';
  }

  return cleaned;
}

/**
 * Formats a `Content-Disposition` header according to RFC 6266 and RFC 5987.
 *
 * Includes an ASCII fallback `filename="..."` and an RFC 5987 UTF-8 encoded
 * `filename*=UTF-8''...` parameter when non-ASCII or special characters are present.
 */
export function formatContentDisposition(
  disposition: 'inline' | 'attachment',
  filename?: string,
): string {
  if (!filename) {
    return disposition;
  }

  const sanitized = sanitizeFilename(filename);
  if (!sanitized) {
    return disposition;
  }

  // ASCII fallback: replace any non-printable ASCII characters with underscores
  const asciiFallback = sanitized.replace(/[^\x20-\x7E]/g, '_');

  // Check if RFC 5987 extended parameter is needed (contains non-ASCII or spaces/special chars)
  const isPureAsciiNoSpecial =
    asciiFallback === sanitized && !/[;,\s]/.test(sanitized);

  if (isPureAsciiNoSpecial) {
    return `${disposition}; filename="${asciiFallback}"`;
  }

  const encodedUtf8 = encodeURIComponent(sanitized);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodedUtf8}`;
}
