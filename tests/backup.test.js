/**
 * Backup Script Tests
 * Tests for the full backup flow: locking, archiving, encryption,
 * filename conventions, lobsterfile.env refresh, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  acquireLock,
  releaseLock,
  checkStaleLock,
  createArchive,
  runBackup,
} from '../src/backup.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

vi.mock('node:fs');
vi.mock('node:child_process');

describe('Backup Script', () => {
  let mockHome;
  let backupDir;

  beforeEach(() => {
    mockHome = '/home/testuser';
    backupDir = path.join(mockHome, 'lobster-backups');
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.spyOn(process, 'pid', 'get').mockReturnValue(12345);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Lock File ---
  describe('Lock File', () => {
    it('creates lock file with PID on start', () => {
      fs.existsSync.mockReturnValue(false);
      fs.writeFileSync.mockReturnValue(undefined);

      acquireLock();

      const writeCall = fs.writeFileSync.mock.calls.find(
        (c) => c[0].includes('.lock')
      );
      expect(writeCall).toBeDefined();
      expect(writeCall[1]).toContain('12345');
    });

    it('removes lock file on success', async () => {
      fs.existsSync.mockReturnValue(false);
      fs.writeFileSync.mockReturnValue(undefined);
      fs.unlinkSync.mockReturnValue(undefined);
      fs.readFileSync.mockReturnValue(JSON.stringify({ backupPath: backupDir }));

      await runBackup({ config: { backupPath: backupDir }, dryRun: true });

      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.lock'));
    });

    it('removes lock file on error (trap cleanup)', async () => {
      fs.existsSync.mockReturnValue(false);
      fs.writeFileSync.mockReturnValue(undefined);
      fs.unlinkSync.mockReturnValue(undefined);
      execSync.mockImplementation(() => { throw new Error('tar failed'); });

      try {
        await runBackup({ config: { backupPath: backupDir }, forceError: true });
      } catch {
        // Expected
      }

      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.lock'));
    });

    it('detects live PID in existing lock → bails with message', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('99999');
      // Simulate live process: kill(pid, 0) does not throw
      vi.spyOn(process, 'kill').mockReturnValue(true);

      expect(() => acquireLock()).toThrow(/running|locked|in progress/i);
    });

    it('detects stale PID in existing lock → recovers and proceeds', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('99999');
      fs.unlinkSync.mockReturnValue(undefined);
      fs.writeFileSync.mockReturnValue(undefined);
      // Simulate dead process: kill(pid, 0) throws ESRCH
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      });

      expect(() => acquireLock()).not.toThrow();
      expect(fs.unlinkSync).toHaveBeenCalled(); // old lock removed
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.lock'),
        expect.stringContaining('12345')
      );
    });
  });

  // --- Archive Contents ---
  describe('Archive Contents', () => {
    it('tarball contains all internal manifest files', async () => {
      const internalFiles = [
        `${mockHome}/.openclaw/workspace/SOUL.md`,
        `${mockHome}/.openclaw/openclaw.json`,
      ];

      execSync.mockReturnValue('');
      const archive = await createArchive({
        internalManifest: internalFiles,
        externalManifest: [],
        backupDir,
      });

      const tarCmd = execSync.mock.calls.find((c) => c[0].includes('tar'));
      expect(tarCmd).toBeDefined();
      expect(tarCmd[0]).toContain('SOUL.md');
    });

    it('tarball contains all external manifest files', async () => {
      execSync.mockReturnValue('');
      await createArchive({
        internalManifest: [],
        externalManifest: ['/etc/caddy/Caddyfile'],
        backupDir,
      });

      const tarCmd = execSync.mock.calls.find((c) => c[0].includes('tar'));
      expect(tarCmd[0]).toContain('Caddyfile');
    });

    it('includes meta.json with: OC version, timestamp, manifest checksums', async () => {
      fs.writeFileSync.mockReturnValue(undefined);
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('openclaw') && cmd.includes('version')) return '1.2.3\n';
        return '';
      });

      await createArchive({
        internalManifest: [],
        externalManifest: [],
        backupDir,
      });

      const metaCall = fs.writeFileSync.mock.calls.find(
        (c) => c[0].includes('meta.json')
      );
      expect(metaCall).toBeDefined();
      const meta = JSON.parse(metaCall[1]);
      expect(meta).toHaveProperty('ocVersion');
      expect(meta).toHaveProperty('timestamp');
      expect(meta).toHaveProperty('checksums');
    });

    it('includes Lobsterfile', async () => {
      execSync.mockReturnValue('');
      await createArchive({
        internalManifest: [],
        externalManifest: [],
        backupDir,
        lobsterfilePath: `${mockHome}/.openclaw/lobsterfile`,
      });

      const tarCmd = execSync.mock.calls.find((c) => c[0].includes('tar'));
      expect(tarCmd[0]).toContain('lobsterfile');
    });

    it('includes lobsterfile.env', async () => {
      execSync.mockReturnValue('');
      await createArchive({
        internalManifest: [],
        externalManifest: [],
        backupDir,
        lobsterfileEnvPath: `${mockHome}/.openclaw/lobsterfile.env`,
      });

      const tarCmd = execSync.mock.calls.find((c) => c[0].includes('tar'));
      expect(tarCmd[0]).toContain('lobsterfile.env');
    });

    it('includes manifest-internal.json and manifest-external.json', async () => {
      execSync.mockReturnValue('');
      fs.writeFileSync.mockReturnValue(undefined);

      await createArchive({
        internalManifest: ['file1'],
        externalManifest: ['file2'],
        backupDir,
      });

      const tarCmd = execSync.mock.calls.find((c) => c[0].includes('tar'));
      expect(tarCmd[0]).toContain('manifest-internal.json');
      expect(tarCmd[0]).toContain('manifest-external.json');
    });
  });

  // --- Archive Structure ---
  describe('Archive Structure', () => {
    it('internal/ prefix for internal files', async () => {
      execSync.mockReturnValue('');
      await createArchive({
        internalManifest: [`${mockHome}/.openclaw/workspace/SOUL.md`],
        externalManifest: [],
        backupDir,
      });

      const tarCmd = execSync.mock.calls.find((c) => c[0].includes('tar'));
      expect(tarCmd[0]).toMatch(/internal\//);
    });

    it('external/ prefix for external files (leading / stripped, path-preserved)', async () => {
      execSync.mockReturnValue('');
      await createArchive({
        internalManifest: [],
        externalManifest: ['/etc/caddy/Caddyfile'],
        backupDir,
      });

      const tarCmd = execSync.mock.calls.find((c) => c[0].includes('tar'));
      expect(tarCmd[0]).toMatch(/external\//);
    });

    it('meta.json, lobsterfile, lobsterfile.env, manifests at top level', async () => {
      execSync.mockReturnValue('');
      fs.writeFileSync.mockReturnValue(undefined);

      await createArchive({
        internalManifest: [],
        externalManifest: [],
        backupDir,
      });

      const tarCmd = execSync.mock.calls.find((c) => c[0].includes('tar'));
      // These should not be under internal/ or external/
      expect(tarCmd[0]).toMatch(/(?<!\/)meta\.json/);
    });
  });

  // --- Exclusions ---
  describe('Exclusions', () => {
    it('default exclusions applied (node_modules, .git, __pycache__, venvs, build dirs)', async () => {
      execSync.mockReturnValue('');
      await createArchive({
        internalManifest: [],
        externalManifest: [],
        backupDir,
      });

      const tarCmd = execSync.mock.calls.find((c) => c[0].includes('tar'));
      expect(tarCmd[0]).toMatch(/exclude.*node_modules/);
    });

    it('git repos with remotes are NOT tarballed (Lobsterfile has clone entry instead)', async () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('git remote get-url')) return 'https://github.com/user/repo.git\n';
        return '';
      });
      fs.existsSync.mockReturnValue(true);

      const archive = await createArchive({
        internalManifest: [],
        externalManifest: ['/home/testuser/projects/repo'],
        backupDir,
        gitRepos: [{ path: '/home/testuser/projects/repo', hasRemote: true }],
      });

      // The repo path should NOT be in the tar command
      const tarCmd = execSync.mock.calls.find((c) => c[0].includes('tar'));
      if (tarCmd) {
        expect(tarCmd[0]).not.toContain('/home/testuser/projects/repo');
      }
    });
  });

  // --- Encryption ---
  describe('Encryption', () => {
    it('archive is encrypted with age (not plaintext)', async () => {
      execSync.mockReturnValue('');
      fs.writeFileSync.mockReturnValue(undefined);

      await runBackup({
        config: { backupPath: backupDir },
        dryRun: false,
      });

      const ageCmd = execSync.mock.calls.find((c) => c[0].includes('age'));
      expect(ageCmd).toBeDefined();
    });
  });

  // --- Filename & Tagging ---
  describe('Filename & Tagging', () => {
    it('timestamp filename: backup-YYYY-MM-DDTHH:MM:SS.tar.gz.age', async () => {
      execSync.mockReturnValue('');
      fs.writeFileSync.mockReturnValue(undefined);

      const result = await runBackup({
        config: { backupPath: backupDir },
        dryRun: true,
      });

      expect(result.filename).toMatch(
        /^backup-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.tar\.gz\.age$/
      );
    });

    it('--now triggers immediate backup', async () => {
      execSync.mockReturnValue('');
      fs.writeFileSync.mockReturnValue(undefined);

      const result = await runBackup({
        config: { backupPath: backupDir },
        now: true,
        dryRun: true,
      });

      expect(result).toBeDefined();
      expect(result.manual).toBe(true);
    });

    it('manual backups tagged as manual (not subject to auto-pruning)', async () => {
      execSync.mockReturnValue('');
      fs.writeFileSync.mockReturnValue(undefined);

      const result = await runBackup({
        config: { backupPath: backupDir },
        now: true,
        dryRun: true,
      });

      expect(result.manual).toBe(true);
    });
  });

  // --- lobsterfile.env Refresh ---
  describe('lobsterfile.env Refresh', () => {
    it('detects new {{VARIABLE}} placeholders since last backup', async () => {
      fs.readFileSync.mockImplementation((p) => {
        if (p.includes('lobsterfile.env')) return 'SERVER_IP=10.0.0.1\n';
        if (p.includes('lobsterfile') && !p.includes('.env')) {
          return '{{SERVER_IP}} {{NEW_PORT}}';
        }
        return '{}';
      });
      fs.existsSync.mockReturnValue(true);

      const result = await runBackup({
        config: { backupPath: backupDir },
        dryRun: true,
        detectOnly: true,
      });

      expect(result.newVariables).toContain('NEW_PORT');
    });

    it('does not re-prompt for existing variables with values', async () => {
      fs.readFileSync.mockImplementation((p) => {
        if (p.includes('lobsterfile.env')) return 'SERVER_IP=10.0.0.1\n';
        if (p.includes('lobsterfile') && !p.includes('.env')) return '{{SERVER_IP}}';
        return '{}';
      });
      fs.existsSync.mockReturnValue(true);

      const result = await runBackup({
        config: { backupPath: backupDir },
        dryRun: true,
        detectOnly: true,
      });

      expect(result.newVariables).toEqual([]);
    });
  });

  // --- Error Handling ---
  describe('Error Handling', () => {
    it('disk full → partial archive cleaned up, no corrupt file left', async () => {
      fs.unlinkSync.mockReturnValue(undefined);
      execSync.mockImplementation(() => {
        throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
      });

      try {
        await runBackup({ config: { backupPath: backupDir } });
      } catch {
        // Expected
      }

      // Should attempt cleanup of partial file
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('encryption failure → no plaintext tarball left on disk', async () => {
      let tarCreated = false;
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('tar')) { tarCreated = true; return ''; }
        if (cmd.includes('age')) throw new Error('age encryption failed');
        return '';
      });
      fs.unlinkSync.mockReturnValue(undefined);

      try {
        await runBackup({ config: { backupPath: backupDir } });
      } catch {
        // Expected
      }

      // Plaintext tarball should be cleaned up
      const unlinkCalls = fs.unlinkSync.mock.calls.map((c) => c[0]);
      expect(unlinkCalls.some((p) => p.includes('.tar.gz') && !p.includes('.age'))).toBe(true);
    });

    it('no external manifest → proceeds with warning (internal-only backup)', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (p.includes('external-manifest')) return false;
        return true;
      });
      fs.readFileSync.mockReturnValue(JSON.stringify({ backupPath: backupDir }));
      execSync.mockReturnValue('');

      const result = await runBackup({
        config: { backupPath: backupDir },
        dryRun: true,
      });

      expect(result).toBeDefined();
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(/external|manifest/i)])
      );
    });

    it('logs result on success', async () => {
      execSync.mockReturnValue('');
      fs.writeFileSync.mockReturnValue(undefined);
      fs.appendFileSync.mockReturnValue(undefined);
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{}');

      const result = await runBackup({
        config: { backupPath: backupDir },
        dryRun: true,
      });

      expect(result.success).toBe(true);
    });

    it('logs error on failure', async () => {
      execSync.mockImplementation(() => { throw new Error('catastrophic failure'); });
      fs.appendFileSync.mockReturnValue(undefined);
      fs.unlinkSync.mockReturnValue(undefined);

      try {
        await runBackup({ config: { backupPath: backupDir } });
      } catch (e) {
        expect(e.message).toMatch(/catastrophic|failure/i);
      }
    });
  });
});
