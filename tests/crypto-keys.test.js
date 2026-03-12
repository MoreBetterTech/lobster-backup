/**
 * Encryption — Key Management Tests
 * Tests for key derivation (Argon2id), key wrapping, and unwrapping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  derivePassphraseKey,
  wrapVaultKey,
  unwrapVaultKey,
  generateSalt,
} from '../src/crypto.js';

describe('Encryption — Key Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Key Derivation ---
  describe('Key Derivation', () => {
    it('derives passphrase key via Argon2id (deterministic given same passphrase + salt)', async () => {
      const salt = generateSalt();
      const key1 = await derivePassphraseKey('my-passphrase', salt);
      const key2 = await derivePassphraseKey('my-passphrase', salt);
      expect(key1).toEqual(key2);
    });

    it('same passphrase + same salt = same derived key', async () => {
      const salt = Buffer.from('fixed-salt-for-testing-00', 'utf-8');
      const key1 = await derivePassphraseKey('test-pass', salt);
      const key2 = await derivePassphraseKey('test-pass', salt);
      expect(Buffer.compare(key1, key2)).toBe(0);
    });

    it('different passphrases produce different derived keys', async () => {
      const salt = generateSalt();
      const key1 = await derivePassphraseKey('passphrase-one', salt);
      const key2 = await derivePassphraseKey('passphrase-two', salt);
      expect(Buffer.compare(key1, key2)).not.toBe(0);
    });

    it('different salts with same passphrase produce different keys', async () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      const key1 = await derivePassphraseKey('same-passphrase', salt1);
      const key2 = await derivePassphraseKey('same-passphrase', salt2);
      expect(Buffer.compare(key1, key2)).not.toBe(0);
    });
  });

  // --- Key Wrapping ---
  describe('Key Wrapping', () => {
    const vaultKey = Buffer.alloc(32);
    // Fill with deterministic test data
    for (let i = 0; i < 32; i++) vaultKey[i] = i;

    it('wraps Vault Key with passphrase-derived key → produces ciphertext', async () => {
      const salt = generateSalt();
      const passphraseKey = await derivePassphraseKey('test-passphrase', salt);
      const wrapped = await wrapVaultKey(vaultKey, passphraseKey);
      expect(wrapped).toBeDefined();
      expect(wrapped.length).toBeGreaterThan(0);
      // Should not be the same as plaintext vault key
      expect(Buffer.compare(wrapped, vaultKey)).not.toBe(0);
    });

    it('wraps Vault Key with Recovery Key → produces ciphertext', async () => {
      const recoveryKey = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) recoveryKey[i] = 255 - i;

      const wrapped = await wrapVaultKey(vaultKey, recoveryKey);
      expect(wrapped).toBeDefined();
      expect(wrapped.length).toBeGreaterThan(0);
    });

    it('unwraps Vault Key with correct passphrase → recovers original key', async () => {
      const salt = generateSalt();
      const passphraseKey = await derivePassphraseKey('test-passphrase', salt);
      const wrapped = await wrapVaultKey(vaultKey, passphraseKey);
      const unwrapped = await unwrapVaultKey(wrapped, passphraseKey);
      expect(Buffer.compare(unwrapped, vaultKey)).toBe(0);
    });

    it('unwraps Vault Key with correct Recovery Key → recovers original key', async () => {
      const recoveryKey = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) recoveryKey[i] = 255 - i;

      const wrapped = await wrapVaultKey(vaultKey, recoveryKey);
      const unwrapped = await unwrapVaultKey(wrapped, recoveryKey);
      expect(Buffer.compare(unwrapped, vaultKey)).toBe(0);
    });

    it('unwrap fails cleanly with wrong passphrase (clear error, no crash)', async () => {
      const salt = generateSalt();
      const correctKey = await derivePassphraseKey('correct-passphrase', salt);
      const wrongKey = await derivePassphraseKey('wrong-passphrase', salt);
      const wrapped = await wrapVaultKey(vaultKey, correctKey);

      await expect(unwrapVaultKey(wrapped, wrongKey)).rejects.toThrow(/decrypt|unwrap|invalid/i);
    });

    it('unwrap fails cleanly with wrong Recovery Key', async () => {
      const correctKey = Buffer.alloc(32, 0xaa);
      const wrongKey = Buffer.alloc(32, 0xbb);
      const wrapped = await wrapVaultKey(vaultKey, correctKey);

      await expect(unwrapVaultKey(wrapped, wrongKey)).rejects.toThrow(/decrypt|unwrap|invalid/i);
    });

    it('passphrase and Recovery Key wrappers are independent', async () => {
      const salt = generateSalt();
      const passphraseKey = await derivePassphraseKey('my-passphrase', salt);
      const recoveryKey = Buffer.alloc(32, 0xcc);

      const wrappedByPassphrase = await wrapVaultKey(vaultKey, passphraseKey);
      const wrappedByRecovery = await wrapVaultKey(vaultKey, recoveryKey);

      // Both should produce different ciphertext
      expect(Buffer.compare(wrappedByPassphrase, wrappedByRecovery)).not.toBe(0);

      // Both should independently unwrap to the same vault key
      const unwrapped1 = await unwrapVaultKey(wrappedByPassphrase, passphraseKey);
      const unwrapped2 = await unwrapVaultKey(wrappedByRecovery, recoveryKey);
      expect(Buffer.compare(unwrapped1, unwrapped2)).toBe(0);
      expect(Buffer.compare(unwrapped1, vaultKey)).toBe(0);
    });
  });
});
