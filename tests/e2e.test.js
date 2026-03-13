/**
 * End-to-End Scenario Tests
 * Integration tests that exercise complete flows.
 * These tests mock at the filesystem/subprocess boundary
 * but exercise the full orchestration logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';

vi.mock('node:fs');
vi.mock('node:child_process');

describe('End-to-End Scenarios', () => {
  let mockHome;
  let backupDir;
  let ocDir;

  beforeEach(() => {
    mockHome = '/home/testuser';
    backupDir = path.join(mockHome, 'lobster-backups');
    ocDir = path.join(mockHome, '.openclaw');
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('E2E-1: Full Round-Trip — setup → backup (dry) → restore (dry) exercises full orchestration', async () => {
    const { runSetup } = await import('../src/setup.js');
    const { runBackup } = await import('../src/backup.js');
    const { runRestore } = await import('../src/restore.js');

    fs.existsSync.mockReturnValue(false);
    fs.mkdirSync.mockReturnValue(undefined);
    fs.writeFileSync.mockReturnValue(undefined);
    fs.readFileSync.mockReturnValue('{}');
    fs.readdirSync.mockReturnValue([]);
    fs.unlinkSync.mockReturnValue(undefined);
    execSync.mockReturnValue('');
    execFileSync.mockImplementation((cmd) => {
      if (cmd === 'age-keygen') {
        return '# created: 2026-03-12T18:00:00Z\n' +
          '# public key: age1testpublickey0000000000000000000000000000000000000000000xxxx\n' +
          'AGE-SECRET-KEY-1TESTPRIVATEKEY000000000000000000000000000000000000000XXXX';
      }
      return '';
    });

    const mockIO = {
      output: [],
      write(msg) { this.output.push(msg); },
      prompt: vi.fn()
        .mockResolvedValueOnce('I have saved this key')
        .mockResolvedValueOnce('y')
        .mockResolvedValueOnce('y')
        .mockResolvedValueOnce('y'),
    };

    // 1. Setup — should write config with real Argon2id-wrapped keys and age keypair
    await runSetup({
      io: mockIO,
      passphrase: 'my-secure-passphrase-2026',
      passphraseConfirm: 'my-secure-passphrase-2026',
      backupPath: backupDir,
      skipScan: true,
      skipConfirmation: true,
    });

    // Verify setup wrote a config with real wrapped keys (not placeholders)
    const configWriteCall = fs.writeFileSync.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('lobster-backup.json')
    );
    expect(configWriteCall).toBeDefined();
    const savedConfig = JSON.parse(configWriteCall[1]);
    expect(savedConfig.vaultKeyWrappedPassphrase).toBeDefined();
    expect(savedConfig.vaultKeyWrappedRecovery).toBeDefined();
    expect(savedConfig.argon2Salt).toBeDefined();
    // Passphrase hash should NOT be an unsalted SHA-256 (64 hex chars from SHA-256)
    // With Argon2id it's also 64 hex chars but derived differently — we verify the 
    // wrapped keys are real base64 strings of the right length
    const wrappedKey = Buffer.from(savedConfig.vaultKeyWrappedPassphrase, 'base64');
    expect(wrappedKey.length).toBe(60); // 12 IV + 32 encrypted + 16 auth tag
    // Config should include age public key and wrapped (not plaintext) private key
    expect(savedConfig.agePublicKey).toMatch(/^age1/);
    expect(savedConfig.agePrivateKeyWrapped).toBeDefined();
    expect(savedConfig.agePrivateKey).toBeUndefined(); // must NOT store plaintext
    // Wrapped key should be a base64 string of reasonable length (12 IV + encrypted + 16 tag)
    const wrappedAgeKey = Buffer.from(savedConfig.agePrivateKeyWrapped, 'base64');
    expect(wrappedAgeKey.length).toBeGreaterThan(28); // minimum: 12 + 0 + 16

    // 2. Backup (dry run)
    const backupResult = await runBackup({
      config: { backupPath: backupDir },
      dryRun: true,
    });
    expect(backupResult).toBeDefined();
    expect(backupResult.success).toBe(true);
    // Verify timestamp format has no colons
    expect(backupResult.filename).not.toContain(':');
    expect(backupResult.filename).toMatch(/backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);

    // 3. Restore (dry run) — the real runRestore now needs a backup to select
    // Mock a backup file existing
    fs.readdirSync.mockReturnValue(['backup-2026-03-12T14-32-45.tar.gz.age']);
    fs.statSync.mockReturnValue({ size: 1024 });
    fs.existsSync.mockReturnValue(true);

    const restoreResult = await runRestore({
      config: { backupPath: backupDir },
      dryRun: true,
      io: mockIO,
    });
    expect(restoreResult).toBeDefined();
    expect(restoreResult.dryRun).toBe(true);
    expect(restoreResult.completed).toBe(true);
    // Dry run should have written preview info to IO
    expect(mockIO.output.some(msg => typeof msg === 'string' && msg.includes('Dry Run'))).toBe(true);
  });

  it('E2E-2: Cross-Machine Portability — env vars prompted for update', async () => {
    const { substituteLobsterfile } = await import('../src/restore.js');

    const lobsterfile = 'server {{SERVER_IP}}\nport {{GATEWAY_PORT}}';
    const oldEnv = { SERVER_IP: '10.0.0.1', GATEWAY_PORT: '18789' };

    const mockIO = {
      output: [],
      write(msg) { this.output.push(msg); },
      prompt: vi.fn()
        .mockResolvedValueOnce('10.0.0.2')
        .mockResolvedValueOnce(''),
    };

    const result = await substituteLobsterfile(lobsterfile, oldEnv, mockIO);
    expect(mockIO.prompt).toHaveBeenCalled();
    // The new IP should be substituted
    expect(result).toContain('10.0.0.2');
    // The unchanged port should keep its old value
    expect(result).toContain('18789');
  });

  it('E2E-3: Partial / Idempotent Restore — already-done steps succeed', async () => {
    const { executeLobsterfile } = await import('../src/restore.js');

    execSync.mockReturnValue('');
    fs.writeFileSync.mockReturnValue(undefined);
    fs.unlinkSync.mockReturnValue(undefined);

    const idempotentScript = `#!/bin/bash
sudo apt-get install -y curl
sudo apt-get install -y caddy
`;

    const result = await executeLobsterfile({
      content: idempotentScript,
      envVars: {},
    });

    expect(result.exitCode).toBe(0);
  });

  it('E2E-4: Recovery Key Restore — decryptBackup uses unwrap chain (not raw age passphrase)', async () => {
    // This test verifies that decryptBackup actually calls the crypto chain
    // rather than passing the passphrase directly to age
    const { decryptBackup } = await import('../src/restore.js');

    // We need to test that the function attempts to unwrap,
    // not that it passes credentials to the shell.
    // With invalid wrapped key data, it should fail at unwrap (not at age CLI).
    await expect(
      decryptBackup({
        archivePath: '/backups/backup.tar.gz.age',
        credentialType: 'recovery',
        recoveryKey: Buffer.alloc(32, 0x01).toString('base64'),
        config: {
          // Invalid wrapped key (wrong length for AES-256-GCM: needs 60 bytes)
          vaultKeyWrappedRecovery: Buffer.alloc(30, 0x02).toString('base64'),
        },
      })
    ).rejects.toThrow(); // Should fail at unwrap, not at age CLI

    // The old implementation would have called execSync with 'age --decrypt'
    // The new implementation should fail before reaching execSync/execFileSync
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('E2E-5: Stale Lock Recovery — dead PID lock detected, recovered, backup completes', async () => {
    const { acquireLock, runBackup } = await import('../src/backup.js');

    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('99999');
    fs.unlinkSync.mockReturnValue(undefined);
    fs.writeFileSync.mockReturnValue(undefined);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    vi.spyOn(process, 'pid', 'get').mockReturnValue(12345);

    expect(() => acquireLock()).not.toThrow();

    execSync.mockReturnValue('');
    execFileSync.mockReturnValue('');
    const result = await runBackup({
      config: { backupPath: backupDir },
      dryRun: true,
    });
    expect(result).toBeDefined();
  });

  it('E2E-6: Concurrent Prevention — second process bails on live lock', async () => {
    const { acquireLock } = await import('../src/backup.js');

    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('55555');
    vi.spyOn(process, 'kill').mockReturnValue(true);

    expect(() => acquireLock()).toThrow(/running|locked|in progress/i);
  });

  it('E2E-7: Git Repo in External Manifest — not tarballed, clone entry in Lobsterfile', async () => {
    const { detectGitRepo, generateGitCloneEntry } = await import('../src/manifest.js');

    fs.existsSync.mockReturnValue(true);
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('remote get-url')) return 'https://github.com/user/repo.git\n';
      if (cmd.includes('rev-parse')) return 'main\n';
      return '';
    });

    const gitInfo = detectGitRepo('/home/testuser/projects/myapp');
    expect(gitInfo.isGitRepo).toBe(true);
    expect(gitInfo.remoteUrl).toBeTruthy();

    const entry = generateGitCloneEntry({
      remoteUrl: gitInfo.remoteUrl,
      localPath: '/home/testuser/projects/myapp',
      ref: gitInfo.ref,
    });

    expect(entry).toContain('git clone');
    expect(entry).toContain('https://github.com/user/repo.git');
  });
});
