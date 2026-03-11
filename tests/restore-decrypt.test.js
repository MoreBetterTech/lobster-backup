/**
 * Restore — Decryption Tests
 * Tests for credential prompting and decryption with passphrase or recovery key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promptForCredential, decryptBackup } from '../src/restore.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

vi.mock('node:fs');
vi.mock('node:child_process');

describe('Restore — Decryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prompts for credential type (passphrase vs. recovery key)', () => {
    const mockIO = {
      prompt: vi.fn().mockResolvedValue('passphrase'),
    };

    const result = promptForCredential(mockIO);
    expect(mockIO.prompt).toHaveBeenCalled();
  });

  it('correct passphrase → decrypts successfully', async () => {
    execSync.mockReturnValue(Buffer.from('decrypted-archive'));

    const result = await decryptBackup({
      archivePath: '/backups/backup.tar.gz.age',
      credentialType: 'passphrase',
      passphrase: 'correct-passphrase',
      config: {
        argon2Salt: 'test-salt',
        vaultKeyWrappedPassphrase: 'wrapped-key',
      },
    });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
  });

  it('correct Recovery Key → decrypts successfully', async () => {
    execSync.mockReturnValue(Buffer.from('decrypted-archive'));

    const result = await decryptBackup({
      archivePath: '/backups/backup.tar.gz.age',
      credentialType: 'recovery',
      recoveryKey: 'correct-recovery-key-base64',
      config: {
        vaultKeyWrappedRecovery: 'wrapped-key',
      },
    });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
  });

  it('wrong passphrase → fails with clear error message', async () => {
    execSync.mockImplementation(() => {
      throw new Error('age: error: no identity matched any of the recipients');
    });

    await expect(
      decryptBackup({
        archivePath: '/backups/backup.tar.gz.age',
        credentialType: 'passphrase',
        passphrase: 'wrong-passphrase',
        config: {
          argon2Salt: 'test-salt',
          vaultKeyWrappedPassphrase: 'wrapped-key',
        },
      })
    ).rejects.toThrow(/wrong|incorrect|failed|no identity/i);
  });

  it('wrong Recovery Key → fails with clear error message', async () => {
    execSync.mockImplementation(() => {
      throw new Error('age: error: no identity matched');
    });

    await expect(
      decryptBackup({
        archivePath: '/backups/backup.tar.gz.age',
        credentialType: 'recovery',
        recoveryKey: 'wrong-recovery-key',
        config: {
          vaultKeyWrappedRecovery: 'wrapped-key',
        },
      })
    ).rejects.toThrow(/wrong|incorrect|failed|no identity/i);
  });

  it('corrupted archive → fails cleanly (not a hang or crash)', async () => {
    execSync.mockImplementation(() => {
      throw new Error('age: error: header is invalid');
    });

    await expect(
      decryptBackup({
        archivePath: '/backups/corrupted.tar.gz.age',
        credentialType: 'passphrase',
        passphrase: 'any-passphrase',
        config: {
          argon2Salt: 'test-salt',
          vaultKeyWrappedPassphrase: 'wrapped-key',
        },
      })
    ).rejects.toThrow(/corrupt|invalid|header/i);
  });
});
