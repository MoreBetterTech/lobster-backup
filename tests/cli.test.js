/**
 * CLI Argument Parsing Tests
 * Tests for routing subcommands and parsing flags.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('CLI Argument Parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lobster setup routes to setup flow', () => {
    const result = parseArgs(['setup']);
    expect(result.command).toBe('setup');
  });

  it('lobster scan routes to scan flow', () => {
    const result = parseArgs(['scan']);
    expect(result.command).toBe('scan');
  });

  it('lobster scan --register passes register flag', () => {
    const result = parseArgs(['scan', '--register']);
    expect(result.command).toBe('scan');
    expect(result.flags.register).toBe(true);
  });

  it('lobster scan --paths /foo /bar passes custom paths', () => {
    const result = parseArgs(['scan', '--paths', '/foo', '/bar']);
    expect(result.command).toBe('scan');
    expect(result.flags.paths).toEqual(['/foo', '/bar']);
  });

  it('lobster backup routes to backup flow', () => {
    const result = parseArgs(['backup']);
    expect(result.command).toBe('backup');
  });

  it('lobster backup --now passes immediate flag', () => {
    const result = parseArgs(['backup', '--now']);
    expect(result.command).toBe('backup');
    expect(result.flags.now).toBe(true);
  });

  it('lobster restore routes to restore flow', () => {
    const result = parseArgs(['restore']);
    expect(result.command).toBe('restore');
  });

  it('lobster restore --list passes list flag', () => {
    const result = parseArgs(['restore', '--list']);
    expect(result.command).toBe('restore');
    expect(result.flags.list).toBe(true);
  });

  it('lobster restore --from <path> passes archive path', () => {
    const result = parseArgs(['restore', '--from', '/backups/backup-2026.tar.gz.age']);
    expect(result.command).toBe('restore');
    expect(result.flags.from).toBe('/backups/backup-2026.tar.gz.age');
  });

  it('lobster restore --dry-run passes dry-run flag', () => {
    const result = parseArgs(['restore', '--dry-run']);
    expect(result.command).toBe('restore');
    expect(result.flags.dryRun).toBe(true);
  });

  it('unknown commands print help text', () => {
    const result = parseArgs(['frobnicate']);
    expect(result.command).toBe('help');
    expect(result.unknownCommand).toBe('frobnicate');
  });

  it('--help on any subcommand prints usage', () => {
    for (const cmd of ['setup', 'scan', 'backup', 'restore']) {
      const result = parseArgs([cmd, '--help']);
      expect(result.command).toBe(cmd);
      expect(result.flags.help).toBe(true);
    }
  });
});
