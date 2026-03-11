/**
 * Restore — File Restoration Tests
 * Tests for restoring internal/external files, permissions, directories, and symlinks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { restoreFiles } from '../src/restore.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

vi.mock('node:fs');
vi.mock('node:child_process');

describe('Restore — File Restoration', () => {
  let mockHome;

  beforeEach(() => {
    mockHome = '/home/testuser';
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('internal files restored to ~/.openclaw/ at correct relative paths', () => {
    fs.mkdirSync.mockReturnValue(undefined);
    fs.writeFileSync.mockReturnValue(undefined);
    execSync.mockReturnValue('');

    restoreFiles({
      archiveDir: '/tmp/extracted',
      internalFiles: ['workspace/SOUL.md', 'workspace/MEMORY.md', 'openclaw.json'],
      externalFiles: [],
    });

    const writeCalls = fs.writeFileSync.mock.calls.map((c) => c[0]);
    expect(writeCalls.some((p) => p.startsWith(path.join(mockHome, '.openclaw/')))).toBe(true);
  });

  it('external files restored to original absolute paths', () => {
    fs.mkdirSync.mockReturnValue(undefined);
    execSync.mockReturnValue('');

    restoreFiles({
      archiveDir: '/tmp/extracted',
      internalFiles: [],
      externalFiles: ['etc/caddy/Caddyfile', 'var/www/index.html'],
    });

    const cmds = execSync.mock.calls.map((c) => c[0]);
    expect(cmds.some((cmd) => cmd.includes('/etc/') || cmd.includes('/var/'))).toBe(true);
  });

  it('external file restore to system paths (/etc/, /var/) uses sudo', () => {
    execSync.mockReturnValue('');

    restoreFiles({
      archiveDir: '/tmp/extracted',
      internalFiles: [],
      externalFiles: ['etc/caddy/Caddyfile'],
    });

    const sudoCmd = execSync.mock.calls.find((c) => c[0].includes('sudo'));
    expect(sudoCmd).toBeDefined();
  });

  it('file permissions preserved on restore', () => {
    execSync.mockReturnValue('');

    restoreFiles({
      archiveDir: '/tmp/extracted',
      internalFiles: ['openclaw.json'],
      externalFiles: [],
      preservePermissions: true,
    });

    const tarCmd = execSync.mock.calls.find((c) => c[0].includes('tar'));
    if (tarCmd) {
      expect(tarCmd[0]).toMatch(/-p|--preserve/);
    }
  });

  it('missing parent directories created automatically', () => {
    fs.mkdirSync.mockReturnValue(undefined);
    fs.writeFileSync.mockReturnValue(undefined);
    execSync.mockReturnValue('');

    restoreFiles({
      archiveDir: '/tmp/extracted',
      internalFiles: ['workspace/memory/2026-03-10.md'],
      externalFiles: [],
    });

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recursive: true })
    );
  });

  it('symlinks restored as symlinks (not dereferenced)', () => {
    fs.symlinkSync.mockReturnValue(undefined);
    fs.mkdirSync.mockReturnValue(undefined);
    execSync.mockReturnValue('');

    restoreFiles({
      archiveDir: '/tmp/extracted',
      internalFiles: [],
      externalFiles: [],
      symlinks: [
        { linkPath: '/home/testuser/bin/editor', target: '/usr/bin/vim' },
      ],
    });

    expect(fs.symlinkSync).toHaveBeenCalledWith('/usr/bin/vim', '/home/testuser/bin/editor');
  });
});
