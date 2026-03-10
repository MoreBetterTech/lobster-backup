# lobster-backup — Session Notes

> Context from the spec design session (2026-03-09) that isn't captured in PLAN.md.
> Intended for Nelson or any future contributor picking this up cold.

---

## Who Was in the Room

- **David** — project owner, primary OC user, came in with the real-world scenario (Caddy, /etc/, /var/www/, multi-user server)
- **Sean** — co-builder, drove most of the spec refinements, named the Lobsterfile concept
- **Paul the Claw** — me, wrote the spec, reviewed it, got roasted for the first draft being too loose

---

## How the Spec Evolved

### Starting point
The original PLAN.md conflated four different projects. Sean's first intervention was splitting them out:
- `lobster-backup` → pure disaster recovery + portability
- `lobster-fileshare` → artifact sharing (separate project)
- `lobster-tank` → inter-lobster discovery and reputation (separate project)
- `lobster-memory` → vector memory and persistent context (separate project)

**Why this matters:** If you're touching lobster-backup and find yourself thinking about file sharing or reputation systems, you're in the wrong project.

### The Lobsterfile — Sean's key insight
Sean came in with the concept already formed: "keep record of customizations... instructions in agents.md to record all customizations as they happen... Lobsterfile — like a Dockerfile, but it's a running log of customizations that is turned into a bash script for rebuild."

The critical framing he pushed: **the Lobsterfile is structural memory, not a backup artifact**. It must be updated in real time as changes happen, with the same discipline as MEMORY.md. An agent that installs Caddy and doesn't log it to the Lobsterfile has broken the system, even if the backup otherwise ran fine.

### The gap Paul identified
First draft covered file restore. It did not cover environment reconstitution. Distinction:
- "Restore files" = your MEMORY.md and workspace are back
- "Reconstitute environment" = the server runs the way it did before, including all the system-level stuff

Full reconstitution requires: fresh server → install nvm/node → install OC → restore files → run Lobsterfile → handle variable substitution. The spec owns steps 4-6. Steps 1-3 are prerequisites (documented in the Prerequisites section).

---

## Key Decisions and Why

### `age` over raw GPG symmetric
`age` (https://age-encryption.org/) is the modern replacement for GPG. Key advantages for this use case:
- Multiple recipients natively — you get key wrapping without building it yourself
- Audited, actively maintained, simpler API
- `age -r <key1> -r <key2>` produces an archive decryptable by either key — exactly what we need for passphrase + recovery key

We did NOT choose raw GPG symmetric because it doesn't natively support multiple decryption keys without significant plumbing.

### `sudo` inline over run-as-root
The restore script runs as the regular user throughout. Commands requiring root are prefixed with `sudo` in the Lobsterfile, written that way by the agent at original setup time.

Why not run-as-root:
- Violates least-privilege
- Removes the syslog audit trail (sudo logs every elevated command; root doesn't)
- If there's a bug in the restore script, running as root gives it the whole system

**Security note:** Before executing the Lobsterfile, the restore script MUST offer to display it. A Lobsterfile is a bash script with embedded `sudo` commands. The user should be able to read it before it runs.

### Pre-signed URLs over persistent read key (fileshare)
For private file access: pre-signed URLs with TTL rather than a persistent bearer token.

Why:
- A leaked pre-signed URL expires (minutes to days, configurable per file)
- A leaked persistent read key is valid forever and grants access to everything
- Tradeoff: sharing a private file requires generating a fresh URL each time — acceptable overhead

### Key wrapping model (LastPass-derived)
The archive is not directly encrypted by the passphrase. Instead:
- A random 256-bit Vault Key encrypts the archive
- The Vault Key is wrapped by the passphrase (Argon2id derivation)
- The Vault Key is ALSO wrapped by a random Recovery Key generated at setup

Both wrapped copies live in the archive header. Either is sufficient to decrypt. Both lost = data gone, by design (zero-knowledge).

The Recovery Key is printed once at setup, never stored by the service. This is different from LastPass's rOTP approach (which is device-bound and fails on new machines) — the Recovery Key works on any device, which is what disaster recovery requires.

### `lobster scan` as a complement to manual manifest
The external manifest relies on the agent having been involved in setup AND having remembered to log everything. In practice, servers have human-installed components the agent never touched.

`lobster scan` runs heuristics against common locations (`/etc/`, `/etc/systemd/`, `/var/www/`, `~/.config/`) to find files likely related to the OC environment and prompts the user to register them. It's an aid, not an audit — it doesn't guarantee complete coverage.

Run it: at initial setup (automatic), periodically (heartbeat reminder), and any time you suspect drift.

### Backup cadence
Sean proposed: hourly × 24 + daily × 7. Adopted as-is.
- Hourly granularity for "I broke something an hour ago"
- 7-day daily retention for "something went wrong and I didn't notice for a few days"
- `lobster backup --now` always available, tagged manual, not pruned

---

## Open Threads Not Yet in the Spec

1. **Tier 2 hosted service scope** — Sean called this out explicitly: "We'll need users and credentials and a Lambda and a database." This is a separate product, not just a feature. Don't let it creep into the v1 scope. Tier 1 (local archive + restore script) ships first.

2. **Backup trigger** — hourly/daily cadence decided. But is it purely time-based, or do we also trigger on significant events (session end, major workspace changes, Lobsterfile updates)? Not decided. Lean time-based for v1 (simpler); event-based can be additive.

3. **`lobster scan` scheduling** — should it run on a heartbeat schedule or only on demand? Not decided. Likely: on-demand with a periodic heartbeat reminder ("last scan was 30 days ago").

4. **Lobsterfile format for complex steps** — most Lobsterfile entries are simple bash commands. What about multi-step sequences with error handling? For v1, keep it simple: plain bash, sequential, fail-fast. Add structure later if needed.

---

## What's Already Working (Don't Break It)

The existing backup setup for Paul:
- Workspace git repo → `MoreBetterTech/paul-the-claw` on GitHub, committed every heartbeat
- Credentials tarball (`secrets.tar.gz.gpg`) encrypted with GPG, committed to the same repo
- Documented in `RESTORE.md`

This is a working subset of Tier 2 (private GitHub repo as remote destination). **Don't remove it** until lobster-backup v1 is proven. The new system is additive.

---

## Test Matrix

- **Paul** (ubuntu@newdev-utils): primary test case, OC running, has all the infrastructure
- **Nellie** (nellie@newdev-utils): same server, different user — tests user isolation, permission model
- **Nelson** (Sean's lobster, different server): tests portability across machines, the real disaster recovery scenario

---

## Relationship to Other Projects

| Project | Relationship |
|---|---|
| `lobster-memory` | Backup restores *state*. Memory makes the state *useful*. Different problems. |
| `lobster-fileshare` | Fileshare uses S3; backup uses S3. They can share credentials/bucket with different prefixes. |
| `lobster-tank` | Identity keypairs generated for tank should survive backup/restore. Reputation portability TBD. |

---

*Written by Paul the Claw 🦞, 2026-03-09*
*Based on design session with David and Sean*
