import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  RestoreBackupDto,
  RestoreBackupQueryDto,
} from './restore-backup.dto.js';

const VALIDATION_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

async function validateBodyDto(payload: Record<string, unknown>) {
  const instance = plainToInstance(RestoreBackupDto, payload);
  return validate(instance, VALIDATION_OPTIONS);
}

async function validateQueryDto(payload: Record<string, unknown>) {
  const instance = plainToInstance(RestoreBackupQueryDto, payload);
  return validate(instance, VALIDATION_OPTIONS);
}

describe('RestoreBackupDto', () => {
  it('passes validation when confirm is string "true"', async () => {
    const errors = await validateBodyDto({ confirm: 'true' });
    expect(errors).toHaveLength(0);
  });

  it('passes validation when confirm is boolean true (transformed)', async () => {
    const errors = await validateBodyDto({ confirm: true });
    expect(errors).toHaveLength(0);
  });

  it('allows omitting confirm in body (since confirmation may be supplied via query)', async () => {
    const errors = await validateBodyDto({});
    expect(errors).toHaveLength(0);
  });

  it('fails validation when confirm is "false"', async () => {
    const errors = await validateBodyDto({ confirm: 'false' });
    expect(errors.length).toBeGreaterThan(0);
    const confirmError = errors.find((e) => e.property === 'confirm');
    expect(confirmError).toBeDefined();
    expect(confirmError?.constraints?.equals).toBe(
      'confirm must be "true" to authorize restore',
    );
  });

  it('fails validation when confirm is unexpected string like "yes"', async () => {
    const errors = await validateBodyDto({ confirm: 'yes' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails validation when unexpected fields are present', async () => {
    const errors = await validateBodyDto({ confirm: 'true', unknownField: 'evil' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'unknownField')).toBe(true);
  });
});

describe('RestoreBackupQueryDto', () => {
  it('passes validation when confirm is "true"', async () => {
    const errors = await validateQueryDto({ confirm: 'true' });
    expect(errors).toHaveLength(0);
  });

  it('allows omitting confirm (handled at controller level)', async () => {
    const errors = await validateQueryDto({});
    expect(errors).toHaveLength(0);
  });

  it('fails validation when confirm is "false"', async () => {
    const errors = await validateQueryDto({ confirm: 'false' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails validation when unexpected query parameters are present', async () => {
    const errors = await validateQueryDto({ confirm: 'true', unknown: 'bad' });
    expect(errors.length).toBeGreaterThan(0);
  });
});

