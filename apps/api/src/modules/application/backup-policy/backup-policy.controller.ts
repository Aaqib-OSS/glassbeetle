import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../../../common/http/api-error.js';
import { BackupPolicyService } from './backup-policy.service.js';
import { BackupPolicyResponseDto, UpdateBackupPolicyDto } from './dto/index.js';

/**
 * Controller exposing `/application/backup-policy`.
 *
 * Controls automated backup settings: whether backups run automatically,
 * how frequently they run, how many archives are retained, and where archives
 * are stored on disk.
 *
 * The policy is a singleton settings object backed by a database row with
 * `CHECK (id = 1)`. The path has no identifier parameter.
 */
@ApiTags('application')
@Controller('application/backup-policy')
export class BackupPolicyController {
  constructor(private readonly backupPolicyService: BackupPolicyService) {}

  /**
   * `GET /application/backup-policy` — retrieve current backup policy.
   */
  @Get()
  @ApiOperation({
    summary: 'Retrieve the backup policy',
    description: `Returns the singleton automated backup policy settings:
- \`enabled\`: whether scheduled backups are active.
- \`frequency\`: cadence of backups ('hourly', 'daily', 'weekly').
- \`retentionCount\`: number of archives kept before pruning.
- \`targetDirectory\`: absolute directory path on disk, or null for default location.
- \`updatedAt\`: timestamp of last update.

The internal row \`id\` is never exposed.`,
  })
  @ApiOkResponse({
    description: 'The current backup policy',
    type: BackupPolicyResponseDto,
  })
  @ApiInternalServerErrorResponse({
    description: 'Backup policy row is missing from the database',
    type: ApiErrorResponseDto,
  })
  async getPolicy(): Promise<BackupPolicyResponseDto> {
    return this.backupPolicyService.getPolicy();
  }

  /**
   * `PUT /application/backup-policy` — update the backup policy.
   */
  @Put()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update the backup policy',
    description: `Replaces the singleton backup policy configuration (PUT).

Full replacement semantics:
Every field (\`enabled\`, \`frequency\`, \`retentionCount\`, \`targetDirectory\`) must be supplied.

Directory validation:
If \`targetDirectory\` is provided, it must be an absolute path to an existing, writable directory.
Relative paths, non-existent directories, regular files, unwritable locations, or paths with null bytes
are rejected with \`400 Bad Request\`. Setting \`targetDirectory: null\` explicitly configures the application
to use its default backup directory under the data directory (\`<dataDir>/backups\`).

Retention count:
Lowering \`retentionCount\` does not retroactively delete existing archives during this call; pruning to
the new limit is enforced during the next scheduled backup run.`,
  })
  @ApiBody({
    type: UpdateBackupPolicyDto,
    description: 'Full replacement backup policy payload',
  })
  @ApiOkResponse({
    description: 'The updated backup policy',
    type: BackupPolicyResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Validation failure: invalid frequency, non-positive retentionCount, unusable targetDirectory, or malformed payload',
    type: ApiErrorResponseDto,
  })
  @ApiInternalServerErrorResponse({
    description: 'Backup policy row is missing from the database',
    type: ApiErrorResponseDto,
  })
  async updatePolicy(
    @Body() dto: UpdateBackupPolicyDto,
  ): Promise<BackupPolicyResponseDto> {
    return this.backupPolicyService.updatePolicy(dto);
  }
}
