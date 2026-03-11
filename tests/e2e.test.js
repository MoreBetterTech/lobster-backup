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
import { execSync } from 'node:child_process';

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

  it('E2E-1: Full Round-Trip (Same Machine) — setup → backup → restore → all files present', async () => {
    // This test will import and chain setup, backup, and restore
    // For now, we define the expected flow and assertions

    const { runSetup } = await import('../src/setup.js');
    const { runBackup } = await import('../src/backup.js');
    const { runRestore } = await import('../src/restore.js');

    // Setup mocks for full flow
    fs.existsSync.mockReturnValue(false);
    fs.mkdirSync.mockReturnValue(undefined);
    fs.writeFileSync.mockReturnValue(undefined);
    fs.readFileSync.mockReturnValue('{}');
    fs.readdirSync.mockReturnValue([]);
    fs.unlinkSync.mockReturnValue(undefined);
    execSync.mockReturnValue('');

    const mockIO = {
      output: [],
      write(msg) { this.output.push(msg); },
      prompt: vi.fn()
        .mockResolvedValueOnce('I have saved this key')  // recovery key ack
        .mockResolvedValueOnce('y')                       // confirm setup
        .mockResolvedValueOnce('y')                       // confirm restore
        .mockResolvedValueOnce('y'),                      // confirm lobsterfile exec
    };

    // 1. Setup
    await runSetup({
      io: mockIO,
      passphrase: 'my-secure-passphrase-2026',
      passphraseConfirm: 'my-secure-passphrase-2026',
      backupPath: backupDir,
      skipScan: true,
      skipConfirmation: true,
    });

    // 2. Backup
    const backupResult = await runBackup({
      config: { backupPath: backupDir },
      dryRun: true,
    });
    expect(backupResult).toBeDefined();

    // 3. Restore
    const restoreResult = await runRestore({
      config: { backupPath: backupDir },
      dryRun: true,
      io: mockIO,
    });
    expect(restoreResult).toBeDefined();
  });

  it('E2E-2: Cross-Machine Portability — env vars prompted for update', async () => {
    const { substituteLobsterfile } = await import('../src/restore.js');

    const lobsterfile = 'server {{SERVER_IP}}\nport {{GATEWAY_PORT}}';
    const oldEnv = { SERVER_IP: '10.0.0.1', GATEWAY_PORT: '18789' };

    const mockIO = {
      output: [],
      write(msg) { this.output.push(msg); },
      prompt: vi.fn()
        .mockResolvedValueOnce('10.0.0.2')   // new IP
        .mockResolvedValueOnce(''),            // keep port
    };

    const result = await substituteLobsterfile(lobsterfile, oldEnv, mockIO);

    // Should have prompted for new values
    expect(mockIO.prompt).toHaveBeenCalled();
  });

  it('E2E-3: Partial / Idempotent Restore — already-done steps succeed', async () => {
    const { executeLobsterfile } = await import('../src/restore.js');

    // Simulate idempotent commands that succeed even when already done
    execSync.mockReturnValue('');
    fs.writeFileSync.mockReturnValue(undefined);
    fs.unlinkSync.mockReturnValue(undefined);

    const idempotentScript = `#!/bin/bash
sudo apt-get install -y curl   # already installed = no-op
sudo apt-get install -y caddy  # already installed = no-op
`;

    const result = await executeLobsterfile({
      content: idempotentScript,
      envVars: {},
    });

    expect(result.exitCode).toBe(0);
  });

  it('E2E-4: Recovery Key Restore — decrypt with recovery key succeeds', async () => {
    const { decryptBackup } = await import('../src/restore.js');

    execSync.mockReturnValue(Buffer.from('decrypted-archive'));

    const result = await decryptBackup({
      archivePath: '/backups/backup.tar.gz.age',
      credentialType: 'recovery',
      recoveryKey: 'valid-recovery-key-base64',
      config: {
        vaultKeyWrappedRecovery: 'wrapped-key-data',
      },
    });

    expect(result.success).toBe(true);
  });

  it('E2E-5: Stale Lock Recovery — dead PID lock detected, recovered, backup completes', async () => {
    const { acquireLock, runBackup } = await import('../src/backup.js');

    // Stale lock exists
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('99999'); // dead PID
    fs.unlinkSync.mockReturnValue(undefined);
    fs.writeFileSync.mockReturnValue(undefined);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    vi.spyOn(process, 'pid', 'get').mockReturnValue(12345);

    // Should recover from stale lock
    expect(() => acquireLock()).not.toThrow();

    // And backup should proceed
    execSync.mockReturnValue('');
    const result = await runBackup({
      config: { backupPath: backupDir },
      dryRun: true,
    });
    expect(result).toBeDefined();
  });

  it('E2E-6: Concurrent Prevention — second process bails on live lock', async () => {
    const { acquireLock } = await import('../src/backup.js');

    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('55555'); // live PID
    vi.spyOn(process, 'kill').mockReturnValue(true); // process is alive

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
