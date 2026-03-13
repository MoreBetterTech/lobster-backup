/**
 * Restore — Decryption Tests
 * Tests for credential prompting and decryption via the vault key unwrapping chain.
 * 
 * decryptBackup must: passphrase → Argon2id derive → unwrap vault key → decrypt archive.
 * These tests verify the full chain, not just that execSync was called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promptForCredential, decryptBackup } from '../src/restore.js';
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';

vi.mock('node:fs');
vi.mock('node:child_process');

// Mock the crypto module to verify the unwrapping chain is called correctly
vi.mock('../src/crypto.js', () => ({
  derivePassphraseKey: vi.fn(),
  unwrapVaultKey: vi.fn(),
  unwrapAgePrivateKey: vi.fn(),
  decryptArchive: vi.fn(),
}));

import { derivePassphraseKey, unwrapVaultKey, unwrapAgePrivateKey, decryptArchive } from '../src/crypto.js';

describe('Restore — Decryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.writeFileSync.mockReturnValue(undefined);
    fs.unlinkSync.mockReturnValue(undefined);
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

  it('correct passphrase → derives key via Argon2id, unwraps vault key, then decrypts with age private key', async () => {
    const fakeDerivedKey = Buffer.alloc(32, 0xAA);
    const fakeVaultKey = Buffer.alloc(32, 0xBB);

    derivePassphraseKey.mockResolvedValue(fakeDerivedKey);
    unwrapVaultKey.mockResolvedValue(fakeVaultKey);
    decryptArchive.mockResolvedValue(Buffer.from('decrypted-archive'));

    const result = await decryptBackup({
      archivePath: '/backups/backup.tar.gz.age',
      credentialType: 'passphrase',
      passphrase: 'correct-passphrase',
      config: {
        argon2Salt: Buffer.alloc(32, 0x01).toString('base64'),
        vaultKeyWrappedPassphrase: Buffer.alloc(60, 0x02).toString('base64'),
        agePrivateKey: 'AGE-SECRET-KEY-1TESTKEY',
      },
    });

    expect(result.success).toBe(true);
    // Verify passphrase was validated via the unwrap chain
    expect(derivePassphraseKey).toHaveBeenCalledWith(
      'correct-passphrase',
      expect.any(Buffer)
    );
    expect(unwrapVaultKey).toHaveBeenCalledWith(
      expect.any(Buffer),
      fakeDerivedKey
    );
    // Verify decryption used the age private key (written to temp file)
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('lobster-identity'),
      expect.stringContaining('AGE-SECRET-KEY-1TESTKEY'),
      { mode: 0o600 }
    );
    expect(decryptArchive).toHaveBeenCalledWith({
      inputPath: '/backups/backup.tar.gz.age',
      identityPath: expect.stringContaining('lobster-identity'),
    });
    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  it('correct Recovery Key → unwraps vault key directly, then decrypts with age private key', async () => {
    const fakeVaultKey = Buffer.alloc(32, 0xCC);

    unwrapVaultKey.mockResolvedValue(fakeVaultKey);
    decryptArchive.mockResolvedValue(Buffer.from('decrypted-archive'));

    const result = await decryptBackup({
      archivePath: '/backups/backup.tar.gz.age',
      credentialType: 'recovery',
      recoveryKey: Buffer.alloc(32, 0xDD).toString('base64'),
      config: {
        vaultKeyWrappedRecovery: Buffer.alloc(60, 0x03).toString('base64'),
        agePrivateKey: 'AGE-SECRET-KEY-1RECOVERYTEST',
      },
    });

    expect(result.success).toBe(true);
    // Recovery key path should NOT call derivePassphraseKey
    expect(derivePassphraseKey).not.toHaveBeenCalled();
    // But should unwrap and decrypt
    expect(unwrapVaultKey).toHaveBeenCalled();
    expect(decryptArchive).toHaveBeenCalled();
    // Should use age private key for decryption
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('lobster-identity'),
      expect.stringContaining('AGE-SECRET-KEY-1RECOVERYTEST'),
      { mode: 0o600 }
    );
  });

  it('wrong passphrase → unwrap fails → clear error message', async () => {
    derivePassphraseKey.mockResolvedValue(Buffer.alloc(32, 0xFF));
    unwrapVaultKey.mockImplementation(async () => { throw new Error('Failed to unwrap vault key: invalid key or corrupted data'); });

    await expect(
      decryptBackup({
        archivePath: '/backups/backup.tar.gz.age',
        credentialType: 'passphrase',
        passphrase: 'wrong-passphrase',
        config: {
          argon2Salt: Buffer.alloc(32, 0x01).toString('base64'),
          vaultKeyWrappedPassphrase: Buffer.alloc(60, 0x02).toString('base64'),
        },
      })
    ).rejects.toThrow(/wrong|incorrect|failed/i);
  });

  it('wrong Recovery Key → unwrap fails → clear error message', async () => {
    unwrapVaultKey.mockImplementation(async () => { throw new Error('Failed to unwrap vault key: invalid key or corrupted data'); });

    await expect(
      decryptBackup({
        archivePath: '/backups/backup.tar.gz.age',
        credentialType: 'recovery',
        recoveryKey: Buffer.alloc(32, 0xEE).toString('base64'),
        config: {
          vaultKeyWrappedRecovery: Buffer.alloc(60, 0x03).toString('base64'),
        },
      })
    ).rejects.toThrow(/wrong|incorrect|failed/i);
  });

  it('wrapped age private key → unwraps via vault key before decryption', async () => {
    const fakeDerivedKey = Buffer.alloc(32, 0xAA);
    const fakeVaultKey = Buffer.alloc(32, 0xBB);

    derivePassphraseKey.mockResolvedValue(fakeDerivedKey);
    unwrapVaultKey.mockResolvedValue(fakeVaultKey);
    unwrapAgePrivateKey.mockReturnValue('AGE-SECRET-KEY-1UNWRAPPED');
    decryptArchive.mockResolvedValue(Buffer.from('decrypted-archive'));

    const result = await decryptBackup({
      archivePath: '/backups/backup.tar.gz.age',
      credentialType: 'passphrase',
      passphrase: 'correct-passphrase',
      config: {
        argon2Salt: Buffer.alloc(32, 0x01).toString('base64'),
        vaultKeyWrappedPassphrase: Buffer.alloc(60, 0x02).toString('base64'),
        agePrivateKeyWrapped: Buffer.alloc(80, 0x04).toString('base64'),
      },
    });

    expect(result.success).toBe(true);
    // Vault key should be unwrapped first, then used to unwrap age private key
    expect(unwrapAgePrivateKey).toHaveBeenCalledWith(expect.any(Buffer), fakeVaultKey);
    // Decryption should use the unwrapped age private key
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('lobster-identity'),
      expect.stringContaining('AGE-SECRET-KEY-1UNWRAPPED'),
      { mode: 0o600 }
    );
  });

  it('legacy config with plaintext agePrivateKey still works (backward compat)', async () => {
    const fakeVaultKey = Buffer.alloc(32, 0xBB);

    derivePassphraseKey.mockResolvedValue(Buffer.alloc(32, 0xAA));
    unwrapVaultKey.mockResolvedValue(fakeVaultKey);
    decryptArchive.mockResolvedValue(Buffer.from('decrypted-archive'));

    const result = await decryptBackup({
      archivePath: '/backups/backup.tar.gz.age',
      credentialType: 'passphrase',
      passphrase: 'correct-passphrase',
      config: {
        argon2Salt: Buffer.alloc(32, 0x01).toString('base64'),
        vaultKeyWrappedPassphrase: Buffer.alloc(60, 0x02).toString('base64'),
        agePrivateKey: 'AGE-SECRET-KEY-1LEGACYKEY',
      },
    });

    expect(result.success).toBe(true);
    // Should NOT call unwrapAgePrivateKey (legacy path)
    expect(unwrapAgePrivateKey).not.toHaveBeenCalled();
    // Should still use the plaintext key
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('lobster-identity'),
      expect.stringContaining('AGE-SECRET-KEY-1LEGACYKEY'),
      { mode: 0o600 }
    );
  });

  it('corrupted archive → decryptArchive fails → clean error', async () => {
    derivePassphraseKey.mockResolvedValue(Buffer.alloc(32, 0xAA));
    unwrapVaultKey.mockResolvedValue(Buffer.alloc(32, 0xBB));
    decryptArchive.mockImplementation(async () => { throw new Error('Failed to decrypt archive: header is invalid'); });

    await expect(
      decryptBackup({
        archivePath: '/backups/corrupted.tar.gz.age',
        credentialType: 'passphrase',
        passphrase: 'any-passphrase',
        config: {
          argon2Salt: Buffer.alloc(32, 0x01).toString('base64'),
          vaultKeyWrappedPassphrase: Buffer.alloc(60, 0x02).toString('base64'),
          agePrivateKey: 'AGE-SECRET-KEY-1TEST',
        },
      })
    ).rejects.toThrow(/corrupt|invalid|header/i);
  });

  it('missing config fields → throws clear error before crypto operations', async () => {
    await expect(
      decryptBackup({
        archivePath: '/backups/backup.tar.gz.age',
        credentialType: 'passphrase',
        passphrase: 'test',
        config: {},
      })
    ).rejects.toThrow(/missing/i);

    // Should not have attempted any crypto operations
    expect(derivePassphraseKey).not.toHaveBeenCalled();
    expect(unwrapVaultKey).not.toHaveBeenCalled();
  });

  it('temp identity file is cleaned up even on decryption failure', async () => {
    derivePassphraseKey.mockResolvedValue(Buffer.alloc(32, 0xAA));
    unwrapVaultKey.mockResolvedValue(Buffer.alloc(32, 0xBB));
    decryptArchive.mockRejectedValue(new Error('Failed to decrypt archive: decryption failed'));

    try {
      await decryptBackup({
        archivePath: '/backups/backup.tar.gz.age',
        credentialType: 'passphrase',
        passphrase: 'test-passphrase',
        config: {
          argon2Salt: Buffer.alloc(32, 0x01).toString('base64'),
          vaultKeyWrappedPassphrase: Buffer.alloc(60, 0x02).toString('base64'),
          agePrivateKey: 'AGE-SECRET-KEY-1TEST',
        },
      });
    } catch {
      // expected
    }

    // Temp identity file should still be cleaned up
    expect(fs.unlinkSync).toHaveBeenCalled();
  });
});
