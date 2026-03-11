# lobster-backup — Unit Test Catalogue

> Proposed tests by component. Do not write tests against this list without first confirming the implementation matches the spec — the tests should validate the spec, not the other way around.

---

## Setup Script

### Passphrase collection
- Rejects passphrase below minimum length
- Rejects passphrase when confirmation doesn't match
- Accepts valid passphrase that meets minimum length and matches confirmation
- Generates a Vault Key of correct length (256 bits) and format
- Generates a Recovery Key of correct length and format
- Displays Recovery Key exactly once
- Requires explicit acknowledgment before proceeding past Recovery Key display
- Refuses to continue if acknowledgment is not given

### Destination configuration
- Creates local backup directory if it doesn't exist
- Rejects S3 destination that is publicly accessible
- Writes correct config schema to `~/.openclaw/lobster-backup.json`
- Config file contains passphrase salt, destination, schedule, and exclusion overrides

### Environment audit (seed)
- Runs `dpkg --get-selections` and parses output correctly
- Runs `npm list -g --depth=0` and parses output correctly
- Runs `systemctl list-unit-files --state=enabled` and parses output correctly
- Writes `lobsterfile.seed` with a clearly labeled "inferred, not authoritative" header
- Seed entries are formatted as idempotent bash commands

### lobsterfile.env initialization
- Detects `{{VARIABLE}}` placeholders in existing Lobsterfile
- Prompts for values for each detected placeholder
- Writes `lobsterfile.env` with provided values

### Confirmation summary
- Displays list of files that will be backed up before activating
- Displays destination and schedule before activating
- Refuses to activate without user confirmation

---

## Lobster Scan

### Inputs
- Reads `~/.openclaw/openclaw.json` to determine gateway port and workspace path
- Uses gateway port as primary grep target in config files
- Includes common OC-adjacent ports (8501, 18889, etc.) in scan

### Discovery heuristics
- Finds config files in `/etc/` containing the gateway port
- Finds systemd unit files in `/etc/systemd/system/` that exec `node` or `openclaw`
- Finds Caddy/nginx vhost configs proxying to OC-adjacent localhost ports
- Finds files in `~/.config/` belonging to tools referenced in TOOLS.md
- Does not flag files already registered in the external manifest

### Interactive flow
- Presents each finding with path and reason for flagging
- Accepts `y` to register a finding
- Accepts `n` to skip without registering
- Accepts `skip-all` to stop interactive prompts
- `--register` flag: accepted findings written to `manifest-external.json`
- `--paths` flag: scans additional directories beyond defaults
- Dry run (no flag): prints findings without modifying manifest

---

## Backup Script

### Lock file
- Creates lock file at `~/.openclaw/lobster-backup.lock` with current PID on start
- Removes lock file on successful completion
- Removes lock file on error exit (trap)
- Detects existing lock file with live PID and exits with clear message
- Detects stale lock file (PID dead), removes it, and proceeds

### Manifest and content capture
- Internal manifest includes: workspace files, MEMORY.md, SOUL.md, openclaw.json, skills, cron/jobs.json, identity/
- External manifest includes: all registered paths from manifest-external.json
- Excluded: `node_modules/`, `.git/`, `__pycache__/`, `*.pyc`, venvs, build dirs
- Respects `.gitignore` rules within registered paths
- Git repos with remotes: NOT tarballed; clone+checkout logged in Lobsterfile instead (test: directory identified as git repo with remote → not included in tarball)

### Symlink handling
- Symlink preserved as symlink in archive (not dereferenced)
- Warning emitted at backup time if symlink target is not in the backup manifest
- `--dereference` flag: follows symlinks and captures target content instead

### Metadata and versioning
- `meta.json` present in archive with correct OC version string
- `meta.json` contains timestamp and archive format version
- Manifest checksums in `meta.json` match actual archive contents

### Archive creation
- Archive created at `~/lobster-backups/` with timestamped filename
- Archive structure: `internal/`, `external/`, `meta.json`, `lobsterfile`, `lobsterfile.env`, `manifest-internal.json`, `manifest-external.json`
- `internal/` paths are relative to `~/.openclaw/`
- `external/` paths preserve absolute filesystem layout (e.g. `/etc/caddy/Caddyfile` → `external/etc/caddy/Caddyfile`)

### Encryption
- Archive encrypted with `age`
- Vault Key wrapped by passphrase-derived key (Argon2id)
- Vault Key wrapped by recovery key
- Both wrappers present in archive header
- Archive decryptable by passphrase key alone
- Archive decryptable by recovery key alone
- Archive not decryptable with incorrect passphrase
- Archive not decryptable with incorrect recovery key

