import { describe, expect, it } from 'vitest';
import {
  resolveContentSecurityPolicy,
  SAFE_INLINE_MIME_TYPES,
} from './artifacts-content-policy.js';

describe('Artifact Content Security Policy', () => {
  describe('SAFE_INLINE_MIME_TYPES', () => {
    it('contains safe document and text formats', () => {
      expect(SAFE_INLINE_MIME_TYPES.has('text/plain')).toBe(true);
      expect(SAFE_INLINE_MIME_TYPES.has('text/markdown')).toBe(true);
      expect(SAFE_INLINE_MIME_TYPES.has('application/json')).toBe(true);
      expect(SAFE_INLINE_MIME_TYPES.has('text/csv')).toBe(true);
    });

    it('contains safe raster image formats', () => {
      expect(SAFE_INLINE_MIME_TYPES.has('image/png')).toBe(true);
      expect(SAFE_INLINE_MIME_TYPES.has('image/jpeg')).toBe(true);
      expect(SAFE_INLINE_MIME_TYPES.has('image/webp')).toBe(true);
      expect(SAFE_INLINE_MIME_TYPES.has('image/gif')).toBe(true);
    });

    it('explicitly excludes executable and script-bearing types (XSS prevention)', () => {
      expect(SAFE_INLINE_MIME_TYPES.has('text/html')).toBe(false);
      expect(SAFE_INLINE_MIME_TYPES.has('application/xhtml+xml')).toBe(false);
      expect(SAFE_INLINE_MIME_TYPES.has('image/svg+xml')).toBe(false);
      expect(SAFE_INLINE_MIME_TYPES.has('application/javascript')).toBe(false);
      expect(SAFE_INLINE_MIME_TYPES.has('text/javascript')).toBe(false);
      expect(SAFE_INLINE_MIME_TYPES.has('application/pdf')).toBe(false);
    });
  });

  describe('resolveContentSecurityPolicy', () => {
    it('serves safe markdown inline with charset', () => {
      const res = resolveContentSecurityPolicy({
        mimeType: 'text/markdown',
        isInline: true,
        title: 'Notes.md',
      });
      expect(res.contentType).toBe('text/markdown; charset=utf-8');
      expect(res.disposition).toContain('inline');
    });

    it('serves safe raster images inline without charset', () => {
      const res = resolveContentSecurityPolicy({
        mimeType: 'image/png',
        isInline: false,
        title: 'diagram.png',
      });
      expect(res.contentType).toBe('image/png');
      expect(res.disposition).toContain('inline');
    });

    it('demotes text/html to application/octet-stream and forces attachment (stored XSS defense)', () => {
      const res = resolveContentSecurityPolicy({
        mimeType: 'text/html',
        isInline: true,
        title: 'malicious.html',
      });
      expect(res.contentType).toBe('application/octet-stream');
      expect(res.disposition).toContain('attachment');
    });

    it('demotes image/svg+xml to application/octet-stream and forces attachment (active SVG XSS defense)', () => {
      const res = resolveContentSecurityPolicy({
        mimeType: 'image/svg+xml',
        isInline: false,
        title: 'vector.svg',
      });
      expect(res.contentType).toBe('application/octet-stream');
      expect(res.disposition).toContain('attachment');
    });

    it('falls back safely for null mimeType on inline content (text/plain, inline)', () => {
      const res = resolveContentSecurityPolicy({
        mimeType: null,
        isInline: true,
        title: 'Plain text',
      });
      expect(res.contentType).toBe('text/plain; charset=utf-8');
      expect(res.disposition).toContain('inline');
    });

    it('falls back safely for null mimeType on file content (application/octet-stream, attachment)', () => {
      const res = resolveContentSecurityPolicy({
        mimeType: null,
        isInline: false,
        title: 'blob.bin',
      });
      expect(res.contentType).toBe('application/octet-stream');
      expect(res.disposition).toContain('attachment');
    });
  });
});
