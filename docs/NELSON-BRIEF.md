# Nelson's Build Brief — lobster-backup v1

Hello Nelson. You're being asked to build the first version of `lobster-backup`, an OpenClaw skill that backs up and restores a lobster's state. The spec, design decisions, and context are all in a public GitHub repo. This document tells you where to look, what to build, and what to ask Paul (me) when you're done.

---

## Who You Are and What This Is

You're Nelson, an OpenClaw agent. Paul the Claw (another OC agent, running on a different server) designed the spec for this project. Sean and David (the humans) drove the design. You're building v1.

This is a real skill intended to be published to ClaWHub. It should work on any OpenClaw install, not just ours.

---

## Start Here: Read These First

Clone or browse the repo: **https://github.com/MoreBetterTech/lobster-backup**

Read in this order:

1. **`projects/lobster-backup/SESSION-NOTES.md`** — Read this first. It's the "why" behind everything in the spec: key decisions, rejected alternatives, open threads, and context that doesn't fit in a formal spec. Start here before touching PLAN.md or you'll be confused about some choices.

2. **`projects/lobster-backup/PLAN.md`** — The full spec. Once you've read SESSION-NOTES, this will make sense. Pay close attention to:
   - The Lobsterfile section (structural memory — critical concept)
   - The Lobsterfile Variables section (environment portability — tricky)
   - The `lobster scan` section (heuristic discovery)
   - The Encryption Scheme section (`age` + key wrapping)
   - The Setup Script, Backup Script, and Restore Script sections

---

## What to Build (v1 Scope)

**Build these, in order:**

### 1. Setup Script
`lobster setup`
- Collect and validate passphrase (min length, confirm twice)
- Generate Vault Key
- Generate Recovery Key, display it once, require acknowledgment
- Collect backup destination (local path to start; S3 later)
- Run `lobster scan` to discover external artifacts
- Write `lobsterfile.env` with current environment variables
- Write `~/.openclaw/lobster-backup.json` config file
- Print confirmation summary before activating

### 2. `lobster scan`
`lobster scan [--register] [--paths ...]`
- Walk `/etc/`, `/etc/systemd/`, `/var/www/`, `~/.config/` (and any `--paths`)
- Heuristics: OC port references, gateway URLs, systemd units for OC-adjacent processes, Caddy/nginx proxy configs for localhost ports
- Interactive: show each finding, ask user to register or skip
- Update external manifest at `~/.openclaw/lobster-external-manifest.json`

### 3. Backup Script (Tier 1 — local only)
`lobster backup [--now]`
- Read internal manifest (hardcoded list from spec) + external manifest
- Record current OC version in backup metadata (`openclaw --version`)
- Refresh `lobsterfile.env` (prompt for any new unset variables)
- Tar up everything: workspace, skills, OC config, cron exports, external files, Lobsterfile, `lobsterfile.env`, manifests, metadata
- Encrypt with `age` using passphrase key (Tier 1 = passphrase only, no remote push yet)
- Store in `~/lobster-backups/` with timestamp filename
- Prune: keep last 24 hourly, last 7 daily snapshots
- Log result

### 4. Restore Script
`lobster restore [--list] [--from <backup>] [--dry-run]`
- `--list`: show available backups with timestamps and sizes
- Default: interactive selection
- Check OC version in backup vs. current; warn if backup is newer
- Check for existing install; warn before overwriting; offer to back up current state first
- Decrypt archive (prompt for passphrase or recovery key)
- Display Lobsterfile for review (ALWAYS offer this before executing)
- Prompt for environment variable review (`lobsterfile.env`)
- Restore files
- Execute Lobsterfile (runs as current user; `sudo` prefixes handle escalation)
- Print next steps

---

## What NOT to Build in v1

- **Tier 2 (remote/S3 push)** — out of scope. The spec has it, but skip it for now. Get Tier 1 solid first.
- **Hosted service** (Lambda, database, user management) — totally out of scope, separate project.
- **Recovery Key + key wrapping** — the full key-wrapping model (two wrapped copies of the Vault Key) can be simplified for v1: encrypt with passphrase directly using `age`. Add recovery key as a second recipient in v1.1. Don't let crypto complexity block shipping.

---

## Technical Constraints

- **Delivery format:** OpenClaw skill. Should live in `~/.openclaw/skills/lobster-backup/` and be installable via `openclaw skills install`.
- **Encryption:** Use `age` (https://age-encryption.org/). It's standard, audited, handles multiple recipients cleanly. Do not invent crypto.
- **Privilege escalation:** The scripts run as the current user. Commands that need root are prefixed with `sudo` in the Lobsterfile (written there by the agent at setup time). Never run the restore script as root.
- **No hardcoded paths:** Everything should use configurable paths, not assumptions about `/home/ubuntu/`.
- **OC version detection:** Use `openclaw --version` or read from the OC package.json if the CLI doesn't support it.

---

## Where to Push

Push your work to a branch in the same repo: **https://github.com/MoreBetterTech/lobster-backup**

Branch name: `feature/lobster-backup-v1`

When you're done (or at a reasonable milestone), open a PR. Paul will review.

If you don't have push access, let Sean or David know — they'll add your GitHub account.

---

## How to Ask Paul for Review

When you're ready for review, post in the `#general` Slack channel:

> "Hey @PaulTheClaw — lobster-backup v1 is ready for review. PR here: [link]. Here's what I built / what I skipped / what I'm unsure about."

Paul will read the PR, test it on his setup, and give feedback. Be specific about what you want reviewed — the whole thing, a specific script, the Lobsterfile design, whatever.

---

## What Success Looks Like

At the end of v1:

1. `lobster setup` runs cleanly on a fresh OC install, collects config, produces a working backup
2. `lobster backup` produces an encrypted archive in `~/lobster-backups/`
3. `lobster restore` decrypts it and puts everything back where it was
4. The Lobsterfile executes cleanly (with `sudo` for privileged steps)
5. Environment variables are prompted on restore if the environment changed
6. It works on at least two different machines/users (Paul + Nellie on the same server, or Paul + Nelson on different servers)

---

*Written by Paul the Claw 🦞, 2026-03-09*
*If anything in here contradicts PLAN.md, trust PLAN.md. If anything contradicts SESSION-NOTES.md reasoning, ask.*
