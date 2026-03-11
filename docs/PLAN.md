# Lobster Backup — Project Plan

> *"Your lobster has a memory. Don't let it drown."*

---

## Overview

A backup and restore system for the OpenClaw ecosystem. Goal: frictionless install that just works, with optional encrypted remote storage for users who want more protection. Run on a fresh install and you're back to where you were — soul, memory, workspace, customizations and all.

**Related projects:**
- [lobster-fileshare](../lobster-fileshare/PLAN.md) — sharing artifacts via stable URLs
- [lobster-tank](../lobster-tank/PLAN.md) — inter-lobster discovery and reputation
- [lobster-memory](../lobster-memory/PLAN.md) — vector memory and persistent context

---

## Use Cases

### Personal: Disaster Recovery
The core case. Server dies, machine stolen, botched upgrade, accidental `rm`. You lose the install but not the lobster. Restore in minutes, not months.

### Personal: Portability
Move your lobster from one machine to another. Upgrade hardware. Run the same lobster on multiple machines. Your identity, memory, and personality travel with you.

### Personal: Peace of Mind
Just knowing it's backed up. The lobster accumulates real value over time — months of curated memory, tuned personality, custom skills. That's worth protecting.

---

## The Lobsterfile

A real-time log of every action that changes the claw's environment — like a Dockerfile, but written continuously as changes happen rather than authored upfront. The Lobsterfile is turned into a bash script for automated rebuild.

**The Lobsterfile is structural memory.** It records the history of how this specific claw's environment was built. It is as critical to maintain as `MEMORY.md` — in fact it *is* a form of memory: the record of structural and functional changes that make this claw unique. It must be updated immediately when a change is made, not batched at backup time.

**AGENTS.md requirement:**
When `lobster-backup` is installed, the setup script prints the following snippet and instructs the user to add it to AGENTS.md. Skills do not auto-modify core agent files — this is a manual step, but it is critical:

```
## Lobsterfile Maintenance (lobster-backup)
Whenever a prompt leads you to make any change to the system environment —
installing a package, enabling a service, creating a user, modifying a config
file outside the workspace, registering an external dependency — you MUST
append the corresponding step(s) to the Lobsterfile before considering the
task complete. Same obligation as updating MEMORY.md.

Rules:
- Prefix commands requiring root with `sudo` exactly as you ran them
- Write every step IDEMPOTENTLY — assume the script may run on a machine
  where some steps are already done (e.g. `apt install` is safe; writing
  a file needs an existence check or overwrite-safe redirect)
- Use {{VARIABLE}} placeholders for any environment-specific values;
  record the value in lobsterfile.env
```

**What goes in the Lobsterfile (everything that changes system state):**
- Package installs: `apt install caddy`, `npm install -g openclaw`, `pip install ...`
- Service management: `systemctl enable caddy`, `systemctl start caddy`
- User/group creation: `adduser nellie`, `groupadd ragusers`, `usermod -aG ragusers ubuntu`
- OC config changes (port, model, auth settings)
- Installed skills and their sources
- Channel configurations (Slack, Telegram, etc.)
- External dependency registration (added to external manifest)
- File copies or writes outside the workspace
- Firewall rules, cron entries, or any other persistent system state change

Anywhere an environment-specific value appears (IP address, domain name, port, hostname), use a `{{VARIABLE}}` placeholder. See **Lobsterfile Variables** below.

**Why it matters:** A tarball restores files. The Lobsterfile restores the *environment*. Together they give you a complete rebuild path — but only if the Lobsterfile was kept current.

---

## Lobsterfile Variables (`lobsterfile.env`)

The Lobsterfile is a parameterized template, not a static log. Environment-specific values — IP addresses, domain names, hostnames, ports, external service endpoints — must never be hardcoded. Instead, use named `{{VARIABLE}}` placeholders.

**`lobsterfile.env`** is stored alongside the Lobsterfile and maps placeholder names to values recorded at backup time:

```bash
# lobsterfile.env — captured at backup time
SERVER_IP=203.0.113.42
DOMAIN_NAME=paul.example.com
GATEWAY_PORT=18789
STREAMLIT_PORT=8501
DB_HOST=10.0.0.5
```

**Lobsterfile example (excerpt):**
```bash
# Caddyfile
cat > /etc/caddy/Caddyfile <<EOF
{{DOMAIN_NAME}} {
    reverse_proxy localhost:{{STREAMLIT_PORT}}
}
EOF
systemctl reload caddy
```

