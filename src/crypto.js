/**
 * crypto.js — Encryption module for lobster-backup
 * 
 * Implements key generation, Argon2id key derivation, AES-256-GCM key wrapping,
 * and age-based archive encryption/decryption.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import argon2 from 'argon2';

// Use age for archive encryption over GPG because:
// - age is modern, audited, and natively supports multiple recipients
// - GPG doesn't handle multiple decryption keys without complex plumbing

/**
 * Generate a random salt for Argon2id key derivation
 * @returns {Buffer} 32-byte random salt
 */
export function generateSalt() {
  return randomBytes(32);
}

/**
 * Generate a random 256-bit vault key
 * 
 * Key wrapping model (LastPass-derived): The archive is NOT directly 
 * encrypted by passphrase. Instead, a random Vault Key encrypts the 
 * archive, and the Vault Key is wrapped by passphrase AND separately 
 * by Recovery Key. Either wrapper is sufficient. Both lost = data gone 
 * by design (zero-knowledge architecture).
 * 
 * @returns {Buffer} 32-byte random key
 */
export function generateVaultKey() {
  return randomBytes(32);
}

/**
 * Generate a random 256-bit recovery key
 * 
 * Recovery Key is device-independent: Unlike LastPass's rOTP (device-bound, 
 * fails on new machines), this Recovery Key works on any device — which is 
 * what disaster recovery requires. Pure entropy, no device binding.
 * 
 * @returns {Buffer} 32-byte random key
 */
export function generateRecoveryKey() {
  return randomBytes(32);
}

/**
 * Generate an age keypair (public + private keys)
 * @returns {Object} {publicKey: string, privateKey: string}
 */
export function generateAgeKeypair() {
  // Use age-keygen to generate a keypair (execFileSync avoids shell)
  const output = execFileSync('age-keygen', [], { encoding: 'utf8' });
  
  // Parse the output to extract public and private keys
  const lines = output.trim().split('\n');
  const privateKeyLine = lines.find(line => line.startsWith('AGE-SECRET-KEY-'));
  const publicKeyLine = lines.find(line => line.startsWith('# public key: '));
  
  if (!privateKeyLine || !publicKeyLine) {
    throw new Error('Failed to parse age-keygen output');
  }
  
  const privateKey = privateKeyLine.trim();
  const publicKey = publicKeyLine.replace('# public key: ', '').trim();
  
  return { publicKey, privateKey };
}

/**
 * Derive a key from passphrase + salt using Argon2id
 * @param {string} passphrase - The passphrase to derive from
 * @param {Buffer} salt - The salt for key derivation
 * @returns {Promise<Buffer>} 32-byte derived key
 */
export async function derivePassphraseKey(passphrase, salt) {
  // Argon2id: Memory-hard KDF prevents GPU/ASIC brute-force of passphrase.
  // 64MB memory cost is the balance between security and usability.
  const hash = await argon2.hash(passphrase, {
    salt,
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB - prevents GPU/ASIC attacks while remaining usable
    timeCost: 3,       // 3 iterations
    parallelism: 1,    // 1 thread
    hashLength: 32,    // 256-bit output
    raw: true          // Return raw bytes, not encoded string
  });
  
  return Buffer.from(hash);
}

/**
 * Wrap (encrypt) a vault key using AES-256-GCM
 * 
 * AES-256-GCM with AAD: The "lobster-backup-vault-key" AAD string prevents 
 * key wrapping ciphertext from being confused with other encrypted data. 
 * GCM provides both confidentiality and integrity.
 * 
 * @param {Buffer} vaultKey - The 256-bit vault key to encrypt
 * @param {Buffer} wrappingKey - The 256-bit wrapping key
 * @returns {Promise<Buffer>} Encrypted vault key with IV and auth tag
 */
export async function wrapVaultKey(vaultKey, wrappingKey) {
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
  
  // AAD prevents confusion with other encrypted data in the system
  cipher.setAAD(Buffer.from('lobster-backup-vault-key', 'utf8'));
  
  const encrypted = Buffer.concat([
    cipher.update(vaultKey),
    cipher.final()
  ]);
  
  const authTag = cipher.getAuthTag();
  
  // Return: IV (12 bytes) + encrypted data (32 bytes) + auth tag (16 bytes)
  return Buffer.concat([iv, encrypted, authTag]);
}

