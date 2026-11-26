import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  ResetApplicationDto,
  ResetApplicationQueryDto,
} from './reset-application.dto.js';

const VALIDATION_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

async function validateBodyDto(payload: Record<string, unknown>) {
  const instance = plainToInstance(ResetApplicationDto, payload);
  return validate(instance, VALIDATION_OPTIONS);
}

async function validateQueryDto(payload: Record<string, unknown>) {
  const instance = plainToInstance(ResetApplicationQueryDto, payload);
  return validate(instance, VALIDATION_OPTIONS);
}

describe('ResetApplicationDto', () => {
  it('passes validation when confirm is string "true"', async () => {
    const errors = await validateBodyDto({ confirm: 'true' });
    expect(errors).toHaveLength(0);
  });

  it('passes validation when confirm is string "RESET"', async () => {
    const errors = await validateBodyDto({ confirm: 'RESET' });
    expect(errors).toHaveLength(0);
  });

  it('passes validation when confirm is boolean true (transformed to "true")', async () => {
    const errors = await validateBodyDto({ confirm: true });
    expect(errors).toHaveLength(0);
  });

  it('allows omitting confirm in body (since confirmation may be supplied via query)', async () => {
    const errors = await validateBodyDto({});
    expect(errors).toHaveLength(0);
  });

  it('passes validation with boolean options', async () => {
    const errors = await validateBodyDto({
      confirm: 'true',
      keepProviders: true,
      keepBackups: false,
      createBackup: true,
    });
    expect(errors).toHaveLength(0);
  });

  it('fails validation when confirm is invalid value (e.g., "false", "yes")', async () => {
    const errorsFalse = await validateBodyDto({ confirm: 'false' });
    expect(errorsFalse.length).toBeGreaterThan(0);
    const confirmErrorFalse = errorsFalse.find((e) => e.property === 'confirm');
    expect(confirmErrorFalse).toBeDefined();

    const errorsYes = await validateBodyDto({ confirm: 'yes' });
    expect(errorsYes.length).toBeGreaterThan(0);
  });

  it('fails validation when options have non-boolean types', async () => {
    const errors = await validateBodyDto({
      confirm: 'true',
      keepProviders: 'not-a-bool',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'keepProviders')).toBe(true);
  });

  it('fails validation when unexpected fields are present', async () => {
    const errors = await validateBodyDto({
      confirm: 'true',
      unrecognizedField: 'malicious',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'unrecognizedField')).toBe(true);
  });
});

describe('ResetApplicationQueryDto', () => {
  it('passes validation when confirm is "true"', async () => {
    const errors = await validateQueryDto({ confirm: 'true' });
    expect(errors).toHaveLength(0);
  });

  it('passes validation when confirm is "RESET"', async () => {
    const errors = await validateQueryDto({ confirm: 'RESET' });
    expect(errors).toHaveLength(0);
  });

  it('allows omitting confirm in query (may be in body)', async () => {
    const errors = await validateQueryDto({});
    expect(errors).toHaveLength(0);
  });

  it('fails validation when confirm is "false" or invalid', async () => {
    const errors = await validateQueryDto({ confirm: 'false' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails validation when unexpected query parameters are present', async () => {
    const errors = await validateQueryDto({
      confirm: 'true',
      extraParam: 'surprise',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'extraParam')).toBe(true);
  });
});