### lobsterfile.env refresh
- Detects new `{{VARIABLE}}` placeholders not in current `lobsterfile.env`
- Prompts user for values of new variables before continuing
- Does not re-prompt for variables already in `lobsterfile.env`

### Retention pruning
- After backup: exactly 24 hourly archives retained, oldest dropped if more exist
- At midnight: most recent hourly promoted to daily; hourly archives older than 24h pruned
- After daily promotion: exactly 7 daily archives retained, oldest dropped if more exist
- Manual archives (tagged `--now`): not pruned regardless of count
- Pruning deletes the correct archive (oldest, not newest)

### Error handling
- Disk full during tarball creation: error reported, partial archive cleaned up
- Encryption failure: error reported, unencrypted archive not left on disk
- No external manifest registered: backup proceeds, logs that no external files captured

---

## Restore Script

### Listing and selection
- `--list` outputs available backups with timestamps and sizes
- `--list` includes both local and remote archives if Tier 2 configured
- `--from <path>` selects a specific archive
- Default (no flags): interactive selection from available archives

### Pre-restore checks
- OC version in `meta.json` is newer than running OC → warn and prompt to update before restoring
- OC version in `meta.json` is older than running OC → note it, proceed without blocking
- Existing `~/.openclaw/` detected → warn before overwriting
- Offer to create a backup of current state before restoring
- Existing install backup created successfully when user accepts

### Decryption
- Decrypts correctly with passphrase
- Decrypts correctly with recovery key
- Fails cleanly (clear error message) with wrong passphrase
- Fails cleanly with wrong recovery key
- Fails cleanly with corrupted archive

### Lobsterfile review and variable substitution
- Always displays Lobsterfile to user before execution (cannot be skipped)
- Prompts user to review and update `lobsterfile.env` values for all environment variables
- Accepts updated values; uses original values when user presses enter
- `{{VARIABLE}}` placeholders in Lobsterfile correctly substituted before execution
- Substituted Lobsterfile written to temp file; temp file cleaned up after execution

### File restoration
- Internal files restored to correct paths under `~/.openclaw/`
- External files restored to correct absolute paths (`external/etc/caddy/Caddyfile` → `/etc/caddy/Caddyfile`)
- External paths requiring root use `sudo cp` (or equivalent)
- Symlinks restored as symlinks (not as copies of target content)

### Lobsterfile execution
- Fail-fast default: execution stops at first failed command
- `--continue-on-error` flag: all commands attempted, all failures collected
- Failures reported clearly at end of execution in both modes
- `sudo` commands escalate correctly (user must have sudo access)
- Exit code reflects whether Lobsterfile completed successfully

### `--dry-run`
- Shows what files would be restored without restoring anything
- Shows what Lobsterfile commands would be executed without executing them
- Shows variable substitution values without making changes

### Post-restore
- Next steps printed: restart OC gateway, verify services, run `lobster scan`

---

## Lobsterfile Variables

- `{{VARIABLE}}` placeholder detected correctly in Lobsterfile text
- `{{VARIABLE_WITH_UNDERSCORES}}` detected correctly
- Nested `{{}}` (malformed) detected and reported as an error
- `lobsterfile.env` parsed correctly: key=value format, comments ignored
- Substitution: all occurrences of `{{VAR}}` replaced with value from env file
- Missing variable in env file → prompt on restore (not silent failure)
- Variable value containing special characters (spaces, slashes) handled correctly

---

## Archive Integrity

- `meta.json` checksums verified against archive contents on restore
- Checksum mismatch → abort restore with clear error
- Archive with missing `meta.json` → abort restore (not silently ignored)
- Archive created by a different format version → warn and prompt before proceeding

---

## End-to-End Scenarios (integration tests, but worth specifying)

- **Full round-trip:** Setup → backup → restore to same machine → verify all files present
- **Cross-machine restore:** Backup on machine A → restore on machine B → Lobsterfile executes cleanly with updated env vars
- **Partial environment restore:** Restore to machine where some Lobsterfile steps are already done → idempotent execution, no failures
- **Recovery key restore:** Backup with passphrase → "forget" passphrase → restore with recovery key → successful
- **Stale lock recovery:** Crash during backup → stale lock left → next backup detects stale lock, removes it, proceeds
- **Concurrent backup prevention:** Two backup processes started simultaneously → second one exits cleanly with "already in progress" message
- **Git repo in external manifest:** External path is a git repo with remote → not in tarball → Lobsterfile contains correct `git clone` entry → restore executes clone correctly

---

*Generated: 2026-03-11*
*Authors: Paul the Claw 🦞, for Nelson's review*
