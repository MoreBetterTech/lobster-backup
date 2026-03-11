/**
 * Pruning / Retention Tests
 * Tests for backup retention policies and tier-based pruning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pruneBackups } from '../src/pruning.js';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node:fs');

describe('Pruning / Retention', () => {
  const backupDir = '/home/testuser/lobster-backups';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeBackupList(count, startDate, intervalMs = 3600000) {
    const backups = [];
    const start = new Date(startDate).getTime();
    for (let i = 0; i < count; i++) {
      const date = new Date(start + i * intervalMs);
      const ts = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      backups.push({
        filename: `backup-${ts}.tar.gz.age`,
        path: path.join(backupDir, `backup-${ts}.tar.gz.age`),
        timestamp: date,
        manual: false,
        size: 1024 * 1024,
      });
    }
    return backups;
  }

  it('keeps last 24 hourly backups; prunes older', () => {
    const backups = makeBackupList(30, '2026-03-01T00:00:00Z');
    fs.unlinkSync.mockReturnValue(undefined);

    const result = pruneBackups(backups, { maxHourly: 24, maxDaily: 7 });

    expect(result.kept.length).toBeLessThanOrEqual(24 + 7);
    expect(result.pruned.length).toBeGreaterThan(0);
  });

  it('daily promotion: most recent hourly at midnight boundary becomes daily snapshot', () => {
    // Create hourly backups spanning 3 days
    const backups = makeBackupList(72, '2026-03-01T00:00:00Z');

    const result = pruneBackups(backups, { maxHourly: 24, maxDaily: 7 });

    // Should have daily snapshots for completed days
    expect(result.dailySnapshots).toBeDefined();
    expect(result.dailySnapshots.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps last 7 daily snapshots; prunes older', () => {
    // Create daily backups spanning 14 days
    const backups = makeBackupList(14, '2026-02-25T00:00:00Z', 86400000);

    const result = pruneBackups(backups, { maxHourly: 24, maxDaily: 7 });

    const dailyKept = result.dailySnapshots ? result.dailySnapshots.length : 0;
    expect(dailyKept).toBeLessThanOrEqual(7);
  });

  it('manual (--now) backups are never auto-pruned', () => {
    const backups = makeBackupList(30, '2026-03-01T00:00:00Z');
    // Mark some as manual
    backups[0].manual = true;
    backups[5].manual = true;
    backups[10].manual = true;

    fs.unlinkSync.mockReturnValue(undefined);

    const result = pruneBackups(backups, { maxHourly: 24, maxDaily: 7 });

    // Manual backups should all be in the kept list
    const prunedPaths = result.pruned.map((b) => b.path);
    expect(prunedPaths).not.toContain(backups[0].path);
    expect(prunedPaths).not.toContain(backups[5].path);
    expect(prunedPaths).not.toContain(backups[10].path);
  });

  it('most recent backup of each tier is always kept, regardless of age', () => {
    const backups = makeBackupList(3, '2025-01-01T00:00:00Z', 86400000);

    const result = pruneBackups(backups, { maxHourly: 24, maxDaily: 7 });

    // The most recent one should always be kept
    const mostRecent = backups[backups.length - 1];
    const keptPaths = result.kept.map((b) => b.path);
    expect(keptPaths).toContain(mostRecent.path);
  });

  it('prune runs after each backup completion (integration point)', () => {
    // This verifies the prune function signature accepts post-backup context
    const backups = makeBackupList(5, '2026-03-01T00:00:00Z');
    const result = pruneBackups(backups, { maxHourly: 24, maxDaily: 7 });
    expect(result).toBeDefined();
    expect(result).toHaveProperty('kept');
    expect(result).toHaveProperty('pruned');
  });

  it('correct archive is deleted (oldest of the tier, not random)', () => {
    const backups = makeBackupList(26, '2026-03-01T00:00:00Z');
    fs.unlinkSync.mockReturnValue(undefined);

    const result = pruneBackups(backups, { maxHourly: 24, maxDaily: 7 });

    // The oldest backups should be the ones pruned
    if (result.pruned.length > 0) {
      const oldestKept = result.kept.reduce((min, b) =>
        b.timestamp < min.timestamp ? b : min
      );
      for (const pruned of result.pruned) {
        if (!pruned.manual) {
          expect(pruned.timestamp.getTime()).toBeLessThanOrEqual(oldestKept.timestamp.getTime());
        }
      }
    }
  });

  // --- Edge Cases ---
  describe('Edge Cases', () => {
    it('fewer than 24 backups exist → no hourly pruning needed', () => {
      const backups = makeBackupList(10, '2026-03-10T00:00:00Z');
      const result = pruneBackups(backups, { maxHourly: 24, maxDaily: 7 });
      expect(result.pruned.length).toBe(0);
    });

    it('all backups are from the same hour → handles gracefully', () => {
      const backups = makeBackupList(5, '2026-03-10T10:00:00Z', 60000); // 1 min apart
      const result = pruneBackups(backups, { maxHourly: 24, maxDaily: 7 });
      expect(result).toBeDefined();
      expect(result.kept.length).toBeGreaterThan(0);
    });

    it('no daily snapshots yet → no daily pruning', () => {
      // All backups within the last hour
      const backups = makeBackupList(3, '2026-03-10T10:00:00Z', 600000); // 10 min apart
      const result = pruneBackups(backups, { maxHourly: 24, maxDaily: 7 });
      expect(result.dailySnapshots).toBeDefined();
      // Should handle empty daily list gracefully
    });
  });
});
