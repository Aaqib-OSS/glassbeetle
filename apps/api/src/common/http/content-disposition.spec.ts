import { describe, expect, it } from 'vitest';
import {
  formatContentDisposition,
  sanitizeFilename,
} from './content-disposition.js';

describe('content-disposition', () => {
  describe('sanitizeFilename', () => {
    it('removes directory traversal sequences', () => {
      expect(sanitizeFilename('../../../secret.txt')).toBe('secret.txt');
      expect(sanitizeFilename('..\\..\\passwords.csv')).toBe('passwords.csv');
      expect(sanitizeFilename('/etc/hosts')).toBe('hosts');
    });

    it('removes CRLF and control characters to prevent HTTP response splitting', () => {
      expect(sanitizeFilename('report\r\nSet-Cookie: evil=1.txt')).toBe(
        'reportSet-Cookie: evil=1.txt',
      );
      expect(sanitizeFilename('file\x00name.png')).toBe('filename.png');
    });

    it('escapes quotes and backslashes', () => {
      expect(sanitizeFilename('malicious"; filename="hacked.txt')).toBe(
        'malicious_; filename=_hacked.txt',
      );
    });

    it('returns empty string for inputs that resolve to root or dots', () => {
      expect(sanitizeFilename('')).toBe('');
      expect(sanitizeFilename('...')).toBe('');
      expect(sanitizeFilename('..')).toBe('');
      expect(sanitizeFilename('.')).toBe('');
    });

    it('preserves unicode characters', () => {
      expect(sanitizeFilename("rapport_d'été_🚀.md")).toBe(
        "rapport_d'été_🚀.md",
      );
    });
  });

  describe('formatContentDisposition', () => {
    it('returns disposition bare when no filename is given', () => {
      expect(formatContentDisposition('inline')).toBe('inline');
      expect(formatContentDisposition('attachment')).toBe('attachment');
    });

    it('returns disposition bare when the filename is empty or whitespace', () => {
      expect(formatContentDisposition('attachment', '')).toBe('attachment');
      expect(formatContentDisposition('attachment', '   ')).toBe('attachment');
    });

    it('formats pure ASCII filenames without spaces directly', () => {
      expect(formatContentDisposition('inline', 'report.md')).toBe(
        'inline; filename="report.md"',
      );
      expect(formatContentDisposition('attachment', 'archive.zip')).toBe(
        'attachment; filename="archive.zip"',
      );
    });

    it('formats unicode and space-containing filenames with RFC 5987 encoding', () => {
      const formatted = formatContentDisposition('inline', 'my report.md');
      expect(formatted).toContain('filename="my report.md"');
      expect(formatted).toContain("filename*=UTF-8''my%20report.md");

      const unicode = formatContentDisposition('attachment', 'über_file.bin');
      expect(unicode).toContain('filename="_ber_file.bin"');
      expect(unicode).toContain("filename*=UTF-8''%C3%BCber_file.bin");
    });
  });
});
