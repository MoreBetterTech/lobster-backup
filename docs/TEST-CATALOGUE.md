# lobster-backup — Unit Test Catalogue

> Merged from Nelson's module-level catalogue and Paul's script-level catalogue.
> Discuss before writing tests. This is the map, not the territory.

---

## 1. Config Management (`config.test.js`)

Config is read by every command, not just setup — deserves standalone coverage.

- Reads existing config from `~/.openclaw/lobster-backup.json`
- Creates config with correct defaults when none exists
- Validates required fields (backup path, passphrase hash, vault key, etc.)
- Rejects invalid config (missing fields, bad types)
- Resolves `~` and environment variables in paths
- Paths are never hardcoded to a specific user's home directory
- Config file permissions are restrictive (not world-readable — contains wrapped keys)

---

## 2. CLI Argument Parsing (`cli.test.js`)

- `lobster setup` routes to setup flow
- `lobster scan` routes to scan flow
- `lobster scan --register` passes register flag
- `lobster scan --paths /foo /bar` passes custom paths
- `lobster backup` routes to backup flow
- `lobster backup --now` passes immediate flag
- `lobster restore` routes to restore flow
- `lobster restore --list` passes list flag
- `lobster restore --from <path>` passes archive path
- `lobster restore --dry-run` passes dry-run flag
- Unknown commands print help text
- `--help` on any subcommand prints usage

---

## 3. Setup Script (`setup.test.js`)

### Passphrase
- Rejects passphrase below minimum length
- Rejects mismatched confirmation
- Accepts valid passphrase

### Key Generation
- Generates 256-bit Vault Key (correct length, random)
- Generates Recovery Key (256-bit, random)
- Displays Recovery Key exactly once
- Requires explicit acknowledgment before proceeding ("I have saved this key")
- Refuses to continue without acknowledgment

### Destination
- Creates local backup directory if it doesn't exist
- Rejects public S3 bucket (Tier 2 — pre-flight check for later)
- Writes correct config schema to `lobster-backup.json`

### Environment Audit (Bootstrap)
- Runs `dpkg --get-selections` for installed apt packages
- Runs `npm list -g --depth=0` for global npm packages
- Runs `systemctl list-unit-files --state=enabled` for enabled services
- Runs `pip list` if pip is present; skips gracefully if absent
- Writes `lobsterfile.seed` with "inferred, not authoritative" header
- Seed entries formatted as idempotent bash (existence checks, safe overwrites)
- Does not overwrite an existing Lobsterfile (seed is a separate file)

### lobsterfile.env Initialization
- Detects `{{VARIABLE}}` placeholders in existing Lobsterfile (if any)
- Prompts for values of detected variables
- Writes `lobsterfile.env` with key=value format

### Confirmation & Activation
- Shows summary: file list, destination, schedule
- Refuses to activate without user confirmation
- Aborts cleanly if user declines
- Prints AGENTS.md snippet (does NOT auto-modify AGENTS.md)

### Idempotency
- Re-running setup on an existing install warns and offers to reconfigure
- Does not destroy existing config without confirmation

---

## 4. Lobster Scan (`scan.test.js`)

### Inputs
- Reads gateway port from `~/.openclaw/openclaw.json`
- Reads workspace path from `openclaw.json`
- Uses port and workspace path as primary grep targets
- Includes common OC-adjacent ports (`:8501` Streamlit, `:18889` secondary claws, etc.)

### Heuristics
- Finds `/etc/` config files containing the gateway port string
- Finds systemd unit files that exec `node`, `openclaw`, or workspace-adjacent processes
- Finds Caddy/nginx vhosts proxying to known localhost ports
- Finds `~/.config/` files belonging to tools referenced in TOOLS.md
- Skips files already in the external manifest (no duplicate findings)

### Interactive Flow
- Presents each finding with: path, reason, matched snippet
- Accepts y/n/skip-all responses
- `--register` writes confirmed findings to external manifest
- `--paths /custom/dir` adds custom scan locations
- Dry run (no `--register`) prints findings without modifying manifest

### Error Handling
- Permission denied on a file → skips with warning, continues scanning
- Missing scan directory (e.g., no `/var/www/`) → skips gracefully
- No `openclaw.json` found → warns, falls back to default port patterns

---

## 5. Manifest — Internal (`manifest-internal.test.js`)

