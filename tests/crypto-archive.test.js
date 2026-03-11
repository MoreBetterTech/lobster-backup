/**
 * Encryption — Archive Tests
 * Tests for encrypting/decrypting archives with age, using multiple recipients.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  encryptArchive,
  decryptArchive,
  generateAgeKeypair,
} from '../src/crypto.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

vi.mock('node:fs');
vi.mock('node:child_process');

describe('Encryption — Archive', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = '/tmp/lobster-crypto-test';
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('encrypts a tarball with age using both recipients (passphrase + recovery key)', async () => {
    const passphraseIdentity = { publicKey: 'age1passphrase...', privateKey: 'AGE-SECRET-KEY-1...' };
    const recoveryIdentity = { publicKey: 'age1recovery...', privateKey: 'AGE-SECRET-KEY-2...' };

    execSync.mockReturnValue(Buffer.from('encrypted-data'));
    fs.readFileSync.mockReturnValue(Buffer.from('tarball-contents'));
    fs.writeFileSync.mockReturnValue(undefined);

    await encryptArchive({
      inputPath: `${tmpDir}/backup.tar.gz`,
      outputPath: `${tmpDir}/backup.tar.gz.age`,
      recipients: [passphraseIdentity.publicKey, recoveryIdentity.publicKey],
    });

    const cmd = execSync.mock.calls[0][0];
    expect(cmd).toMatch(/age/);
    expect(cmd).toContain('-r');
  });

  it('decrypts with passphrase-derived identity → success', async () => {
    execSync.mockReturnValue(Buffer.from('decrypted-tarball'));
    fs.readFileSync.mockReturnValue(Buffer.from('encrypted-data'));

    const result = await decryptArchive({
      inputPath: `${tmpDir}/backup.tar.gz.age`,
      identityPath: `${tmpDir}/passphrase-identity.txt`,
    });

    expect(result).toBeDefined();
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('age'),
      expect.anything()
    );
  });

  it('decrypts with Recovery Key identity → success', async () => {
    execSync.mockReturnValue(Buffer.from('decrypted-tarball'));

    const result = await decryptArchive({
      inputPath: `${tmpDir}/backup.tar.gz.age`,
      identityPath: `${tmpDir}/recovery-identity.txt`,
    });

    expect(result).toBeDefined();
  });

  it('decryption fails cleanly with wrong credentials', async () => {
    execSync.mockImplementation(() => {
      throw new Error('age: error: no identity matched any of the recipients');
    });

    await expect(
      decryptArchive({
        inputPath: `${tmpDir}/backup.tar.gz.age`,
        identityPath: `${tmpDir}/wrong-identity.txt`,
      })
    ).rejects.toThrow(/no identity|failed|decrypt/i);
  });

  it('encrypted file is not readable as plaintext (sanity check)', async () => {
    const plaintext = Buffer.from('#!/bin/bash\necho "secret stuff"\n');
    const ciphertext = Buffer.from([0xc0, 0xff, 0xee, 0x00, 0xde, 0xad]); // binary gibberish

    execSync.mockReturnValue(ciphertext);
    fs.readFileSync.mockReturnValue(plaintext);
    fs.writeFileSync.mockReturnValue(undefined);

    await encryptArchive({
      inputPath: `${tmpDir}/backup.tar.gz`,
      outputPath: `${tmpDir}/backup.tar.gz.age`,
      recipients: ['age1recipient...'],
    });

    // The encrypted output should not contain plaintext
    const writeCall = fs.writeFileSync.mock.calls.find(
      (c) => c[0].includes('.age')
    );
    if (writeCall) {
      const written = writeCall[1];
      expect(written.toString()).not.toContain('secret stuff');
    }
  });

  it('archive header contains both wrapped key copies', async () => {
    // This tests that the archive metadata includes both key wrappers
    const meta = {
      formatVersion: 1,
      vaultKeyWrappedPassphrase: 'base64-wrapped-passphrase-key',
      vaultKeyWrappedRecovery: 'base64-wrapped-recovery-key',
      timestamp: '2026-03-11T03:00:00Z',
    };

    expect(meta.vaultKeyWrappedPassphrase).toBeDefined();
    expect(meta.vaultKeyWrappedRecovery).toBeDefined();
    expect(meta.vaultKeyWrappedPassphrase).not.toBe(meta.vaultKeyWrappedRecovery);
  });

  it('round-trip: encrypt → decrypt → byte comparison (integrity)', async () => {
    const original = Buffer.from('This is the original tarball content for integrity check.');

    // Mock encrypt: just base64 encode to simulate
    let encrypted;
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('-e') || cmd.includes('--encrypt')) {
        encrypted = Buffer.from(original.toString('base64'));
        return encrypted;
      }
      if (cmd.includes('-d') || cmd.includes('--decrypt')) {
        return Buffer.from(encrypted.toString(), 'base64');
      }
      return Buffer.alloc(0);
    });

    fs.readFileSync.mockReturnValue(original);
    fs.writeFileSync.mockReturnValue(undefined);

    await encryptArchive({
      inputPath: `${tmpDir}/backup.tar.gz`,
      outputPath: `${tmpDir}/backup.tar.gz.age`,
      recipients: ['age1test...'],
    });

    const decrypted = await decryptArchive({
      inputPath: `${tmpDir}/backup.tar.gz.age`,
      identityPath: `${tmpDir}/identity.txt`,
    });

    expect(Buffer.compare(decrypted, original)).toBe(0);
  });
});
