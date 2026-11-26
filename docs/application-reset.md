# Application Reset

Detailed specification and architectural decisions for the application reset endpoint (`POST /api/v1/application/reset`).

## Motivation & Threat Model

Resetting the application returns Glassbeetle to a clean, freshly-installed state. This is useful for users who have been experimenting and wish to start over, users transferring a machine to someone else, or recovering from a broken installation.

However, reset is the single most destructive operation in the API. Glassbeetle is a local-first application without mandatory authentication, bounded by loopback binding and CORS origin enforcement. An unguarded destructive endpoint would expose user data to arbitrary cross-site requests or accidental invocation.

To mitigate this risk:
1. **Explicit Confirmation**: The endpoint requires explicit confirmation either in the JSON request body (`{ "confirm": "true" }` or `{ "confirm": "RESET" }`) or via query parameter (`?confirm=true` or `?confirm=RESET`). Missing, empty, or invalid confirmation returns `400 Bad Request`.
2. **Conflict Guard**: Resets are refused with `409 Conflict` if a backup, restore, or another reset is already in progress.
3. **Transactional Clearing**: All database table modifications are executed inside a single SQLite transaction. If any error occurs, the transaction rolls back completely, ensuring no half-cleared database state.
4. **Preservation of Backups by Default**: Historical backup archives and metadata are preserved by default (`keepBackups: true`), guaranteeing that users can restore previous states if a reset was triggered by mistake.
5. **Preservation of Master Key**: The encryption master key (`master.key`) is preserved so existing backup archives remain restorable.
6. **Consistent File Cleanup**: Database rows are cleared first in dependency order. After transaction commit, referenced stored files and orphan files in user buckets (`pictures`, `project-images`, `artifacts`) are cleaned up. Stored backups in `backups` are untouched.

---

## Endpoint Specification

- **Method**: `POST`
- **Route**: `/api/v1/application/reset`
- **Parameters**: None
- **Request Body** (`ResetApplicationDto`):
  - `confirm` (string, optional if supplied in query): Must equal `"true"` or `"RESET"`.
  - `keepProviders` (boolean, optional, default: `false`): If `true`, preserves configured providers, models, and provider credentials.
  - `keepBackups` (boolean, optional, default: `true`): If `true`, preserves backup records and archive files.
  - `createBackup` (boolean, optional, default: `false`): If `true`, takes an automatic safety backup before performing reset.
- **Query Parameters** (`ResetApplicationQueryDto`):
  - `confirm` (string, optional): Must equal `"true"` or `"RESET"`.

### Status Codes
- `200 OK`: Reset completed successfully. Returns summary of cleared resources and next steps.
- `400 Bad Request`: Confirmation missing or invalid (`CONFIRMATION_REQUIRED`), or invalid body options.
- `409 Conflict`: A backup, restore, or reset operation is currently in progress.
- `500 Internal Server Error`: Reset failed; database transaction was rolled back and pre-reset state remains intact.

---

## Table-by-Table Scope

| Table / Resource | Action | Justification |
| :--- | :--- | :--- |
| `agents` | **CLEARED** | User content. Cascades memories and team memberships. Associated profile pictures are deleted. |
| `agent_memories` | **CLEARED** | User private agent memory. Cascaded from `agents`. |
| `teams` | **CLEARED** | User content. Teams and associations. |
| `team_members` | **CLEARED** | Association between teams and agents. |
| `projects` | **CLEARED** | User workspaces and projects. Referenced cover images are deleted. |
| `chats` | **CLEARED** | User conversations. Cascades messages. |
| `messages` | **CLEARED** | Chat message history. |
| `shared_memories` | **CLEARED** | Global user memories. |
| `artifacts` | **CLEARED** | User-generated artifacts. Referenced file blobs are deleted. |
| `artifact_versions` | **CLEARED** | Version history of artifacts. Referenced version blobs are deleted. |
| `system_prompts` | **CLEARED** | User-created system prompt templates. |
| `usage_events` | **CLEARED** | Historical analytics, event log, and token usage records. |
| `providers` | **CLEARED** (unless `keepProviders: true`) | Provider connections. Preserved when user specifies `keepProviders: true`. |
| `models` | **CLEARED** (unless `keepProviders: true`) | Configured and discovered models. |
| `provider_credentials` | **CLEARED** (unless `keepProviders: true`) | Encrypted API keys and secrets. |
| `spend_budget` | **RESET** | Singleton row reset to default values (`limit_usd = NULL`, `period = 'monthly'`). |
| `user_profile` | **RESET** | Singleton row reset to OS seed values (`resolveUserProfileSeed`). Profile picture deleted. |
| `backup_policy` | **RESET** | Singleton row (`id = 1`) restored to `data/backups/seed.sql` defaults (`enabled = 0`, `frequency = 'daily'`, `retention_count = 7`, `target_directory = NULL`). |
| `backups` | **PRESERVED** (default) | Backup records in database are kept unless `keepBackups: false` is explicitly passed. |
| `master.key` | **PRESERVED** | Encryption master key file on disk is never deleted. Preserves decryptability of historical backups. |
| `schema_migrations`| **PRESERVED** | Tracks applied DDL migrations; must never be deleted. |
| Stored Files | **CLEARED** | All files in buckets `pictures`, `project-images`, and `artifacts` are removed. The `backups` bucket is preserved. |

---

## Dependency Order for Deletion

To respect foreign key constraints with `foreign_keys = ON`:
1. `usage_events` (references agents, providers, models, chats)
2. `artifact_versions` (references artifacts ON DELETE CASCADE)
3. `artifacts` (references projects, chats, agents)
4. `messages` (references chats ON DELETE CASCADE, agents ON DELETE SET NULL)
5. `chats` (references projects, agents, teams)
6. `team_members` (references teams, agents)
7. `teams`
8. `agent_memories` (references agents ON DELETE CASCADE)
9. `agents` (references system_prompts, models)
10. `projects`
11. `shared_memories`
12. `system_prompts`
13. If `!keepProviders`:
    - `provider_credentials`
    - `models`
    - `providers`
14. If `!keepBackups`:
    - `backups`
15. Reset singletons:
    - `backup_policy` (id = 1)
    - `user_profile` (singleton = 1)
    - `spend_budget` (singleton = 1)
