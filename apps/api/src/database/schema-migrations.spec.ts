import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INITIAL_MIGRATION_NAME,
  MIGRATIONS_AFTER_BOOTSTRAP,
  runMigrations,
} from './schema-migrations.js';

describe('runMigrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  function appliedMigrations(): string[] {
    return db
      .prepare('SELECT name FROM schema_migrations ORDER BY id')
      .all()
      .map((row) => (row as { name: string }).name);
  }

  function tableExists(name: string): boolean {
    return (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        )
        .get(name) !== undefined
    );
  }

  it('records the bootstrap and every incremental migration on an empty database', () => {
    runMigrations(db);

    expect(appliedMigrations()).toEqual([
      INITIAL_MIGRATION_NAME,
      ...MIGRATIONS_AFTER_BOOTSTRAP.map((migration) => migration.name),
    ]);
  });

  it('is idempotent: a second run applies and records nothing new', () => {
    runMigrations(db);
    const first = appliedMigrations();

    runMigrations(db);

    expect(appliedMigrations()).toEqual(first);
  });

  it.each(['user_profile', 'spend_budget', 'artifact_versions'])(
    'creates %s on a fresh database',
    (table) => {
      runMigrations(db);

      expect(tableExists(table)).toBe(true);
    },
  );

  it('upgrades a database that already recorded only the bootstrap', () => {
    // What every installation that exists today looks like: the bootstrap ran
    // before `user_profile` was part of the sequence, so appending the file
    // reaches this database through the incremental migration or not at all.
    db.exec(`
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
    `);
    db.prepare(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
    ).run(INITIAL_MIGRATION_NAME, '2026-01-01T00:00:00.000Z');

    runMigrations(db);

    // Asserted against the list rather than against named entries, so adding a
    // migration does not need this test edited — which is the moment someone
    // would be tempted to edit it into agreeing.
    expect(tableExists('user_profile')).toBe(true);
    expect(appliedMigrations()).toEqual([
      INITIAL_MIGRATION_NAME,
      ...MIGRATIONS_AFTER_BOOTSTRAP.map((migration) => migration.name),
    ]);
  });

  it('leaves an already-applied incremental migration alone', () => {
    runMigrations(db);

    db.prepare(
      `INSERT INTO user_profile (id, singleton, created_at, updated_at)
       VALUES (?, 1, ?, ?)`,
    ).run('018f3a9e-0000-7000-8000-000000000001', '2026-01-01', '2026-01-01');

    runMigrations(db);

    const count = db
      .prepare('SELECT COUNT(*) AS cnt FROM user_profile')
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });
});

describe('chat owner migration', () => {
  let db: Database.Database;
  const migrationName = '007_chat_owner_set_null';

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE agents (id TEXT PRIMARY KEY);
      CREATE TABLE teams (id TEXT PRIMARY KEY);
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE chats (
        id               TEXT PRIMARY KEY,
        title            TEXT,
        project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
        agent_id         TEXT REFERENCES agents(id) ON DELETE SET NULL,
        team_id          TEXT REFERENCES teams(id) ON DELETE SET NULL,
        context_summary            TEXT,
        compacted_before_sequence  INTEGER,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        CHECK (
          (agent_id IS NOT NULL AND team_id IS NULL)
          OR (agent_id IS NULL AND team_id IS NOT NULL)
        )
      );
      CREATE TABLE messages (
        id      TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE
      );
      CREATE TABLE artifacts (
        id      TEXT PRIMARY KEY,
        chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL
      );
      CREATE TABLE usage_events (
        id      TEXT PRIMARY KEY,
        chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_chats_project_id ON chats(project_id);
      CREATE INDEX idx_chats_agent_id ON chats(agent_id);
      CREATE INDEX idx_chats_team_id ON chats(team_id);
    `);

    const recordMigration = db.prepare(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
    );
    recordMigration.run(INITIAL_MIGRATION_NAME, '2026-01-01T00:00:00.000Z');
    for (const migration of MIGRATIONS_AFTER_BOOTSTRAP) {
      if (migration.name !== migrationName) {
        recordMigration.run(migration.name, '2026-01-01T00:00:00.000Z');
      }
    }

    db.exec(`
      INSERT INTO agents (id) VALUES ('agent-1');
      INSERT INTO teams (id) VALUES ('team-1');
      INSERT INTO chats (id, title, agent_id, team_id, created_at, updated_at)
      VALUES ('agent-chat', 'Agent chat', 'agent-1', NULL, '2026-01-01', '2026-01-01'),
             ('team-chat', 'Team chat', NULL, 'team-1', '2026-01-01', '2026-01-01');
      INSERT INTO messages (id, chat_id) VALUES ('message-1', 'agent-chat'), ('message-2', 'team-chat');
      INSERT INTO artifacts (id, chat_id) VALUES ('artifact-1', 'agent-chat');
      INSERT INTO usage_events (id, chat_id) VALUES ('event-1', 'team-chat');
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('keeps chats and their children while allowing both owner columns to become null', () => {
    runMigrations(db);

    db.prepare('DELETE FROM agents WHERE id = ?').run('agent-1');
    db.prepare('DELETE FROM teams WHERE id = ?').run('team-1');

    const chats = db
      .prepare('SELECT id, agent_id, team_id FROM chats ORDER BY id')
      .all() as {
      id: string;
      agent_id: string | null;
      team_id: string | null;
    }[];
    expect(chats).toEqual([
      { id: 'agent-chat', agent_id: null, team_id: null },
      { id: 'team-chat', agent_id: null, team_id: null },
    ]);

    expect(db.prepare('SELECT id FROM messages ORDER BY id').all()).toEqual([
      { id: 'message-1' },
      { id: 'message-2' },
    ]);
    expect(db.prepare('SELECT id, chat_id FROM artifacts').all()).toEqual([
      { id: 'artifact-1', chat_id: 'agent-chat' },
    ]);
    expect(db.prepare('SELECT id, chat_id FROM usage_events').all()).toEqual([
      { id: 'event-1', chat_id: 'team-chat' },
    ]);

    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chats'",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_chats_project_id',
        'idx_chats_agent_id',
        'idx_chats_team_id',
      ]),
    );
  });

  it('still refuses a chat that belongs to both an agent and a team', () => {
    runMigrations(db);

    db.exec(`
      INSERT INTO agents (id) VALUES ('agent-2');
      INSERT INTO teams (id) VALUES ('team-2');
    `);

    expect(() => {
      db.prepare(
        `INSERT INTO chats (id, title, agent_id, team_id, created_at, updated_at)
         VALUES ('both-chat', 'Both owners', 'agent-2', 'team-2', '2026-01-01', '2026-01-01')`,
      ).run();
    }).toThrow(/CHECK/i);
  });
});

