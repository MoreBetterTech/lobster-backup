/**
 * crypto.js — Encryption module for lobster-backup
 * 
 * Implements key generation, Argon2id key derivation, AES-256-GCM key wrapping,
 * and age-based archive encryption/decryption.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { execSync } from 'node:child_process';
import argon2 from 'argon2';

/**
 * Generate a random salt for Argon2id key derivation
 * @returns {Buffer} 32-byte random salt
 */
export function generateSalt() {
  return randomBytes(32);
}

/**
 * Generate a random 256-bit vault key
 * @returns {Buffer} 32-byte random key
 */
export function generateVaultKey() {
  return randomBytes(32);
}

/**
 * Generate a random 256-bit recovery key
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
  // Use age-keygen to generate a keypair
  const output = execSync('age-keygen', { encoding: 'utf8' });
  
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
  // Use Argon2id with reasonable parameters for key derivation
  const hash = await argon2.hash(passphrase, {
    salt,
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3,       // 3 iterations
    parallelism: 1,    // 1 thread
    hashLength: 32,    // 256-bit output
    raw: true          // Return raw bytes, not encoded string
  });
  
  return Buffer.from(hash);
}

/**
 * Wrap (encrypt) a vault key using AES-256-GCM
 * @param {Buffer} vaultKey - The 256-bit vault key to encrypt
 * @param {Buffer} wrappingKey - The 256-bit wrapping key
 * @returns {Promise<Buffer>} Encrypted vault key with IV and auth tag
 */
export async function wrapVaultKey(vaultKey, wrappingKey) {
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
  
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
 * Encrypt an archive using age with multiple recipients
 * @param {Object} options - Encryption options
 * @param {string} options.inputPath - Path to input file to encrypt
 * @param {string} options.outputPath - Path for encrypted output file
 * @param {string[]} options.recipients - Array of age public keys
 * @returns {Promise<void>}
 */
export async function encryptArchive({ inputPath, outputPath, recipients }) {
  // Build age command with multiple recipients
  const recipientArgs = recipients.flatMap(recipient => ['-r', recipient]);
  const cmd = ['age', '--encrypt', ...recipientArgs, '-o', outputPath, inputPath].join(' ');
  
  try {
    execSync(cmd, { stdio: 'pipe' });
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
  const cmd = `age --decrypt -i ${identityPath} ${inputPath}`;
  
  try {
    const result = execSync(cmd, { stdio: 'pipe' });
    return result;
  } catch (error) {
    // Simple error handling - just use a generic message if error parsing fails
    throw new Error('Failed to decrypt archive: decryption failed');
  }
}