When the Lobsterfile bash script runs, `{{VARIABLE}}` placeholders are substituted from `lobsterfile.env` before execution.

**On restore — same environment:**
Values from `lobsterfile.env` are used as-is. No prompts, no changes needed.

**On restore — new environment (IP change, new domain, etc.):**
The restore script detects that environment-specific values are present and prompts:

```
The following environment variables were recorded in the original backup.
If this is a new environment, update any values that have changed.

  SERVER_IP        [203.0.113.42] → _______
  DOMAIN_NAME      [paul.example.com] → _______
  GATEWAY_PORT     [18789] → (enter to keep)
  STREAMLIT_PORT   [8501] → (enter to keep)

Press enter to keep the original value.
```

Updated values are written to a new `lobsterfile.env` before the Lobsterfile script executes.

**Agent responsibility:**
The agent is instructed (via AGENTS.md) to:
- Recognize when it uses an environment-specific value during setup
- Add the value to `lobsterfile.env` with a descriptive name
- Reference the `{{VARIABLE}}` in the Lobsterfile step instead of the raw value

**What counts as a variable:**
- IP addresses (public, private, loopback for non-obvious services)
- Domain names and hostnames
- Non-default ports
- External service URLs (API endpoints, database hosts)
- Paths that differ across environments (if not using standard locations)

---

## What Gets Backed Up

### Internal manifest (files inside `~/.openclaw`)
- `MEMORY.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`
- `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`
- `memory/*.md` (daily notes)
- `memory/*.json` (dream weights, heartbeat state, etc.)
- `openclaw.json` (gateway config)
- Custom skills in `~/.openclaw/skills/`
- `cron/jobs.json` (cron job definitions — stored at `~/.openclaw/cron/jobs.json`)
- `identity/` directory (agent identity, keypairs)

### External manifest (files outside `~/.openclaw`)
- Registered at setup time — anything the lobster depends on that lives outside its home dir
- Examples: `~/claude/sync`, custom scripts, config files in `~/.config/`
- Lobster maintains a manifest; backup script uses it

### Always included
- The Lobsterfile
- `lobsterfile.env` (environment variable values)
- Both manifests

### Default exclusions
The following are excluded by default — all are regenerable and should not bloat the backup archive:

**Inside `~/.openclaw/`:**
- `node_modules/` — reinstall with `npm install`
- `.git/` — git history is not backup content
- `*.log` — log files
- `tmp/`, `cache/`, `.cache/` — ephemeral

**Inside workspace and external manifest paths:**
- `node_modules/`
- `.git/`
- `__pycache__/`, `*.pyc`, `*.pyo`
- `.venv/`, `venv/`, `env/` — Python virtual environments
- `dist/`, `build/` — compiled/generated output
- `*.tar.gz`, `*.zip` — archives within the backup path (avoid recursive backup)

**Configurable:** Exclusions can be added or removed in the backup config. Default list follows `.gitignore` conventions. If a path in the external manifest has its own `.gitignore`, those rules are applied automatically.

### Special case: git repos in the external manifest

If a registered external path is a git repository with a remote, do **not** tarball it. Instead:

1. Record the reconstitution steps in the Lobsterfile:
   ```bash
   git clone <remote-url> <local-path>
   cd <local-path>
   git checkout <branch-or-tag>   # pin to a specific ref
   # any post-clone setup steps (npm install, etc.)
   ```
2. The backup captures only the remote URL and ref — not the working tree
3. On restore, `git clone` regenerates the repo cleanly, including history

**Why:** Tarballing a git repo gives you a snapshot without history (since `.git/` is excluded), which is worse than a fresh clone from the remote. A `git clone` is always the right reconstitution path for anything with a remote.

**Agent instruction:** When registering a git repo in the external manifest, check for a remote (`git remote -v`). If one exists, write the `git clone` entry in the Lobsterfile rather than relying on the backup tarball.

---

## Archive Directory Structure

The tarball mirrors the filesystem layout with two top-level prefixes:

```
backup-2026-03-09T03:00:00.tar.gz.age
├── meta.json                    ← OC version, timestamp, manifest checksums
├── internal/                    ← everything from ~/.openclaw/
│   ├── openclaw.json
│   ├── workspace/
│   ├── skills/
│   ├── cron/jobs.json
│   ├── identity/
│   └── ...
├── external/                    ← external manifest files, path-preserved
│   ├── etc/caddy/Caddyfile      ← was /etc/caddy/Caddyfile
│   ├── etc/systemd/system/...
│   └── var/www/...
├── lobsterfile                  ← the Lobsterfile bash script
├── lobsterfile.env              ← environment variable values
├── manifest-internal.json       ← list of files backed up from internal
└── manifest-external.json       ← list of files backed up from external
```

