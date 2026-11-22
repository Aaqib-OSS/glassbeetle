import { describe, expect, it } from 'vitest';
import {
  formatContentDisposition,
  generateBackupDownloadFilename,
  parseRangeHeader,
} from './backup-download.js';

describe('backup-download helpers', () => {
  describe('generateBackupDownloadFilename', () => {
    it('generates filename with colons replaced by hyphens derived from metadata', () => {
      const filename = generateBackupDownloadFilename(
        '2026-11-22T20:59:27.000Z',
      );
      expect(filename).toBe(
        'glassbeetle-backup-2026-11-22T20-59-27.000Z.tar.gz',
      );
    });

    it('trims whitespace around timestamp input', () => {
      const filename = generateBackupDownloadFilename('  2026-01-01T00:00:00Z ');
      expect(filename).toBe('glassbeetle-backup-2026-01-01T00-00-00Z.tar.gz');
    });
  });

  describe('formatContentDisposition', () => {
    it('returns disposition as-is when filename is omitted or empty', () => {
      expect(formatContentDisposition('attachment')).toBe('attachment');
      expect(formatContentDisposition('attachment', '')).toBe('attachment');
      expect(formatContentDisposition('attachment', '   ')).toBe('attachment');
    });

    it('formats pure ASCII filename without extended UTF-8 parameter', () => {
      expect(
        formatContentDisposition('attachment', 'glassbeetle-backup.tar.gz'),
      ).toBe('attachment; filename="glassbeetle-backup.tar.gz"');
    });

    it('encodes non-ASCII characters with RFC 5987 extended parameter', () => {
      const header = formatContentDisposition('attachment', 'backup-über.tar.gz');
      expect(header).toContain('filename="backup-_ber.tar.gz"');
      expect(header).toContain("filename*=UTF-8''backup-%C3%BCber.tar.gz");
    });
  });

  describe('parseRangeHeader', () => {
    it('returns null when header is missing or empty', () => {
      expect(parseRangeHeader(undefined, 1000)).toBeNull();
      expect(parseRangeHeader('', 1000)).toBeNull();
    });

    it('returns null when unit is not bytes', () => {
      expect(parseRangeHeader('items=0-10', 1000)).toBeNull();
    });

    it('parses explicit range (start-end)', () => {
      expect(parseRangeHeader('bytes=0-499', 1000)).toEqual({
        start: 0,
        end: 499,
      });
      expect(parseRangeHeader('bytes=500-999', 1000)).toEqual({
        start: 500,
        end: 999,
      });
    });

    it('parses prefix range (start-)', () => {
      expect(parseRangeHeader('bytes=500-', 1000)).toEqual({
        start: 500,
        end: 999,
      });
    });

    it('parses suffix range (-suffix)', () => {
      expect(parseRangeHeader('bytes=-300', 1000)).toEqual({
        start: 700,
        end: 999,
      });
    });

    it('returns unsatisfiable for out of bound ranges', () => {
      expect(parseRangeHeader('bytes=1000-2000', 1000)).toBe('unsatisfiable');
      expect(parseRangeHeader('bytes=500-200', 1000)).toBe('unsatisfiable');
      expect(parseRangeHeader('bytes=-0', 1000)).toBe('unsatisfiable');
      expect(parseRangeHeader('bytes=1500-', 1000)).toBe('unsatisfiable');
    });
  });
});

