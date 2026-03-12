# lobster-backup 🦞

> *"Your lobster has a memory. Don't let it drown."*

A backup and restore system for [OpenClaw](https://openclaw.ai) agents. Protects your agent's identity, memory, workspace, skills, and system-level customizations — and can rebuild the full environment from scratch.

Works on existing installs (retroactive) and fresh ones (from day one).

---

## What It Protects

**Your agent accumulates real value over time.** Months of curated memory, a tuned personality, custom skills, environment configurations. lobster-backup protects all of it:

| What | Where it lives | How it's backed up |
|---|---|---|
| Identity & personality | `SOUL.md`, `IDENTITY.md`, `USER.md` | File backup (internal manifest) |
| Memory & context | `MEMORY.md`, `memory/*.md`, `memory/*.json` | File backup (internal manifest) |
| Agent config | `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md` | File backup (internal manifest) |
| Gateway config | `openclaw.json` | File backup (internal manifest) |
| Skills | `~/.openclaw/skills/` | File backup (internal manifest) |
| Cron jobs | `~/.openclaw/cron/jobs.json` | File backup (internal manifest) |
| Agent identity/keys | `~/.openclaw/identity/` | File backup (internal manifest) |
| System configs | `/etc/caddy/`, systemd units, etc. | File backup (external manifest) |
| Environment setup | Packages, services, configs | Lobsterfile (bash rebuild script) |
| Git repositories | Repos with remotes | `git clone` in Lobsterfile (not tarballed) |

## How It Works

lobster-backup has two complementary layers:

1. **File backup** — tarballs your workspace and registered system files, encrypted with `age`
2. **The Lobsterfile** — a running log of every system change your agent makes, turned into an executable bash script for rebuild

Together they give you complete disaster recovery: files + environment. A tarball alone restores data. The Lobsterfile restores the *machine*.

---

## Prerequisites

Before installing lobster-backup, you need:
- A server or machine running a supported OS (Linux/macOS)
- Node.js installed (v18+)
- OpenClaw installed and initialized (`openclaw` on PATH)

lobster-backup does **not** install these prerequisites. If rebuilding from scratch after a disaster, set up Node.js and OpenClaw first, then run `lobster restore`.

---

## Quick Start

### Install

```bash
cd ~/.openclaw/skills
git clone https://github.com/MoreBetterTech/lobster-backup.git
cd lobster-backup
npm install
```

### First-Time Setup

```bash
lobster setup
```

This will:
1. Ask for a backup passphrase (used to encrypt archives)
2. Generate and display a **Recovery Key** — save this offline, it cannot be recovered
3. Scan your system for OC-related config files (`lobster scan`)
4. Show a summary and ask for confirmation
5. Print an AGENTS.md snippet to add to your agent's instructions

### Backup

Backups run automatically on schedule (hourly by default), or on demand:

```bash
lobster backup --now
```

### Restore

```bash
lobster restore              # Interactive — pick from available backups
lobster restore --list       # Show available backups with timestamps and sizes
lobster restore --from <path> # Restore a specific archive
lobster restore --dry-run    # Preview what would be restored
```

The restore flow:
1. Decrypt archive (passphrase or Recovery Key)
2. Pre-flight checks (OC version compatibility, existing install detection)
3. Restore files to `~/.openclaw/` and registered system paths
4. Review Lobsterfile (mandatory — it contains `sudo` commands)
5. Execute Lobsterfile to rebuild the environment
6. Print next steps

### Scan for Unregistered Dependencies

```bash
lobster scan                 # Find OC-related files not yet in the backup
lobster scan --register      # Find and register in one step
lobster scan --paths /custom # Scan additional locations
```

---

## The Lobsterfile

The Lobsterfile is the key innovation. It's a bash script that records every system change your agent makes — package installs, service configuration, firewall rules, config file writes.

**It's structural memory.** Maintained in real time, not generated at backup time.

```bash
#!/bin/bash
# Lobsterfile — system environment rebuild script

sudo apt-get install -y caddy
cat > /etc/caddy/Caddyfile <<EOF
{{DOMAIN_NAME}} {
    reverse_proxy localhost:{{GATEWAY_PORT}}
}
EOF
sudo systemctl enable caddy
sudo systemctl reload caddy
```

### Variables

Environment-specific values use `{{VARIABLE}}` placeholders. Values are stored in `lobsterfile.env`:

```bash
# lobsterfile.env
DOMAIN_NAME=example.com
GATEWAY_PORT=18789
```

On restore to a **new environment** (different server, new IP), the restore script prompts you to update any values that have changed.

### For Existing Installs

If your agent has been running without lobster-backup, `lobster setup` runs an environment audit to generate a `lobsterfile.seed` — an approximate starting point based on currently installed packages and enabled services. It's clearly labeled as **inferred, not authoritative**. Refine it over time as your agent makes new changes with proper Lobsterfile entries.

---

## Encryption

Backups are encrypted with [`age`](https://age-encryption.org/) using a zero-knowledge key wrapping model:

- A random **Vault Key** encrypts the archive
- The Vault Key is wrapped (encrypted) by your **passphrase** via Argon2id
- The Vault Key is also wrapped by your **Recovery Key**
- Either credential is sufficient to decrypt
- **Both lost = data permanently unrecoverable.** By design. No backdoor.

This means:
- Your passphrase never touches the archive directly
- Changing your passphrase doesn't require re-encrypting the archive
- A hosted backup service (Tier 2, future) could never decrypt your data

---

## Backup Schedule & Retention

| Tier | Frequency | Kept |
|---|---|---|
| Hourly | Every hour | Last 24 |
| Daily | Midnight | Last 7 |
| Manual (`--now`) | On demand | Never auto-pruned |

**Total storage:** ~31 archives max. For a typical workspace (<50MB), that's under 2GB.

---

## Project Structure

```
lobster-backup/
├── src/
│   ├── cli.js             — Argument parsing
│   ├── config.js          — Config read/write/validate
│   ├── crypto.js          — Key generation, Argon2id, age encryption
│   ├── manifest.js        — Internal + external manifest management
│   ├── lobsterfile.js     — Lobsterfile parsing and validation
│   ├── lobsterfile-env.js — Variable substitution
│   ├── scan.js            — System file scanner
│   ├── setup.js           — Interactive setup flow
│   ├── backup.js          — Backup orchestration + locking
│   ├── pruning.js         — Retention policy enforcement
│   └── restore.js         — Restore orchestration
├── tests/                 — 19 test files, 216 test cases (Vitest)
├── docs/
│   ├── PLAN.md            — Full specification
│   ├── SESSION-NOTES.md   — Design decisions and reasoning
│   ├── NELSON-BRIEF.md    — Build brief
│   └── TEST-CATALOGUE.md  — Test catalogue
└── package.json
```

## Running Tests

```bash
npm install
npm test          # or: npx vitest run
```

All 216 tests should pass. Tests are structured as TDD — they define the interfaces that `src/` modules implement.

---

## Roadmap

- [x] Spec and design (PLAN.md)
- [x] Test catalogue (216 cases)
- [x] Phase 1: Foundation modules (config, manifest, lobsterfile, crypto)
- [x] Phase 2: Setup + Scan + CLI
- [x] Phase 3: Backup + Pruning
- [x] Phase 4: Restore
- [x] Intent documentation (teleologic comments)
- [ ] CLI entry point (`bin/lobster`)
- [ ] OC skill packaging (`SKILL.md`)
- [ ] Integration testing on real OC installs
- [ ] Tier 2: Encrypted remote storage (S3, GitHub, B2)
- [ ] ClaWHub publishing
- [ ] Propose for OC core inclusion

---

## Design Philosophy

- **Files restore data. The Lobsterfile restores the machine.** Both are needed for full recovery.
- **Zero-knowledge encryption.** No backdoors. Lost credentials = lost data. That's a feature.
- **Lobsterfile review is mandatory.** It contains `sudo` commands. Humans review before execution.
- **The agent maintains the Lobsterfile in real time.** It's structural memory, not a backup artifact.
- **Heuristics aid, not audit.** `lobster scan` catches common cases. It doesn't guarantee coverage.
- **Fail loudly.** Missing variables throw errors. Broken checksums abort. Silent failures are worse than crashes.

---

## Authors

David, Sean, Paul the Claw 🦞, and Nelson 🦞

Built by [MoreBetterTech](https://github.com/MoreBetterTech) / Downeaster Labs

---

## License

TBD