On restore:
- `internal/` → unpacked relative to `~/.openclaw/`
- `external/` → unpacked by prepending `/` (requires `sudo` for system paths)

---

## Bootstrapping Existing Claws

New installs maintain the Lobsterfile from day one. Existing claws — where the environment was built incrementally without logging — need a starting point.

`lobster setup` runs an **environment audit** to seed an approximate `lobsterfile.seed`:

```bash
dpkg --get-selections | grep -v deinstall   # installed apt packages
npm list -g --depth=0                       # global npm packages  
systemctl list-unit-files --state=enabled   # enabled systemd services
pip list 2>/dev/null                        # Python packages if pip present
```

`lobsterfile.seed` is clearly labeled as **inferred, not authoritative** — it captures current state, not the sequence of commands that produced it, and may include system packages that predate the claw. The agent should review it and refine over time as new changes are made with proper Lobsterfile entries.

The first backup for an existing claw is accepted to be incomplete on the environment side. Files are complete; environment reconstruction is best-effort.

---

## Lobster Scan

```bash
lobster scan [--register] [--paths /etc /var/www ~/.config]
```

Walks common system locations looking for files likely related to the OC environment and prompts the user to register relevant ones in the external manifest. Designed to catch artifacts that were installed by a human (not the agent) and were never manually registered.

**Default scan locations:**
- `/etc/` — reverse proxy configs (Caddy, nginx, Apache), cron, SSH, etc.
- `/etc/systemd/system/` and `/etc/systemd/user/` — service unit files
- `/var/www/` — web roots
- `~/.config/` — per-user app configs (ElevenLabs, Runway, etc.)
- `/home/<user>/.config/systemd/` — user-scoped systemd units
- Custom paths via `--paths`

**Scan inputs:**
1. Read `~/.openclaw/openclaw.json` for the gateway port (e.g. `18789`) and workspace path
2. Use those as primary grep targets in config files
3. Also scan for common OC-adjacent port patterns (`:8501` for Streamlit, `:18889` for secondary claws, etc.)

**Heuristics for flagging files:**
- Config files containing the gateway port or workspace path
- Service unit files that exec `node`, `openclaw`, or workspace-adjacent processes
- Caddy/nginx vhosts proxying to localhost ports used by OC or related services
- Files in `~/.config/` belonging to tools referenced in TOOLS.md

**Interactive flow:**
```
Found: /etc/caddy/Caddyfile
  → Contains proxy to localhost:8501 (Streamlit / RAG UI)
  Add to external manifest? [y/n/skip-all]

Found: /etc/systemd/system/openclaw-gateway.service
  → Systemd unit for OC gateway
  Add to external manifest? [y/n/skip-all]
```

**When to run:**
- Automatically during initial setup
- Manually at any time: `lobster scan --register`
- Recommended periodically (e.g. monthly heartbeat reminder) to catch drift — new services installed after initial setup

**What it doesn't do:**
- It does not scan running processes or installed packages (that's the Lobsterfile's job)
- It does not guarantee complete coverage — it's a heuristic aid, not an audit tool
- Unregistered files are not backed up, even if `lobster scan` missed them

---

## Tiers

### Tier 1 — Local Archive (frictionless default)
- Single command or auto-cron triggers backup
- Tarballs everything per manifests, timestamped filename
- Stored in `~/lobster-backups/` (or configurable path)
- Zero config required — install and it works

### Tier 2 — Encrypted Remote
- GPG or `age` encryption before shipping
- Supported destinations:
  - AWS S3 (primary)
  - Private GitHub repo (free, versioned)
  - Backblaze B2
  - Extensible — plugin destinations
- Config file: destination + credentials
- Auto-push on schedule or after each backup
- Pre-flight check: verify destination is not public before writing

---

## Prerequisites

Lobster Backup assumes you are starting from a provisioned environment:
- A server or machine running a supported OS
- `nvm` + Node.js installed
- OpenClaw installed and initialized (`openclaw` available on PATH)

Lobster Backup does **not** install or configure these prerequisites. If you're rebuilding from scratch after a disaster, complete these steps first, then run `lobster restore`. The Lobsterfile handles the customization layer on top of this baseline.

