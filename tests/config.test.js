/**
 * Config Management Tests
 * Tests for reading, writing, validating, and resolving lobster-backup config.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readConfig, writeConfig, validateConfig, resolveConfigPaths } from '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node:fs');

describe('Config Management', () => {
  let mockHome;

  beforeEach(() => {
    mockHome = '/home/testuser';
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const validConfig = {
    backupPath: '~/lobster-backups',
    passphraseHash: 'argon2id$v=19$m=65536,t=3,p=4$somesalt$somehash',
    vaultKeyWrappedPassphrase: 'age1wrapped...passphrase',
    vaultKeyWrappedRecovery: 'age1wrapped...recovery',
    argon2Salt: 'base64salt==',
    schedule: { hourly: true, daily: true },
    exclusions: [],
    formatVersion: 1,
  };

  it('reads existing config from ~/.openclaw/lobster-backup.json', () => {
    const configPath = path.join(mockHome, '.openclaw', 'lobster-backup.json');
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify(validConfig));

    const config = readConfig();

    expect(fs.readFileSync).toHaveBeenCalledWith(configPath, 'utf-8');
    expect(config).toEqual(validConfig);
  });

  it('creates config with correct defaults when none exists', () => {
    fs.existsSync.mockReturnValue(false);

    const config = readConfig();

    expect(config).toBeDefined();
    expect(config.backupPath).toBeDefined();
    expect(config.schedule).toBeDefined();
    expect(config.exclusions).toEqual(expect.any(Array));
  });

  it('validates required fields (backup path, passphrase hash, vault key, etc.)', () => {
    const result = validateConfig(validConfig);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects invalid config (missing fields, bad types)', () => {
    const badConfig = { backupPath: 123 }; // missing fields, wrong type

    const result = validateConfig(badConfig);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('resolves ~ and environment variables in paths', () => {
    const config = { ...validConfig, backupPath: '~/lobster-backups' };
    const resolved = resolveConfigPaths(config);

    expect(resolved.backupPath).toBe(path.join(mockHome, 'lobster-backups'));
    expect(resolved.backupPath).not.toContain('~');
  });

  it('paths are never hardcoded to a specific user home directory', () => {
    const config = { ...validConfig, backupPath: '~/lobster-backups' };
    const resolved = resolveConfigPaths(config);

    // Should use os.homedir(), not a hardcoded path
    expect(resolved.backupPath).toStartWith(mockHome);
    expect(resolved.backupPath).not.toContain('/home/ubuntu/');
  });

  it('config file permissions are restrictive (not world-readable)', () => {
    fs.existsSync.mockReturnValue(false);

    writeConfig(validConfig);

    // Should write with mode 0o600 (owner read/write only)
    const writeCall = fs.writeFileSync.mock.calls[0];
    expect(writeCall).toBeDefined();
    const options = writeCall[2];
    expect(options).toBeDefined();
    expect(options.mode).toBe(0o600);
  });
});
