import { ApiProperty } from '@nestjs/swagger';

/**
 * Breakdown of entity counts cleared or preserved during application reset.
 */
export class ResetSummaryDto {
  @ApiProperty({ description: 'Number of agents cleared', example: 4 })
  agentsCleared!: number;

  @ApiProperty({ description: 'Number of chats cleared', example: 12 })
  chatsCleared!: number;

  @ApiProperty({ description: 'Number of messages cleared', example: 58 })
  messagesCleared!: number;

  @ApiProperty({
    description: 'Number of agent and shared memories cleared',
    example: 8,
  })
  memoriesCleared!: number;

  @ApiProperty({ description: 'Number of projects cleared', example: 2 })
  projectsCleared!: number;

  @ApiProperty({
    description: 'Number of artifacts and versions cleared',
    example: 5,
  })
  artifactsCleared!: number;

  @ApiProperty({
    description: 'Number of user-created system prompts cleared',
    example: 3,
  })
  systemPromptsCleared!: number;

  @ApiProperty({
    description: 'Number of analytics usage events cleared',
    example: 120,
  })
  usageEventsCleared!: number;

  @ApiProperty({
    description: 'Number of configured providers cleared',
    example: 2,
  })
  providersCleared!: number;

  @ApiProperty({
    description: 'Number of provider models cleared',
    example: 6,
  })
  modelsCleared!: number;

  @ApiProperty({
    description:
      'Total number of stored files deleted from disk (pictures, project images, artifacts)',
    example: 7,
  })
  filesDeleted!: number;

  @ApiProperty({
    description:
      'Whether backup metadata and physical backup archive files were preserved',
    example: true,
  })
  backupsPreserved!: boolean;

  @ApiProperty({
    description:
      'Whether provider configurations, models, and credentials were preserved',
    example: false,
  })
  providersPreserved!: boolean;

  @ApiProperty({
    description:
      'Whether an automatic pre-reset safety backup was generated before clearing',
    example: false,
  })
  preResetBackupCreated!: boolean;

  @ApiProperty({
    description:
      'Identifier of the automatic pre-reset safety backup, if one was created',
    example: null,
    nullable: true,
    type: String,
  })
  preResetBackupId!: string | null;
}

/**
 * Response returned after a successful application reset.
 */
export class ResetApplicationResponseDto {
  @ApiProperty({
    description: 'Status of the reset operation.',
    example: 'completed',
  })
  status!: 'completed';

  @ApiProperty({
    description: 'Human-readable summary message.',
    example:
      'Application reset completed successfully. The application has been returned to a clean, freshly-installed state.',
  })
  message!: string;

  @ApiProperty({
    description: 'Detailed summary of cleared entities and preserved components.',
    type: ResetSummaryDto,
  })
  cleared!: ResetSummaryDto;

  @ApiProperty({
    description: 'Next steps and guidance for the user after reset.',
    example: [
      'Configure your LLM providers and credentials to resume using agents and chats.',
      'Existing backup archives have been preserved and can be restored at any time.',
    ],
    type: [String],
  })
  nextSteps!: string[];

  @ApiProperty({
    description: 'ISO-8601 UTC timestamp when reset completed.',
    example: '2026-11-26T08:00:00.000Z',
  })
  resetAt!: string;
}