*(A separate "bootstrap guide" documenting the baseline setup steps is a natural companion doc but is out of scope for this project.)*

---

## Setup Script

Collects configuration at install time:

1. **Passphrase collection**
   - Prompt for a backup passphrase (entered twice to confirm)
   - Enforce minimum strength (length, not complexity theater)
   - Display clearly before proceeding:
     > ⚠️ **This passphrase cannot be recovered by anyone, including us. If you lose it and your recovery key, your backup is permanently unreadable. There is no support ticket that changes this.**
   - Generate Recovery Key, display it, require explicit acknowledgment ("I have saved this key") before continuing
   - Remind user to store the recovery key offline, separate from the server

2. **Destination configuration**
   - AWS key + S3 URL (or other destination credentials)
   - Verifies destination bucket/repo is not public (warn and abort if so)
   - Optional: sign up for freemium hosted S3 store (no AWS account needed)

3. **External dependency registration**
   - Run `lobster scan` automatically to discover candidates in common system locations
   - Present findings interactively: user confirms which to register
   - User can also manually register additional paths not found by scan

4. **Confirmation summary**
   - Show what will be backed up (internal manifest + registered externals)
   - Show destination
   - Show schedule
   - Confirm before activating

---

## Backup Script

Runs periodically (cron) or on demand:

1. Read internal + external manifests
2. Record current OC version in backup metadata
3. Refresh `lobsterfile.env` — prompt for any unset variables detected in the Lobsterfile
4. Tar up: internal files, external files, Lobsterfile, `lobsterfile.env`, manifests, backup metadata
4. Encrypt (if Tier 2)
5. Push to destination
6. Log result

Pre-flight checks before every run:
- Destination still configured and reachable
- Destination is not public (re-verify)
- Disk space sufficient for local archive

---

## Restore Script

```bash
lobster restore [--list] [--from <backup>] [--dry-run]
```

Behavior:
- `--list`: show available backups (local and/or remote) with timestamps and sizes
- `--from <backup>`: restore from a specific archive
- Default: interactive — show available backups, prompt for selection

