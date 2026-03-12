/**
 * Restore — Archive Selection Tests
 * Tests for listing, sorting, discovering, and selecting backup archives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listBackups, selectBackup } from '../src/restore.js';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node:fs');

describe('Restore — Archive Selection', () => {
  const backupDir = '/home/testuser/lobster-backups';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockFiles = [
    'backup-2026-03-10T03:00:00.tar.gz.age',
    'backup-2026-03-09T03:00:00.tar.gz.age',
    'backup-2026-03-11T03:00:00.tar.gz.age',
  ];

  it('--list shows available backups with timestamps and sizes', () => {
    fs.readdirSync.mockReturnValue(mockFiles);
    fs.statSync.mockReturnValue({ size: 1024 * 1024, mtime: new Date() });

    const backups = listBackups(backupDir);

    expect(backups).toHaveLength(3);
    backups.forEach((b) => {
      expect(b).toHaveProperty('filename');
      expect(b).toHaveProperty('timestamp');
      expect(b).toHaveProperty('size');
    });
  });

  it('--list sorts by date (newest first)', () => {
    fs.readdirSync.mockReturnValue(mockFiles);
    fs.statSync.mockReturnValue({ size: 1024 * 1024, mtime: new Date() });

    const backups = listBackups(backupDir);

    for (let i = 1; i < backups.length; i++) {
      expect(backups[i - 1].timestamp >= backups[i].timestamp).toBe(true);
    }
  });

  it('--list discovers from configured backup directory', () => {
    fs.readdirSync.mockReturnValue(mockFiles);
    fs.statSync.mockReturnValue({ size: 1024, mtime: new Date() });

    listBackups(backupDir);

    expect(fs.readdirSync).toHaveBeenCalledWith(backupDir);
  });

  it('default (no flags) enters interactive selection', () => {
    fs.readdirSync.mockReturnValue(mockFiles);
    fs.statSync.mockReturnValue({ size: 1024, mtime: new Date() });

    const selection = selectBackup(backupDir, { interactive: true });

    // Should return a selection context (not auto-pick)
    expect(selection).toHaveProperty('backups');
    expect(selection).toHaveProperty('interactive', true);
  });

  it('--from <backup> selects specific archive by path', () => {
    const archivePath = path.join(backupDir, 'backup-2026-03-11T03:00:00.tar.gz.age');
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ size: 1024, mtime: new Date() });

    const selection = selectBackup(backupDir, { from: archivePath });

    expect(selection.selectedPath).toBe(archivePath);
  });

  it('--from rejects non-existent archive (clean error)', () => {
    const archivePath = '/nonexistent/backup.tar.gz.age';
    fs.existsSync.mockReturnValue(false);

    expect(() => selectBackup(backupDir, { from: archivePath })).toThrow(
      /not found|does not exist|no such/i
    );
  });
});
