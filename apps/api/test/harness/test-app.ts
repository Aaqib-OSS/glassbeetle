import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp, registerNotFoundFallback } from '../../src/bootstrap.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { resetDatabase } from './database-reset.js';
import { TestFixtures } from './fixtures.js';

export interface TestAppOptions {
  /**
   * Additional controllers or providers to register in the testing module.
   */
  controllers?: any[];
  providers?: any[];
}

export interface TestApp {
  readonly app: INestApplication;
  readonly db: DatabaseService;
  /**
   * The data directory unique to this test app. Storage and backups derive
   * their paths from it, so they are isolated per run and removed on close.
   */
  readonly dataDir: string;
  readonly fixtures: TestFixtures;
  readonly getHttpServer: () => any;
  readonly request: () => request.SuperTest<request.Test>;
  readonly reset: () => void;
  readonly close: () => Promise<void>;
}

/**
 * Boots a NestJS application configured identically to production, but backed
 * by an isolated temporary SQLite database file.
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestApp> {
  // Each test app gets its own data directory under the system temp directory.
  // Using tmpdir() itself as the data directory would make everything derived
  // from it (<dataDir>/storage, <dataDir>/backups) shared between workers and
  // runs, and leave it behind after the suite.
  const runDataDir = mkdtempSync(join(tmpdir(), 'glassbeetle-test-'));
  const tempDbPath = join(runDataDir, 'test.db');

  // Safety assertion: test DB path must be in tmpdir and never match a real config
  if (!tempDbPath.includes(tmpdir())) {
    throw new Error(
      `Test database path "${tempDbPath}" is not inside system temp directory.`,
    );
  }

  // Create a mock AppConfigService providing the temporary database path
  const mockConfigService = {
    nodeEnv: 'test',
    isProduction: false,
    port: 0,
    dataDir: runDataDir,
    databasePath: tempDbPath,
    corsOrigins: ['http://localhost:4200'],
    logLevel: 'error',
    logBody: false,
    maxPictureSizeBytes: 5 * 1024 * 1024,
    // Deterministic, so a test can assert what the user profile is seeded
    // with instead of whatever account the test runner happens to use.
    defaultUserName: 'Test User',
  };

  const moduleBuilder = Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
    providers: options.providers ?? [],
  })
    .overrideProvider(AppConfigService)
    .useValue(mockConfigService);

  const moduleFixture: TestingModule = await moduleBuilder.compile();

  const app = moduleFixture.createNestApplication();
  configureApp(app);
  await app.init();
  registerNotFoundFallback(app);

  const db = app.get(DatabaseService);
  const fixtures = new TestFixtures(db);

  return {
    app,
    db,
    dataDir: runDataDir,
    fixtures,
    getHttpServer: () => app.getHttpServer(),
    request: () => request(app.getHttpServer()),
    reset: () => resetDatabase(db),
    close: async () => {
      await app.close();
      // Remove the run's data directory: the database (and WAL/SHM files),
      // storage and backups all live inside it.
      try {
        rmSync(runDataDir, { recursive: true, force: true });
      } catch {
        // Ignore removal errors on temp files
      }
    },
  };
}
