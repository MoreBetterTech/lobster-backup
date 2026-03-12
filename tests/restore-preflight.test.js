/**
 * Restore — Pre-flight Checks Tests
 * Tests for OC version comparison, existing install detection,
 * archive integrity verification, and dry-run mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkOCVersion,
  checkExistingInstall,
  verifyArchiveIntegrity,
  dryRunRestore,
} from '../src/restore.js';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';

vi.mock('node:fs');
vi.mock('node:child_process');

describe('Restore — Pre-flight Checks', () => {
  let mockHome;

  beforeEach(() => {
    mockHome = '/home/testuser';
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- OC Version ---
  describe('OC Version', () => {
    it('backup OC version > current OC version → warn and prompt', () => {
      execSync.mockReturnValue('1.0.0\n'); // current version

      const result = checkOCVersion({ backupVersion: '2.0.0', currentVersion: '1.0.0' });

      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/newer|update|recommend/i);
      expect(result.promptRequired).toBe(true);
    });

    it('current OC version > backup version → note and proceed', () => {
      const result = checkOCVersion({ backupVersion: '1.0.0', currentVersion: '2.0.0' });

      expect(result.proceed).toBe(true);
      expect(result.note).toBeDefined();
    });

    it('same version → proceed silently', () => {
      const result = checkOCVersion({ backupVersion: '1.5.0', currentVersion: '1.5.0' });

      expect(result.proceed).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });

  // --- Existing Install ---
  describe('Existing Install', () => {
    it('detects existing ~/.openclaw/ workspace and config', () => {
      fs.existsSync.mockReturnValue(true);

      const result = checkExistingInstall();

      expect(result.existingInstall).toBe(true);
    });

    it('warns before overwriting current state', () => {
      fs.existsSync.mockReturnValue(true);

      const result = checkExistingInstall();

      expect(result.warning).toMatch(/overwrite|existing|replace/i);
    });

    it('offers to back up current state first (safety net)', () => {
      fs.existsSync.mockReturnValue(true);

      const result = checkExistingInstall();

      expect(result.offerBackup).toBe(true);
    });
  });

  // --- Archive Integrity ---
  describe('Archive Integrity', () => {
    it('verifies checksums in meta.json against archive contents', () => {
      const meta = {
        formatVersion: 1,
        checksums: {
          'internal/workspace/SOUL.md': 'sha256:abc123',
          'lobsterfile': 'sha256:def456',
        },
      };

      // Mock: all checksums match
      const archiveFiles = {
        'internal/workspace/SOUL.md': 'sha256:abc123',
        'lobsterfile': 'sha256:def456',
      };

      const result = verifyArchiveIntegrity(meta, archiveFiles);
      expect(result.valid).toBe(true);
    });

    it('checksum mismatch → abort with clear error', () => {
      const meta = {
        formatVersion: 1,
        checksums: { 'lobsterfile': 'sha256:abc123' },
      };

      const archiveFiles = { 'lobsterfile': 'sha256:WRONG' };

      expect(() => verifyArchiveIntegrity(meta, archiveFiles)).toThrow(
        /checksum|mismatch|integrity/i
      );
    });

    it('missing meta.json → abort', () => {
      expect(() => verifyArchiveIntegrity(null, {})).toThrow(
        /meta\.json|missing|required/i
      );
    });

    it('format version mismatch → warn and prompt', () => {
      const meta = { formatVersion: 99, checksums: {} };
      const archiveFiles = {};

      const result = verifyArchiveIntegrity(meta, archiveFiles, { expectedVersion: 1 });
      expect(result.versionWarning).toBeDefined();
      expect(result.promptRequired).toBe(true);
    });
  });

  // --- Dry Run ---
  describe('Dry Run', () => {
    it('--dry-run reports what would be restored without modifying anything', () => {
      fs.writeFileSync.mockReturnValue(undefined);

      const result = dryRunRestore({
        internalFiles: ['workspace/SOUL.md', 'openclaw.json'],
        externalFiles: ['etc/caddy/Caddyfile'],
        lobsterfile: '#!/bin/bash\napt install caddy\n',
      });

      expect(result.wouldRestore).toBeDefined();
      expect(result.wouldRestore.internal).toContain('workspace/SOUL.md');
      expect(result.wouldRestore.external).toContain('etc/caddy/Caddyfile');
      expect(result.wouldRestore.lobsterfile).toBe(true);

      // Should NOT actually write any files
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });
});
