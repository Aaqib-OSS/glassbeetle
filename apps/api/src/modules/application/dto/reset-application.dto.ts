import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

/**
 * Valid confirmation values authorizing application reset.
 */
export const VALID_RESET_CONFIRMATIONS = ['true', 'RESET'] as const;
export type ResetConfirmation = (typeof VALID_RESET_CONFIRMATIONS)[number];

/**
 * Body DTO for the application reset endpoint (`POST /api/v1/application/reset`).
 *
 * Reset is an irreversible, destructive operation that clears application state.
 * Callers must supply explicit confirmation either in the request body (`{ "confirm": "true" }`
 * or `{ "confirm": "RESET" }`) or via query parameter (`?confirm=true` or `?confirm=RESET`).
 */
export class ResetApplicationDto {
  @ApiPropertyOptional({
    description:
      'Safety confirmation parameter. Must be set to "true" or "RESET" to authorize irreversible application reset.',
    example: 'true',
    type: String,
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === true ? 'true' : typeof value === 'string' ? value.trim() : value,
  )
  @IsIn(VALID_RESET_CONFIRMATIONS, {
    message:
      'confirm must be "true" or "RESET" to authorize application reset',
  })
  confirm?: string;

  @ApiPropertyOptional({
    description:
      'Whether to preserve configured providers, models, and provider credentials. Defaults to false.',
    example: false,
    type: Boolean,
  })
  @IsOptional()
  @IsBoolean({
    message: 'keepProviders must be a boolean',
  })
  keepProviders?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether to preserve backup metadata and physical backup archives. Defaults to true.',
    example: true,
    type: Boolean,
  })
  @IsOptional()
  @IsBoolean({
    message: 'keepBackups must be a boolean',
  })
  keepBackups?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether to create an automatic safety backup before performing reset. Defaults to false.',
    example: false,
    type: Boolean,
  })
  @IsOptional()
  @IsBoolean({
    message: 'createBackup must be a boolean',
  })
  createBackup?: boolean;
}

/**
 * Query parameter DTO for the application reset endpoint.
 */
export class ResetApplicationQueryDto {
  @ApiPropertyOptional({
    description:
      'Explicit safety confirmation via query parameter. Must be set to "true" or "RESET" to authorize application reset.',
    example: 'true',
    type: String,
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === true ? 'true' : typeof value === 'string' ? value.trim() : value,
  )
  @IsIn(VALID_RESET_CONFIRMATIONS, {
    message:
      'confirm must be "true" or "RESET" to authorize application reset',
  })
  confirm?: string;
}
