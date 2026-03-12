/**
 * Restore — File Restoration Tests
 * Tests for restoring internal/external files, permissions, directories, and symlinks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { restoreFiles } from '../src/restore.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';

vi.mock('node:fs');
vi.mock('node:child_process');

describe('Restore — File Restoration', () => {
  let mockHome;

  beforeEach(() => {
    mockHome = '/home/testuser';
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.clearAllMocks();
    fs.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('internal files restored to ~/.openclaw/ at correct relative paths', () => {
    fs.mkdirSync.mockReturnValue(undefined);
    fs.writeFileSync.mockReturnValue(undefined);
    fs.readFileSync.mockReturnValue(Buffer.from('file content'));

    restoreFiles({
      archiveDir: '/tmp/extracted',
      internalFiles: ['workspace/SOUL.md', 'workspace/MEMORY.md', 'openclaw.json'],
      externalFiles: [],
    });

    const writeCalls = fs.writeFileSync.mock.calls.map((c) => c[0]);
    expect(writeCalls.some((p) => p.startsWith(path.join(mockHome, '.openclaw/')))).toBe(true);
    // Verify specific files were written to correct paths
    expect(writeCalls).toContain(path.join(mockHome, '.openclaw', 'workspace/SOUL.md'));
    expect(writeCalls).toContain(path.join(mockHome, '.openclaw', 'openclaw.json'));
  });

  it('external files restored to original absolute paths via execFileSync (no shell injection)', () => {
    fs.mkdirSync.mockReturnValue(undefined);
    execFileSync.mockReturnValue('');

    restoreFiles({
      archiveDir: '/tmp/extracted',
      internalFiles: [],
      externalFiles: ['etc/caddy/Caddyfile', 'var/www/index.html'],
    });

    // Should use execFileSync (not execSync) for sudo commands
    const sudoCalls = execFileSync.mock.calls.filter((c) => c[0] === 'sudo');
    expect(sudoCalls.length).toBeGreaterThan(0);
    // Verify actual paths are in the commands
    const cpCalls = sudoCalls.filter((c) => c[1].includes('cp'));
    expect(cpCalls.some((c) => c[1].includes('/etc/caddy/Caddyfile'))).toBe(true);
  });

  it('external file restore to system paths (/etc/, /var/) uses sudo via execFileSync', () => {
    execFileSync.mockReturnValue('');

    restoreFiles({
      archiveDir: '/tmp/extracted',
      internalFiles: [],
      externalFiles: ['etc/caddy/Caddyfile'],
    });

    const sudoCalls = execFileSync.mock.calls.filter((c) => c[0] === 'sudo');
    expect(sudoCalls.length).toBeGreaterThanOrEqual(1);
    // Should have a mkdir and a cp call via sudo
    const mkdirCall = sudoCalls.find((c) => c[1].includes('mkdir'));
    const cpCall = sudoCalls.find((c) => c[1].includes('cp'));
    expect(mkdirCall).toBeDefined();
    expect(cpCall).toBeDefined();
  });

  it('file permissions preserved when preservePermissions is true', () => {
    fs.readFileSync.mockReturnValue(Buffer.from('content'));
    fs.writeFileSync.mockReturnValue(undefined);
    fs.mkdirSync.mockReturnValue(undefined);
    fs.statSync.mockReturnValue({ mode: 0o755 });
    fs.chmodSync.mockReturnValue(undefined);

    restoreFiles({
      archiveDir: '/tmp/extracted',
      internalFiles: ['openclaw.json'],
      externalFiles: [],
      preservePermissions: true,
    });

    // With preservePermissions=true, chmodSync should be called
    expect(fs.chmodSync).toHaveBeenCalledWith(
      expect.any(String),
      0o755
    );
  });

  it('permissions NOT set when preservePermissions is false/undefined', () => {
    fs.readFileSync.mockReturnValue(Buffer.from('content'));
    fs.writeFileSync.mockReturnValue(undefined);
    fs.mkdirSync.mockReturnValue(undefined);

    restoreFiles({
      archiveDir: '/tmp/extracted',
      internalFiles: ['openclaw.json'],
      externalFiles: [],
      // preservePermissions not set
    });

    expect(fs.chmodSync).not.toHaveBeenCalled();
  });

  it('missing parent directories created automatically', () => {
    fs.mkdirSync.mockReturnValue(undefined);
    fs.writeFileSync.mockReturnValue(undefined);
    fs.readFileSync.mockReturnValue(Buffer.from('content'));

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