- Generates correct file list from a mock `~/.openclaw/` tree
- Includes all spec'd paths:
  - `MEMORY.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`
  - `memory/*.md`, `memory/*.json`
  - `openclaw.json`
  - `skills/` (recursive)
  - `cron/jobs.json`
  - `identity/` (recursive)
- Skips files that don't exist (graceful on sparse installs)
- Applies default exclusions: `.git/`, `node_modules/`, `*.log`, `tmp/`, `cache/`, `.cache/`
- Custom exclusions from config are respected
- Does not traverse excluded directories (performance — no walking `node_modules/`)

---

## 6. Manifest — External (`manifest-external.test.js`)

- Reads manifest from `~/.openclaw/lobster-external-manifest.json`
- Returns empty list when no manifest file exists
- Registers a new path (adds to manifest, persists to disk)
- Deduplicates paths on registration
- Rejects registration of paths inside `~/.openclaw/` (that's internal)
- Applies `.gitignore` rules from external paths that have their own `.gitignore`

### Git Repo Detection
- Detects directory is a git repo (has `.git/`)
- Extracts remote URL (`git remote get-url origin`)
- Extracts current ref (branch name, tag, or commit SHA)
- Handles repos with multiple remotes (defaults to `origin`)
- Handles repos with no remote → returns null (path should be tarballed)
- Handles detached HEAD → pins to commit SHA
- Generates correct `git clone` + `git checkout` Lobsterfile entry

### Symlinks
- Symlinks preserved as symlinks by default
- Warns if symlink target is not included in the backup
- `--dereference` flag follows symlinks instead of preserving them

---

## 7. Lobsterfile Parser (`lobsterfile.test.js`)

- Reads existing Lobsterfile (plain bash script)
- Appends a new step to the Lobsterfile
- Validates Lobsterfile is syntactically valid bash (`bash -n` check)
- Detects `{{VARIABLE}}` placeholders in content
- Detects `{{VAR_WITH_UNDERSCORES}}` (underscores in names)
- Reports malformed `{{}}` (empty placeholder) as error
- Extracts complete list of all referenced variables

---

## 8. Lobsterfile Variables (`lobsterfile-env.test.js`)

### Parsing
- Reads `lobsterfile.env` key=value pairs correctly
- Ignores comments (lines starting with `#`)
- Handles empty values
- Handles values with spaces
- Handles values with special characters (`=`, `#`, quotes)
- Rejects variable names with invalid characters

### Substitution
- Substitutes all `{{VARIABLE}}` occurrences in a string
- Handles multiple different variables in one string
- Handles same variable appearing multiple times
- Missing variable → prompts (not silent fail)
- Preserves non-placeholder `{{` content if not matching pattern

### File Management
- Writes new variables to `lobsterfile.env`
- Preserves existing comments when writing
- Detects new placeholders not yet in env file (for refresh prompting)
- Does not re-prompt for variables that already have values

---

## 9. Encryption — Key Management (`crypto-keys.test.js`)

### Key Derivation
- Derives passphrase key via Argon2id (deterministic given same passphrase + salt)
- Same passphrase + same salt = same derived key
- Different passphrases produce different derived keys
- Different salts with same passphrase produce different keys

### Key Wrapping
- Wraps Vault Key with passphrase-derived key → produces ciphertext
- Wraps Vault Key with Recovery Key → produces ciphertext
- Unwraps Vault Key with correct passphrase → recovers original key
- Unwraps Vault Key with correct Recovery Key → recovers original key
- Unwrap fails cleanly with wrong passphrase (clear error, no crash)
- Unwrap fails cleanly with wrong Recovery Key
- Passphrase and Recovery Key wrappers are independent (neither depends on the other)

---

## 10. Encryption — Archive (`crypto-archive.test.js`)

- Encrypts a tarball with `age` using both recipients (passphrase + recovery key)
- Decrypts with passphrase-derived identity → success
- Decrypts with Recovery Key identity → success
- Decryption fails cleanly with wrong credentials
- Encrypted file is not readable as plaintext (sanity check)
- Archive header contains both wrapped key copies
- Round-trip: encrypt → decrypt → byte comparison (integrity)

---

## 11. Backup Script (`backup.test.js`)

### Lock File
- Creates lock file with PID on start
- Removes lock file on success
- Removes lock file on error (trap cleanup)
- Detects live PID in existing lock → bails with message
- Detects stale PID in existing lock → recovers and proceeds

### Archive Contents
- Tarball contains all internal manifest files
- Tarball contains all external manifest files
- Includes `meta.json` with: OC version, timestamp, manifest checksums
- Includes Lobsterfile
- Includes `lobsterfile.env`
- Includes `manifest-internal.json`
- Includes `manifest-external.json`

### Archive Structure
- `internal/` prefix for internal files
- `external/` prefix for external files (leading `/` stripped, path-preserved)
- `meta.json`, `lobsterfile`, `lobsterfile.env`, manifests at top level

### Exclusions
- Default exclusions applied (node_modules, .git, __pycache__, venvs, build dirs)
- `.gitignore` rules from external paths respected
- Git repos with remotes are NOT tarballed (Lobsterfile has clone entry instead)

### Encryption
- Archive is encrypted with `age` (not plaintext)
- Encrypted using Vault Key with both wrappers

### Filename & Tagging
- Timestamp filename: `backup-YYYY-MM-DDTHH:MM:SS.tar.gz.age`
- `--now` triggers immediate backup
- Manual backups tagged as manual (not subject to auto-pruning)

### lobsterfile.env Refresh
- Detects new `{{VARIABLE}}` placeholders since last backup
- Prompts for new variables only
- Does not re-prompt for existing variables with values

### Error Handling
- Disk full → partial archive cleaned up, no corrupt file left
- Encryption failure → no plaintext tarball left on disk
- No external manifest → proceeds with warning (internal-only backup)
- Logs result on success
- Logs error on failure

---

## 12. Pruning / Retention (`pruning.test.js`)

- Keeps last 24 hourly backups; prunes older
- Daily promotion: most recent hourly at midnight boundary becomes daily snapshot
- Keeps last 7 daily snapshots; prunes older
- Manual (`--now`) backups are never auto-pruned
- Most recent backup of each tier is always kept, regardless of age
- Prune runs after each backup completion (not a separate command)
- Correct archive is deleted (oldest of the tier, not random)

### Edge Cases
- Fewer than 24 backups exist → no hourly pruning needed
- All backups are from the same hour → handles gracefully
- No daily snapshots yet → no daily pruning

---

## 13. Restore — Archive Selection (`restore-select.test.js`)

- `--list` shows available backups with timestamps and sizes
- `--list` sorts by date (newest first)
- `--list` discovers from configured backup directory
- Default (no flags) enters interactive selection
- `--from <backup>` selects specific archive by path
- `--from` rejects non-existent archive (clean error)

---

## 14. Restore — Pre-flight Checks (`restore-preflight.test.js`)

### OC Version
- Backup OC version > current OC version → warn and prompt (recommend updating first)
- Current OC version > backup version → note and proceed
- Same version → proceed silently

### Existing Install
- Detects existing `~/.openclaw/` workspace and config
- Warns before overwriting current state
- Offers to back up current state first (safety net)

### Archive Integrity
- Verifies checksums in `meta.json` against archive contents
- Checksum mismatch → abort with clear error
- Missing `meta.json` → abort
- Format version mismatch → warn and prompt

### Dry Run
- `--dry-run` reports what would be restored without modifying anything

---

## 15. Restore — Decryption (`restore-decrypt.test.js`)

- Prompts for credential type (passphrase vs. recovery key)
- Correct passphrase → decrypts successfully
- Correct Recovery Key → decrypts successfully
- Wrong passphrase → fails with clear error message
- Wrong Recovery Key → fails with clear error message
- Corrupted archive → fails cleanly (not a hang or crash)

---

## 16. Restore — File Restoration (`restore-files.test.js`)

- Internal files restored to `~/.openclaw/` at correct relative paths
- External files restored to original absolute paths
- External file restore to system paths (`/etc/`, `/var/`) uses `sudo`
- File permissions preserved on restore
- Missing parent directories created automatically
- Symlinks restored as symlinks (not dereferenced)

---

## 17. Restore — Lobsterfile Execution (`restore-lobsterfile.test.js`)

### Review (mandatory)
- Lobsterfile is always displayed before execution — cannot be skipped
- User must confirm before execution proceeds

### Variable Substitution
- Prompts for `lobsterfile.env` review before execution
- `{{VARIABLE}}` values substituted before running
- Prompts for updated values when environment has changed (new IP, new domain, etc.)
- Substituted Lobsterfile written to temp file; temp file cleaned up after execution

### Execution
- Runs as current user (not root)
- `sudo` commands in Lobsterfile are preserved and passed through
- Default: fail-fast (stops on first error)
- `--continue-on-error` collects all failures and reports at end
- Failures always reported with the step that failed
- Exit code reflects execution result (0 = success, non-zero = failure)

### Post-Execution
- Prints next steps: restart gateway, verify services, run `lobster scan`
- `--dry-run` displays substituted Lobsterfile but does not execute

---

## 18. End-to-End Scenarios (`e2e.test.js`)

These are integration tests that exercise the full flow.

### E2E-1: Full Round-Trip (Same Machine)
Setup → backup → restore on same machine → all files present, services described in Lobsterfile re-executed, config intact.

### E2E-2: Cross-Machine Portability
Backup on machine A → restore on machine B → env vars prompted for update → Lobsterfile executes cleanly with new values.

### E2E-3: Partial / Idempotent Restore
Restore to a machine where some Lobsterfile steps are already done → idempotent commands succeed → no failures from re-running.

### E2E-4: Recovery Key Restore
Forget passphrase → use Recovery Key to decrypt → full restore succeeds.

### E2E-5: Stale Lock Recovery
Crash mid-backup → stale lock file with dead PID → next backup run detects stale lock, recovers, completes successfully.

### E2E-6: Concurrent Prevention
Two backup processes started simultaneously → second detects live lock → exits cleanly with message.

### E2E-7: Git Repo in External Manifest
Register a git repo with remote → backup does NOT tarball it → Lobsterfile contains `git clone` + `git checkout` → restore clones correctly from remote.

---

## 19. Edge Cases & Error Handling (`edge-cases.test.js`)

- Backup with minimal workspace (only `openclaw.json` exists)
- Backup with no external manifest registered
- Backup with empty Lobsterfile
- Restore to machine with no existing OC install
- Restore when backup destination directory doesn't exist
- Interrupted backup doesn't corrupt previous backups
- Non-UTF8 filenames in external manifest
- Very large files in external manifest (no OOM)

---

## Summary

| Section | Test File | Est. Cases |
|---|---|---|
| Config Management | `config.test.js` | 7 |
| CLI Parsing | `cli.test.js` | 12 |
| Setup Script | `setup.test.js` | 18 |
| Lobster Scan | `scan.test.js` | 16 |
| Internal Manifest | `manifest-internal.test.js` | 7 |
| External Manifest | `manifest-external.test.js` | 14 |
| Lobsterfile Parser | `lobsterfile.test.js` | 7 |
| Lobsterfile Variables | `lobsterfile-env.test.js` | 14 |
| Crypto — Keys | `crypto-keys.test.js` | 10 |
| Crypto — Archive | `crypto-archive.test.js` | 7 |
| Backup Script | `backup.test.js` | 22 |
| Pruning / Retention | `pruning.test.js` | 9 |
| Restore — Selection | `restore-select.test.js` | 6 |
| Restore — Pre-flight | `restore-preflight.test.js` | 9 |
| Restore — Decryption | `restore-decrypt.test.js` | 6 |
| Restore — Files | `restore-files.test.js` | 6 |
| Restore — Lobsterfile | `restore-lobsterfile.test.js` | 12 |
| End-to-End | `e2e.test.js` | 7 |
| Edge Cases | `edge-cases.test.js` | 8 |
| **Total** | **19 files** | **~197 cases** |

---

## Open Design Questions (Surfaced by Tests)

These need spec decisions before tests can be finalized:

1. **Symlink handling** — Catalogue assumes "preserve as symlinks, warn if target missing, `--dereference` flag available." Not yet in PLAN.md.
2. **`--continue-on-error` for Lobsterfile execution** — Catalogue assumes fail-fast default with opt-in continue. Not yet in PLAN.md.
3. **Lock file mechanism** — Catalogue assumes PID-based lock file with stale detection. Not yet in PLAN.md.
4. **Archive format versioning** — Catalogue tests for format version mismatch. Implies `meta.json` needs a `formatVersion` field. Not yet specified.
5. **Config file permissions** — Should `lobster-backup.json` enforce restrictive permissions (e.g., `0600`)? Contains wrapped keys.

---

*Merged by Nelson 🦞, 2026-03-11*
*Sources: Nelson's module-level catalogue + Paul's script-level catalogue*
*David spotted the config management gap ⭐*
