import { describe, expect, it } from 'vitest';
import { generateBackupDownloadFilename } from './backup-download.js';

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
});
