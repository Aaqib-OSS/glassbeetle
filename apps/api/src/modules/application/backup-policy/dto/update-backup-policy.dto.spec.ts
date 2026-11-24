import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { MAX_RETENTION_COUNT } from '../backup-policy.types.js';
import { UpdateBackupPolicyDto } from './update-backup-policy.dto.js';

const VALIDATION_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function validateDto(payload: Record<string, unknown>) {
  return validate(
    plainToInstance(UpdateBackupPolicyDto, payload),
    VALIDATION_OPTIONS,
  );
}

describe('UpdateBackupPolicyDto', () => {
  const validPayload = {
    enabled: true,
    frequency: 'daily',
    retentionCount: 7,
    targetDirectory: '/var/backups',
  };

  it('accepts a valid full-replacement payload', async () => {
    const errors = await validateDto(validPayload);
    expect(errors).toHaveLength(0);
  });

  it('accepts null targetDirectory', async () => {
    const errors = await validateDto({
      ...validPayload,
      targetDirectory: null,
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts each valid frequency', async () => {
    for (const freq of ['hourly', 'daily', 'weekly']) {
      const errors = await validateDto({
        ...validPayload,
        frequency: freq,
      });
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an empty payload because PUT is a full replacement', async () => {
    const errors = await validateDto({});
    expect(errors.length).toBeGreaterThanOrEqual(4);
    const properties = errors.map((e) => e.property);
    expect(properties).toContain('enabled');
    expect(properties).toContain('frequency');
    expect(properties).toContain('retentionCount');
    expect(properties).toContain('targetDirectory');
  });

  it('rejects unknown fields like id', async () => {
    const errors = await validateDto({
      ...validPayload,
      id: 1,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('id');
  });

  describe('enabled', () => {
    it('rejects non-boolean values', async () => {
      const errors = await validateDto({
        ...validPayload,
        enabled: 'true',
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('enabled');
    });
  });

  describe('frequency', () => {
    it('rejects unsupported frequency values', async () => {
      const errors = await validateDto({
        ...validPayload,
        frequency: 'monthly',
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('frequency');
    });
  });

  describe('retentionCount', () => {
    it('rejects zero', async () => {
      const errors = await validateDto({
        ...validPayload,
        retentionCount: 0,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('retentionCount');
    });

    it('rejects negative numbers', async () => {
      const errors = await validateDto({
        ...validPayload,
        retentionCount: -1,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('retentionCount');
    });

    it('rejects floating-point numbers', async () => {
      const errors = await validateDto({
        ...validPayload,
        retentionCount: 3.5,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('retentionCount');
    });

    it('rejects retention counts above MAX_RETENTION_COUNT', async () => {
      const errors = await validateDto({
        ...validPayload,
        retentionCount: MAX_RETENTION_COUNT + 1,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('retentionCount');
    });
  });

  describe('targetDirectory', () => {
    it('rejects non-string non-null values', async () => {
      const errors = await validateDto({
        ...validPayload,
        targetDirectory: 12345,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('targetDirectory');
    });
  });
});