/**
 * Unwrap (decrypt) a vault key using AES-256-GCM
 * @param {Buffer} wrapped - The wrapped vault key (IV + encrypted + auth tag)
 * @param {Buffer} wrappingKey - The 256-bit wrapping key
 * @returns {Promise<Buffer>} Decrypted vault key
 */
export async function unwrapVaultKey(wrapped, wrappingKey) {
  if (wrapped.length !== 60) { // 12 + 32 + 16
    throw new Error('Invalid wrapped key length');
  }
  
  const iv = wrapped.subarray(0, 12);
  const encrypted = wrapped.subarray(12, 44);
  const authTag = wrapped.subarray(44, 60);
  
  try {
    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv);
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from('lobster-backup-vault-key', 'utf8'));
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    
    return decrypted;
  } catch (error) {
    throw new Error('Failed to unwrap vault key: invalid key or corrupted data');
  }
}

/**
 * Wrap (encrypt) an age private key using AES-256-GCM with the vault key
 * 
 * The age private key is variable-length text (not a fixed 32 bytes like the vault key).
 * Same AES-256-GCM approach but different AAD to prevent confusion with vault key wrapping.
 * 
 * @param {string} agePrivateKey - The AGE-SECRET-KEY-... string
 * @param {Buffer} vaultKey - The 256-bit vault key
 * @returns {Buffer} IV (12) + encrypted data (variable) + auth tag (16)
 */
export function wrapAgePrivateKey(agePrivateKey, vaultKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', vaultKey, iv);
  cipher.setAAD(Buffer.from('lobster-backup-age-private-key', 'utf8'));
  
  const plaintext = Buffer.from(agePrivateKey, 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  return Buffer.concat([iv, encrypted, authTag]);
}

/**
 * Unwrap (decrypt) an age private key using AES-256-GCM with the vault key
 * @param {Buffer} wrapped - IV + encrypted data + auth tag
 * @param {Buffer} vaultKey - The 256-bit vault key
 * @returns {string} The decrypted AGE-SECRET-KEY-... string
 */
export function unwrapAgePrivateKey(wrapped, vaultKey) {
  if (wrapped.length < 28) { // minimum: 12 IV + 0 data + 16 tag
    throw new Error('Invalid wrapped age private key length');
  }
  
  const iv = wrapped.subarray(0, 12);
  const encrypted = wrapped.subarray(12, wrapped.length - 16);
  const authTag = wrapped.subarray(wrapped.length - 16);
  
  try {
    const decipher = createDecipheriv('aes-256-gcm', vaultKey, iv);
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from('lobster-backup-age-private-key', 'utf8'));
    
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    throw new Error('Failed to unwrap age private key: invalid vault key or corrupted data');
  }
}

/**
 * Encrypt an archive using age with multiple recipients
 * @param {Object} options - Encryption options
 * @param {string} options.inputPath - Path to input file to encrypt
 * @param {string} options.outputPath - Path for encrypted output file
 * @param {string[]} options.recipients - Array of age public keys
 * @returns {Promise<void>}
 */
export async function encryptArchive({ inputPath, outputPath, recipients }) {
  // Use execFileSync with args array to avoid shell injection via paths or recipient keys
  const args = ['--encrypt'];
  for (const recipient of recipients) {
    args.push('-r', recipient);
  }
  args.push('-o', outputPath, inputPath);

  try {
    execFileSync('age', args, { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Failed to encrypt archive: ${error.message}`);
  }
}

/**
 * Decrypt an age-encrypted archive
 * @param {Object} options - Decryption options
 * @param {string} options.inputPath - Path to encrypted file
 * @param {string} options.identityPath - Path to age identity file
 * @returns {Promise<Buffer>} Decrypted content
 */
export async function decryptArchive({ inputPath, identityPath }) {
  try {
    // Use execFileSync with args array to avoid shell injection via file paths
    const result = execFileSync('age', ['--decrypt', '-i', identityPath, inputPath], { stdio: 'pipe' });
    return result;
  } catch (error) {
    throw new Error('Failed to decrypt archive: decryption failed');
  }
}