Pre-restore checks:
1. **OC version check**: compare running OC version against the version recorded in the backup
   - If current OC is older than the backup's OC version: warn and prompt
     > ⚠️ This backup was created with OpenClaw vX.Y.Z. You are running vA.B.C. Restoring may cause compatibility issues. We recommend updating OpenClaw first. Update now? (You'll need to do this manually — run `npm install -g openclaw` then re-run restore.)
   - If current OC is newer: note it, but proceed (newer OC restoring older backup is generally safe)
2. **Existing install check**: detect existing workspace/config
   - Warn clearly before overwriting current state
   - Offer to back up current state before restoring (safety net)

Restore sequence:
1. Decrypt archive (prompt for passphrase or recovery key)
2. Run pre-restore checks (OC version, existing install)
3. User confirms
4. Restore internal files, external files, Lobsterfile, `lobsterfile.env`, manifests
5. Prompt for environment variable review (see Lobsterfile Variables)
6. Offer to display Lobsterfile for review before executing — **always offer this**; a Lobsterfile contains `sudo` commands and the user should have the opportunity to read it
7. Execute Lobsterfile bash script (runs as current user; `sudo` prefixes handle privilege escalation inline)
8. Print next steps:
   - Restart OC gateway
   - Verify services are running
   - Run `lobster scan` to check for any external artifacts not covered by the restore

**Privilege escalation model:**
- The restore script runs as the regular user throughout
- Commands requiring root are prefixed with `sudo` inside the Lobsterfile (written that way by the agent at the time of the original setup)
- The restoring user must have `sudo` access — this is a prerequisite for restore on any server that had privileged setup steps
- `sudo` logs all elevated commands to syslog, providing an audit trail of the restore operation
- Running the entire restore as root is explicitly not supported — it violates least-privilege and removes the audit benefit

---

## Delivery Format

**Recommendation: OpenClaw Skill**
- Fastest to ship
- Lives in `~/.openclaw/skills/lobster-backup/`
- Can be published to ClaWHub
- Easiest to iterate
- Propose for OC core inclusion once proven

Standalone CLI and core-ship are future options once the skill is validated.

---

## Encryption Scheme (Tier 2)

Secrets are the most sensitive content in a lobster backup — API keys, credentials, tokens. The encryption model must be zero-knowledge: the backup service (if used) can never decrypt the archive.

### Key Wrapping Model

The archive is not directly encrypted by a passphrase. Instead:

1. **Vault Key**: A random 256-bit symmetric key is generated at setup. This key actually encrypts the archive.
2. **Key Wrapping**: The Vault Key is wrapped (encrypted) by one or more user-controlled credentials. Multiple wrappers = multiple ways in, without weakening any of them.
3. **Archive header**: Stores the wrapped copies of the Vault Key, the Argon2id salt, and metadata about which wrappers exist. The raw Vault Key never leaves your machine.

### Default Wrappers

| Wrapper | How it works | When it fails |
|---|---|---|
| **Passphrase** | Argon2id(passphrase, salt) → wraps Vault Key | If passphrase is forgotten |
| **Recovery Key** | Random 256-bit key, generated once at setup | If recovery key is lost |

Having either wrapper is sufficient to decrypt. Losing both means data is unrecoverable — by design.

### Recovery Key

- Generated once at setup; displayed once
- Never stored by the backup service or on the server
- Must be written down / stored offline, separately from the server
- This step is **mandatory**, not skippable — communicated clearly at setup
- Equivalent to LastPass's rOTP concept, but device-independent (works on any machine as long as you have the key)

### Implementation

Use [`age`](https://age-encryption.org/) — the modern, audited replacement for GPG:

```bash
# Encrypt with both passphrase and recovery key as recipients
age -r <passphrase-derived-key> -r <recovery-key> -o backup.tar.gz.age backup.tar.gz
```

`age` natively supports multiple recipients; the archive is decryptable by either. No custom crypto required.

### Hosted Service (if applicable)

If a freemium hosted S3 store is offered:
- The service holds the encrypted archive and the wrapped Vault Key copies
- The service never holds the raw Vault Key, the passphrase, or the recovery key
- Zero-knowledge: a compromised service cannot decrypt user data
- No password reset mechanism — if both credentials are lost, data is gone and no support ticket changes that

---

## Backup Cadence & Retention

Default schedule (configurable):

| Tier | Frequency | Retention | Pruning |
|---|---|---|---|
| Hourly | Every hour | Last 24 backups | Drop anything older than 24h, keep one per hour |
| Daily | Once per day (midnight) | Last 7 daily snapshots | Drop anything older than 7 days, keep one per day |
| Weekly | *(optional, off by default)* | Last 4 | Keep one per week |

**How pruning works:**
- After each backup run, the backup script checks the archive list
- Hourly pass: keep the most recent 24 archives; delete older ones
- Daily pass: at midnight, promote the most recent hourly to a "daily" snapshot; prune hourly archives older than 24h
- Daily snapshots older than 7 days are deleted
- The most recent backup of each tier is always kept regardless of age

**Rationale:**
- Hourly granularity for the last day covers "I accidentally deleted something an hour ago"
- 7-day daily retention covers "something went wrong a few days ago and I didn't notice"
- Beyond 7 days, the value of versioned backups drops steeply for most use cases
- Storage cost: a workspace tarball is small (likely <50MB); 24 + 7 = 31 archives = under 2GB in the worst case

**On-demand backup:**
```bash
lobster backup --now
```
Always available regardless of schedule. Does not count against retention rotation (tagged as manual, not pruned automatically).

**Tier 2 (remote) note:**
Remote cadence can be set independently — e.g., hourly local + daily remote to minimize transfer cost. Defaults to same cadence as local if not overridden.

---

## Open Questions

*(none remaining — cadence resolved above)*
4. External manifest: how does the agent know what to register? Convention (TOOLS.md annotations?) or explicit command?
5. ClaWHub publishing — what's the process?
6. Freemium hosted S3: who runs it? MoreBetterTech/Downeaster Labs?
7. Name: "lobster-backup"? "molt-backup"? Something catchier?

---

## Status

- [ ] Finalize Lobsterfile format
- [ ] Design internal + external manifest schema
- [ ] Write setup script
- [ ] Write backup script (Tier 1 local first)
- [ ] Write restore script
- [ ] Add Tier 2 encrypted remote (S3 primary)
- [ ] Document and publish to ClaWHub
- [ ] Propose for OC core

---

*Created: 2026-03-07*
*Revised: 2026-03-09 — focused scope, integrated Sean's notes, split File Sharing and Lobster Tank to separate projects*
*Authors: David, Sean, Paul the Claw 🦞*
