/**
 * Edge Cases & Error Handling Tests
 * Tests for unusual, boundary, and error conditions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

vi.mock('node:fs');
vi.mock('node:child_process');

describe('Edge Cases & Error Handling', () => {
  let mockHome;
  let backupDir;

  beforeEach(() => {
    mockHome = '/home/testuser';
    backupDir = path.join(mockHome, 'lobster-backups');
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('backup with minimal workspace (only openclaw.json exists)', async () => {
    const { runBackup } = await import('../src/backup.js');

    fs.existsSync.mockImplementation((p) => {
      if (p.includes('openclaw.json')) return true;
      if (p.includes('.lock')) return false;
      return false;
    });
    fs.readFileSync.mockReturnValue('{}');
    fs.writeFileSync.mockReturnValue(undefined);
    fs.unlinkSync.mockReturnValue(undefined);
    execSync.mockReturnValue('');

    const result = await runBackup({
      config: { backupPath: backupDir },
      dryRun: true,
    });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
  });

  it('backup with no external manifest registered', async () => {
    const { runBackup } = await import('../src/backup.js');

    fs.existsSync.mockImplementation((p) => {
      if (p.includes('external-manifest')) return false;
      return true;
    });
    fs.readFileSync.mockReturnValue('{}');
    fs.writeFileSync.mockReturnValue(undefined);
    fs.unlinkSync.mockReturnValue(undefined);
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

  it('backup with empty Lobsterfile', async () => {
    const { runBackup } = await import('../src/backup.js');

    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockImplementation((p) => {
      if (p.includes('lobsterfile') && !p.includes('.env') && !p.includes('.json')) return '';
      if (p.includes('lobsterfile.env')) return '';
      return '{}';
    });
    fs.writeFileSync.mockReturnValue(undefined);
    fs.unlinkSync.mockReturnValue(undefined);
    execSync.mockReturnValue('');

    const result = await runBackup({
      config: { backupPath: backupDir },
      dryRun: true,
    });

    // Should succeed even with empty lobsterfile
    expect(result).toBeDefined();
  });

  it('restore to machine with no existing OC install', async () => {
    const { checkExistingInstall } = await import('../src/restore.js');

    fs.existsSync.mockReturnValue(false);

    const result = checkExistingInstall();

    expect(result.existingInstall).toBe(false);
    // Should proceed without warning about overwriting
    expect(result.offerBackup).toBeFalsy();
  });

  it('restore when backup destination directory does not exist', async () => {
    const { listBackups } = await import('../src/restore.js');

    fs.readdirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    expect(() => listBackups('/nonexistent/backups')).toThrow(/not found|does not exist|ENOENT/i);
  });

  it('interrupted backup does not corrupt previous backups', async () => {
    const { runBackup } = await import('../src/backup.js');

    // Simulate existing good backup
    const existingBackup = 'backup-2026-03-10T03:00:00.tar.gz.age';

    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue([existingBackup]);
    fs.readFileSync.mockReturnValue('{}');
    fs.writeFileSync.mockReturnValue(undefined);
    fs.unlinkSync.mockReturnValue(undefined);

    // Simulate crash during archive creation
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('tar')) throw new Error('Interrupted!');
      return '';
    });

    try {
      await runBackup({ config: { backupPath: backupDir } });
    } catch {
      // Expected
    }

    // The existing backup should NOT have been touched
    const unlinkCalls = fs.unlinkSync.mock.calls.map((c) => c[0]);
    expect(unlinkCalls).not.toContain(path.join(backupDir, existingBackup));
  });

  it('non-UTF8 filenames in external manifest', async () => {
    const { readExternalManifest } = await import('../src/manifest.js');

    // Simulate a manifest with a non-UTF8 compatible path
    const manifest = ['/etc/caddy/Caddyfile', '/var/data/file\xff\xfename.conf'];
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify(manifest));

    // Should not crash
    const result = readExternalManifest();
    expect(result).toBeDefined();
    expect(result.length).toBe(2);
  });

  it('very large files in external manifest (no OOM)', async () => {
    const { createArchive } = await import('../src/backup.js');
    const { execFileSync } = await import('node:child_process');

    // Mock a very large file in the manifest
    fs.statSync.mockReturnValue({ size: 10 * 1024 * 1024 * 1024 }); // 10GB
    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockReturnValue(undefined);
    fs.writeFileSync.mockReturnValue(undefined);
    fs.copyFileSync.mockReturnValue(undefined);
    fs.readFileSync.mockReturnValue(Buffer.from('content'));
    fs.rmSync.mockReturnValue(undefined);
    execSync.mockReturnValue('unknown');
    execFileSync.mockReturnValue('');

    // The archive creation should use tar via execFileSync (streams, doesn't load into memory)
    await createArchive({
      internalManifest: [],
      externalManifest: ['/var/data/huge-database-dump.sql'],
      backupDir,
    });

    // tar should be called via execFileSync (not execSync with string interpolation)
    const tarCall = execFileSync.mock.calls.find((c) => c[0] === 'tar');
    expect(tarCall).toBeDefined();
    expect(tarCall[1]).toContain('-czf');
  });
});
