/**
 * Backup Script Tests
 * Tests for the full backup flow: locking, archiving, encryption,
 * filename conventions, lobsterfile.env refresh, and error handling.
 * 
 * Archive creation now uses a staging directory + execFileSync('tar', [...args])
 * instead of building shell command strings. Tests verify file staging and
 * execFileSync calls instead of parsing tar command strings.
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
import { execSync, execFileSync } from 'node:child_process';

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
    // Default mocks for archive creation
    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockReturnValue(undefined);
    fs.writeFileSync.mockReturnValue(undefined);
    fs.copyFileSync.mockReturnValue(undefined);
    // Return a string by default (acquireLock calls .trim() on it)
    // Individual tests that need Buffer can override
    fs.readFileSync.mockReturnValue('{}');
    fs.rmSync.mockReturnValue(undefined);
    fs.unlinkSync.mockReturnValue(undefined);
    execSync.mockReturnValue('unknown');
    execFileSync.mockReturnValue('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Lock File ---
  describe('Lock File', () => {
    it('creates lock file with PID on start', () => {
      fs.existsSync.mockReturnValue(false);

      acquireLock();

      const writeCall = fs.writeFileSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('.lock')
      );
      expect(writeCall).toBeDefined();
      expect(writeCall[1]).toContain('12345');
    });

    it('removes lock file on success', async () => {
      fs.existsSync.mockReturnValue(false);

      await runBackup({ config: { backupPath: backupDir }, dryRun: true });

      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.lock'));
    });

    it('removes lock file on error (trap cleanup)', async () => {
      fs.existsSync.mockReturnValue(false);
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
      vi.spyOn(process, 'kill').mockReturnValue(true);

      expect(() => acquireLock()).toThrow(/running|locked|in progress/i);
    });

    it('detects stale PID in existing lock → recovers and proceeds', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('99999');
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      });

      expect(() => acquireLock()).not.toThrow();
      expect(fs.unlinkSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.lock'),
        expect.stringContaining('12345')
      );
    });
  });

  // --- Archive Contents ---
  describe('Archive Contents', () => {
    it('internal files are staged (copied) into temp dir under internal/', async () => {
      const internalFiles = [
        `${mockHome}/.openclaw/workspace/SOUL.md`,
        `${mockHome}/.openclaw/openclaw.json`,
      ];

      await createArchive({
        internalManifest: internalFiles,
        externalManifest: [],
        backupDir,
      });

      // Files should be staged via copyFileSync into internal/ subdirectory
      const copyCalls = fs.copyFileSync.mock.calls.map((c) => ({ src: c[0], dest: c[1] }));
      expect(copyCalls.some((c) => c.src.includes('SOUL.md') && c.dest.includes('internal/'))).toBe(true);
      expect(copyCalls.some((c) => c.src.includes('openclaw.json') && c.dest.includes('internal/'))).toBe(true);
    });

    it('external files are staged (copied) into temp dir under external/', async () => {
      await createArchive({
        internalManifest: [],
        externalManifest: ['/etc/caddy/Caddyfile'],
        backupDir,
      });

      const copyCalls = fs.copyFileSync.mock.calls.map((c) => ({ src: c[0], dest: c[1] }));
      expect(copyCalls.some((c) => c.src.includes('Caddyfile') && c.dest.includes('external/'))).toBe(true);
    });

    it('includes meta.json with: OC version, timestamp, per-file checksums', async () => {
      execSync.mockImplementation((cmd) => {
        if (typeof cmd === 'string' && cmd.includes('openclaw') && cmd.includes('version')) return '1.2.3\n';
        return '';
      });

      await createArchive({
        internalManifest: [],
        externalManifest: [],
        backupDir,
      });

      const metaCall = fs.writeFileSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('meta.json')
      );
      expect(metaCall).toBeDefined();
      const meta = JSON.parse(metaCall[1]);
      expect(meta).toHaveProperty('ocVersion');
      expect(meta).toHaveProperty('timestamp');
      expect(meta).toHaveProperty('checksums');
      expect(meta).toHaveProperty('formatVersion', 1);
      // Checksums should be an object (not placeholder strings)
      expect(typeof meta.checksums).toBe('object');
      expect(meta.checksums.internal).toBeUndefined(); // no flat 'internal' key
    });

    it('includes Lobsterfile via copyFileSync staging', async () => {
      await createArchive({
        internalManifest: [],
        externalManifest: [],
        backupDir,
        lobsterfilePath: `${mockHome}/.openclaw/lobsterfile`,
      });

      const copyCalls = fs.copyFileSync.mock.calls;
      const lobsterfileCopy = copyCalls.find(
        (c) => c[0].includes('lobsterfile') && !c[0].includes('.env') && c[1].includes('lobsterfile')
      );
      expect(lobsterfileCopy).toBeDefined();
    });

    it('includes lobsterfile.env via copyFileSync staging', async () => {
      await createArchive({
        internalManifest: [],
        externalManifest: [],
        backupDir,
        lobsterfileEnvPath: `${mockHome}/.openclaw/lobsterfile.env`,
      });

      const copyCalls = fs.copyFileSync.mock.calls;
      const envCopy = copyCalls.find((c) => c[0].includes('lobsterfile.env'));
      expect(envCopy).toBeDefined();
    });

    it('writes manifest-internal.json and manifest-external.json', async () => {
      await createArchive({
        internalManifest: ['file1'],
        externalManifest: ['file2'],
        backupDir,
      });

      const writeCalls = fs.writeFileSync.mock.calls.map((c) => c[0]);
      expect(writeCalls.some((p) => typeof p === 'string' && p.includes('manifest-internal.json'))).toBe(true);
      expect(writeCalls.some((p) => typeof p === 'string' && p.includes('manifest-external.json'))).toBe(true);
    });
  });

  // --- Archive Structure ---
  describe('Archive Structure', () => {
    it('internal files staged under internal/ directory', async () => {
      await createArchive({
        internalManifest: [`${mockHome}/.openclaw/workspace/SOUL.md`],
        externalManifest: [],
        backupDir,
      });

      // mkdirSync should have been called to create internal/ staging dir
      const mkdirCalls = fs.mkdirSync.mock.calls.map((c) => c[0]);
      expect(mkdirCalls.some((p) => p.includes('internal'))).toBe(true);
    });

    it('external files staged under external/ directory with path preserved', async () => {
      await createArchive({
        internalManifest: [],
        externalManifest: ['/etc/caddy/Caddyfile'],
        backupDir,
      });

      const mkdirCalls = fs.mkdirSync.mock.calls.map((c) => c[0]);
      expect(mkdirCalls.some((p) => p.includes('external'))).toBe(true);
    });

    it('tar is called via execFileSync with args array (no shell injection)', async () => {
      await createArchive({
        internalManifest: [],
        externalManifest: [],
        backupDir,
      });

      const tarCall = execFileSync.mock.calls.find((c) => c[0] === 'tar');
      expect(tarCall).toBeDefined();
      // Should pass args as array, not a single string
      expect(Array.isArray(tarCall[1])).toBe(true);
      expect(tarCall[1]).toContain('-czf');
    });
  });

  // --- Exclusions ---
  describe('Exclusions', () => {
    it('git repos with remotes are NOT staged (Lobsterfile has clone entry instead)', async () => {
      await createArchive({
        internalManifest: [],
        externalManifest: ['/home/testuser/projects/repo'],
        backupDir,
        gitRepos: [{ path: '/home/testuser/projects/repo', hasRemote: true }],
      });

      // The repo should NOT have been copied
      const copyCalls = fs.copyFileSync.mock.calls.map((c) => c[0]);
      expect(copyCalls.every((p) => !p.includes('/home/testuser/projects/repo'))).toBe(true);
    });
  });

  // --- Encryption ---
  describe('Encryption', () => {
    it('archive is encrypted with age via execFileSync (not shell string)', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('.lock')) return false;
        return true;
      });

      await runBackup({
        config: { backupPath: backupDir },
        dryRun: false,
      });

      // age should be called via execFileSync
      const ageCall = execFileSync.mock.calls.find((c) => c[0] === 'age');
      expect(ageCall).toBeDefined();
      expect(ageCall[1]).toContain('--encrypt');
    });
  });

  // --- Filename & Tagging ---
  describe('Filename & Tagging', () => {
    it('timestamp filename has no colons (filesystem-safe)', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('.lock')) return false;
        return true;
      });
      const result = await runBackup({
        config: { backupPath: backupDir },
        dryRun: true,
      });

      // New format: backup-2026-03-12T14-32-45.tar.gz.age (dashes, no colons)
      expect(result.filename).not.toContain(':');
      expect(result.filename).toMatch(
        /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.tar\.gz\.age$/
      );
    });

    it('--now triggers immediate manual backup', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('.lock')) return false;
        return true;
      });
      const result = await runBackup({
        config: { backupPath: backupDir },
        now: true,
        dryRun: true,
      });

      expect(result).toBeDefined();
      expect(result.manual).toBe(true);
    });

    it('manual backups tagged as manual (not subject to auto-pruning)', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('.lock')) return false;
        return true;
      });
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
        if (typeof p === 'string' && p.includes('lobsterfile.env')) return 'SERVER_IP=10.0.0.1\n';
        if (typeof p === 'string' && p.includes('lobsterfile') && !p.includes('.env')) {
          return '{{SERVER_IP}} {{NEW_PORT}}';
        }
        return '{}';
      });

      const result = await runBackup({
        config: { backupPath: backupDir },
        dryRun: true,
        detectOnly: true,
      });

      expect(result.newVariables).toContain('NEW_PORT');
    });

    it('does not re-prompt for existing variables with values', async () => {
      fs.readFileSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('lobsterfile.env')) return 'SERVER_IP=10.0.0.1\n';
        if (typeof p === 'string' && p.includes('lobsterfile') && !p.includes('.env')) return '{{SERVER_IP}}';
        return '{}';
      });

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
      fs.existsSync.mockReturnValue(false);
      execSync.mockImplementation(() => {
        throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
      });

      try {
        await runBackup({ config: { backupPath: backupDir } });
      } catch {
        // Expected
      }

      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('encryption failure → no plaintext tarball left on disk', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('.lock')) return false;
        return true;
      });
      execFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'tar') return '';
        if (cmd === 'age') throw new Error('age encryption failed');
        return '';
      });

      try {
        await runBackup({ config: { backupPath: backupDir } });
      } catch {
        // Expected
      }

      // Plaintext tarball should be cleaned up
      const unlinkCalls = fs.unlinkSync.mock.calls.map((c) => c[0]);
      expect(unlinkCalls.some((p) => typeof p === 'string' && p.includes('.tar.gz') && !p.includes('.age'))).toBe(true);
    });

    it('no external manifest → proceeds with warning (internal-only backup)', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('external-manifest')) return false;
        return true;
      });
      fs.readFileSync.mockReturnValue(JSON.stringify({ backupPath: backupDir }));

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
      fs.existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('.lock')) return false;
        return true;
      });
      const result = await runBackup({
        config: { backupPath: backupDir },
        dryRun: true,
      });

      expect(result.success).toBe(true);
    });

    it('logs error on failure', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('.lock')) return false;
        return true;
      });
      execSync.mockImplementation(() => { throw new Error('catastrophic failure'); });

      try {
        await runBackup({ config: { backupPath: backupDir } });
      } catch (e) {
        expect(e.message).toMatch(/catastrophic|failure/i);
      }
    });
  });

  // --- Checksums ---
  describe('Checksums', () => {
    it('meta.json contains per-file SHA-256 checksums (not placeholders)', async () => {
      await createArchive({
        internalManifest: [],
        externalManifest: [],
        backupDir,
      });

      const metaCall = fs.writeFileSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('meta.json')
      );
      expect(metaCall).toBeDefined();
      const meta = JSON.parse(metaCall[1]);

      // Checksums should be a real object, not { internal: 'placeholder', external: 'placeholder' }
      for (const [key, value] of Object.entries(meta.checksums)) {
        expect(value).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex digest
      }
    });

    it('manifest files are checksummed', async () => {
      await createArchive({
        internalManifest: ['file1'],
        externalManifest: ['file2'],
        backupDir,
      });

      const metaCall = fs.writeFileSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('meta.json')
      );
      const meta = JSON.parse(metaCall[1]);
      expect(meta.checksums['manifest-internal.json']).toBeDefined();
      expect(meta.checksums['manifest-external.json']).toBeDefined();
    });
  });
});
