import { Module } from '@nestjs/common';
import { CryptoModule } from '../../crypto/crypto.module.js';
import { ApplicationController } from './application.controller.js';
import { ApplicationService } from './application.service.js';
import { BackupSchedulerService } from './backups/backup-scheduler.service.js';
import { BackupsController } from './backups/backups.controller.js';
import { BackupsService } from './backups/backups.service.js';
import { BackupPolicyController } from './backup-policy/backup-policy.controller.js';
import { BackupPolicyService } from './backup-policy/backup-policy.service.js';

/**
 * Owns the application-lifecycle endpoints: reset, backups, restore, backup policy,
 * and background scheduled backups and retention enforcement.
 */
@Module({
  imports: [CryptoModule],
  controllers: [
    ApplicationController,
    BackupsController,
    BackupPolicyController,
  ],
  providers: [
    ApplicationService,
    BackupsService,
    BackupPolicyService,
    BackupSchedulerService,
  ],
  exports: [
    ApplicationService,
    BackupsService,
    BackupPolicyService,
    BackupSchedulerService,
  ],
})
export class ApplicationModule {}