describe('user_profile schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  function insert(id: string, singleton = 1): void {
    db.prepare(
      `INSERT INTO user_profile (id, singleton, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(id, singleton, '2026-01-01', '2026-01-01');
  }

  it('accepts the first row', () => {
    expect(() => insert('018f3a9e-0000-7000-8000-000000000001')).not.toThrow();
  });

  it('refuses a second row, so the single-user property is enforced by the database', () => {
    insert('018f3a9e-0000-7000-8000-000000000001');

    expect(() => insert('018f3a9e-0000-7000-8000-000000000002')).toThrow(
      /UNIQUE/i,
    );
  });

  it('refuses a singleton value other than 1, which is what makes the UNIQUE index a limit of one', () => {
    expect(() => insert('018f3a9e-0000-7000-8000-000000000001', 2)).toThrow(
      /CHECK/i,
    );
  });

  it('defaults include_in_prompts to enabled', () => {
    insert('018f3a9e-0000-7000-8000-000000000001');

    const row = db
      .prepare('SELECT include_in_prompts FROM user_profile')
      .get() as { include_in_prompts: number };
    expect(row.include_in_prompts).toBe(1);
  });
});

describe('spend_budget schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  function insert(
    id: string,
    columns: {
      singleton?: number;
      period?: string;
      limitUsd?: number | null;
    } = {},
  ): void {
    db.prepare(
      `INSERT INTO spend_budget (id, singleton, limit_usd, period, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      columns.singleton ?? 1,
      columns.limitUsd ?? null,
      columns.period ?? 'monthly',
      '2026-01-01',
      '2026-01-01',
    );
  }

  it('refuses a second row, so there is one budget and not a collection', () => {
    insert('018f3a9e-0000-7000-8000-000000000001');

    expect(() => insert('018f3a9e-0000-7000-8000-000000000002')).toThrow(
      /UNIQUE/i,
    );
  });

  it('refuses a period the service does not know how to window', () => {
    expect(() =>
      insert('018f3a9e-0000-7000-8000-000000000001', { period: 'fortnightly' }),
    ).toThrow(/CHECK/i);
  });

  it('allows a null limit, which is how "no budget set" is stored', () => {
    insert('018f3a9e-0000-7000-8000-000000000001', { limitUsd: null });

    const row = db.prepare('SELECT limit_usd FROM spend_budget').get() as {
      limit_usd: number | null;
    };
    expect(row.limit_usd).toBeNull();
  });

  it('defaults the period to monthly', () => {
    db.prepare(
      `INSERT INTO spend_budget (id, singleton, created_at, updated_at)
       VALUES (?, 1, ?, ?)`,
    ).run('018f3a9e-0000-7000-8000-000000000001', '2026-01-01', '2026-01-01');

    const row = db.prepare('SELECT period FROM spend_budget').get() as {
      period: string;
    };
    expect(row.period).toBe('monthly');
  });

  describe('artifact_versions schema', () => {
    const artifactId = '018f3a9e-0000-7000-8000-000000000001';

    beforeEach(() => {
      runMigrations(db);
      db.prepare(
        `INSERT INTO artifacts (id, title, type, version, created_at, updated_at)
         VALUES (?, 'Doc', 'document', 2, '2026-01-01', '2026-01-01')`,
      ).run(artifactId);
    });

    it('enforces uniqueness on (artifact_id, version)', () => {
      db.prepare(
        `INSERT INTO artifact_versions (id, artifact_id, version, title, type, created_at)
         VALUES ('v1', ?, 1, 'Doc v1', 'document', '2026-01-01')`,
      ).run(artifactId);

      expect(() => {
        db.prepare(
          `INSERT INTO artifact_versions (id, artifact_id, version, title, type, created_at)
           VALUES ('v2', ?, 1, 'Doc v1 duplicate', 'document', '2026-01-01')`,
        ).run(artifactId);
      }).toThrow(/UNIQUE/i);
    });

    it('cascades deletion when parent artifact is deleted', () => {
      db.prepare(
        `INSERT INTO artifact_versions (id, artifact_id, version, title, type, created_at)
         VALUES ('v1', ?, 1, 'Doc v1', 'document', '2026-01-01')`,
      ).run(artifactId);

      db.prepare('DELETE FROM artifacts WHERE id = ?').run(artifactId);

      const count = db
        .prepare(
          'SELECT COUNT(*) as count FROM artifact_versions WHERE artifact_id = ?',
        )
        .get(artifactId) as { count: number };
      expect(count.count).toBe(0);
    });
  });
});
