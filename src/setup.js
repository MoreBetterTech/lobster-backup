/**
 * setup.js — Setup and initialization for lobster-backup
 * 
 * Interactive setup flow, passphrase validation, key generation,
 * environment audit, and configuration writing.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  generateSalt,
  generateVaultKey as cryptoGenerateVaultKey,
  generateRecoveryKey as cryptoGenerateRecoveryKey,
  derivePassphraseKey,
  wrapVaultKey
} from './crypto.js';
import { writeConfig } from './config.js';
import { detectPlaceholders as lobsterfileDetectPlaceholders } from './lobsterfile.js';

/**
 * Validate passphrase strength and confirmation
 * @param {string} passphrase - The passphrase to validate
 * @param {string} [confirmation] - Optional confirmation passphrase
 * @returns {object} { valid: boolean, error?: string }
 */
export function validatePassphrase(passphrase, confirmation) {
  // Check minimum length
  if (passphrase.length < 12) {
    return {
      valid: false,
      error: 'Passphrase too short. Please use at least 12 characters for minimum security.'
    };
  }

  // Check confirmation if provided
  if (confirmation !== undefined && passphrase !== confirmation) {
    return {
      valid: false,
      error: 'Passphrases do not match. Please try again.'
    };
  }

  return { valid: true };
}

/**
 * Generate a 256-bit vault key
 * @returns {string} Base64-encoded 32-byte key
 */
export function generateVaultKey() {
  const key = cryptoGenerateVaultKey();
  return key.toString('base64');
}

/**
 * Generate a 256-bit recovery key  
 * @returns {string} Base64-encoded 32-byte key
 */
export function generateRecoveryKey() {
  const key = cryptoGenerateRecoveryKey();
  return key.toString('base64');
}

/**
 * Hash passphrase for storage using Argon2id
 * 
 * Used for passphrase verification (is this the right passphrase?) without
 * needing to attempt a full vault key unwrap. Argon2id is already used for
 * key derivation in crypto.js — reusing it here avoids adding a weaker hash.
 * 
 * @param {string} passphrase - Passphrase to hash
 * @param {Buffer} salt - Salt for hashing (reuses the Argon2 salt from setup)
 * @returns {Promise<string>} Hex-encoded Argon2id hash
 */
async function hashPassphrase(passphrase, salt) {
  const { default: argon2 } = await import('argon2');
  const hash = await argon2.hash(passphrase, {
    salt,
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
    raw: true
  });
  return Buffer.from(hash).toString('hex');
}

/**
 * Main setup orchestration
 * @param {object} options - Setup options
 * @param {object} options.io - IO interface with write() and prompt() methods
 * @param {string} options.passphrase - Backup passphrase
 * @param {string} [options.passphraseConfirm] - Passphrase confirmation
 * @param {string} options.backupPath - Local backup directory path
 * @param {boolean} [options.skipScan] - Skip environment scan
 * @param {boolean} [options.skipConfirmation] - Skip final confirmation prompt
 */
export async function runSetup(options) {
  const { io, passphrase, passphraseConfirm, backupPath, skipScan, skipConfirmation } = options;
  
  // Prerequisites (age, node, etc.) are checked by the CLI preflight.
  // If someone calls runSetup programmatically, they're responsible for prereqs.

  // 1. Check for existing config
  const configPath = path.join(os.homedir(), '.openclaw', 'lobster-backup.json');
  if (fs.existsSync(configPath)) {
    io.write('⚠️  Lobster backup is already configured on this system.');
    const reconfigure = await io.prompt('Would you like to reconfigure? This will replace your current settings. [y/n]: ');
    
    if (reconfigure.toLowerCase() !== 'y' && reconfigure.toLowerCase() !== 'yes') {
      throw new Error('Setup cancelled - existing configuration preserved');
    }
  }

  // 2. Validate passphrase
  const validation = validatePassphrase(passphrase, passphraseConfirm);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // 3. Generate keys
  const vaultKey = generateVaultKey();
  const recoveryKey = generateRecoveryKey();

  // Recovery Key acknowledgment is mandatory: Not skippable. If both 
  // passphrase and recovery key are lost, data is permanently unrecoverable. 
  // No support ticket changes this. The friction is intentional.
  io.write('\n🔑 **IMPORTANT: Your Recovery Key**');
  io.write(`Recovery Key: ${recoveryKey}`);
  io.write('');
  io.write('⚠️  This recovery key cannot be recovered if lost. Store it safely offline.');
  io.write('If you lose both your passphrase and this key, your backups will be unrecoverable.');
  
  const acknowledgment = await io.prompt('Type "I have saved this key" to continue: ');
  if (!/acknowledge|saved|confirm/i.test(acknowledgment)) {
    throw new Error('You must acknowledge that you have saved the recovery key to proceed');
  }

  // 5. Create backup directory
  const resolvedBackupPath = backupPath.startsWith('~') 
    ? path.join(os.homedir(), backupPath.slice(2))
    : backupPath;
    
  if (!fs.existsSync(resolvedBackupPath)) {
    fs.mkdirSync(resolvedBackupPath, { recursive: true });
  }

  // 6. Generate encryption parameters
  const salt = generateSalt();
  const passphraseKey = await derivePassphraseKey(passphrase, salt);
  const vaultKeyBuffer = Buffer.from(vaultKey, 'base64');
  const recoveryKeyBuffer = Buffer.from(recoveryKey, 'base64');
  
  const vaultKeyWrappedPassphrase = await wrapVaultKey(vaultKeyBuffer, passphraseKey);
  const vaultKeyWrappedRecovery = await wrapVaultKey(vaultKeyBuffer, recoveryKeyBuffer);

  // 7. Show summary
  io.write('\n📋 **Setup Summary**');
  io.write(`Backup destination: ${resolvedBackupPath}`);
  io.write('Schedule: Hourly (last 24) + Daily (last 7)');
  io.write('Files: ~/.openclaw workspace + registered external dependencies');

  // 8. Final confirmation (unless skipped)
  if (!skipConfirmation) {
    const confirm = await io.prompt('Activate backup with these settings? [y/n]: ');
    if (confirm.toLowerCase() === 'n' || confirm.toLowerCase() === 'no') {
      throw new Error('Setup cancelled by user - no configuration written');
    }
  }

  // 9. Write configuration
  const config = {
    backupPath: resolvedBackupPath,
    vaultKeyWrappedPassphrase: vaultKeyWrappedPassphrase.toString('base64'),
    vaultKeyWrappedRecovery: vaultKeyWrappedRecovery.toString('base64'),
    argon2Salt: salt.toString('base64'),
    formatVersion: 1,
    schedule: {
      hourly: true,
      daily: true
    },
    exclusions: [],
    passphraseHash: await hashPassphrase(passphrase, salt)
  };

  writeConfig(config);

  // Does NOT auto-modify AGENTS.md: Skills should not auto-modify core agent 
  // files. The snippet is printed; the human decides. This is a trust boundary.
  io.write('\n✅ Lobster backup has been configured successfully!');
  io.write('');
  io.write('╔══════════════════════════════════════════════════════════════════╗');
  io.write('║                     ⚠️  REQUIRED NEXT STEPS                     ║');
  io.write('╠══════════════════════════════════════════════════════════════════╣');
  io.write('║                                                                  ║');
  io.write('║  1. Run `lobster scan --register` to discover and register       ║');
  io.write('║     system files (Caddy configs, systemd units, etc.)            ║');
  io.write('║     Without this, backups only include ~/.openclaw/              ║');
  io.write('║                                                                  ║');
  io.write('║  2. Add this to your AGENTS.md:                                  ║');
  io.write('║                                                                  ║');
  io.write('║     ## Lobsterfile Maintenance (lobster-backup)                  ║');
  io.write('║     Whenever a prompt leads you to make any change to the        ║');
  io.write('║     system environment — installing a package, enabling a        ║');
  io.write('║     service, creating a user, modifying a config file outside    ║');
  io.write('║     the workspace, registering an external dependency — you      ║');
  io.write('║     MUST append the corresponding step(s) to the Lobsterfile     ║');
  io.write('║     before considering the task complete. Same obligation as     ║');
  io.write('║     updating MEMORY.md.                                          ║');
  io.write('║                                                                  ║');
  io.write('║  Backups without scan = workspace only. No system configs.       ║');
  io.write('║  Backups without AGENTS.md update = Lobsterfile won\'t grow.     ║');
  io.write('║                                                                  ║');
  io.write('╚══════════════════════════════════════════════════════════════════╝');
  io.write('');
}

/**
 * Run environment audit to bootstrap existing installations
 * @param {string} outputDir - Directory to write lobsterfile.seed
 */
export async function runEnvironmentAudit(outputDir) {
  const results = {
    packages: [],
    services: [],
    npmPackages: [],
    pipPackages: []
  };

  // Environment audit gracefully skips missing tools: Not every machine has 
  // pip or systemctl. The audit should capture what it can, not fail on 
  // what it can't.
  try {
    // APT packages
    const aptOutput = execSync('dpkg --get-selections | grep -v deinstall', { 
      encoding: 'utf-8', 
      stdio: 'pipe' 
    });
    results.packages = aptOutput.trim().split('\n')
      .filter(line => line.trim())
      .map(line => line.split('\t')[0]);
  } catch (error) {
    // Gracefully handle missing dpkg
  }

  try {
    // Global npm packages
    const npmOutput = execSync('npm list -g --depth=0', { 
      encoding: 'utf-8', 
      stdio: 'pipe' 
    });
    // Parse npm output to extract package names
    results.npmPackages = npmOutput.split('\n')
      .filter(line => line.includes('@'))
      .map(line => line.split('@')[0].trim())
      .filter(pkg => pkg && pkg !== '');
  } catch (error) {
    // Gracefully handle missing npm
  }

  try {
    // Enabled systemd services
    const systemctlOutput = execSync('systemctl list-unit-files --state=enabled', { 
      encoding: 'utf-8', 
      stdio: 'pipe' 
    });
    results.services = systemctlOutput.split('\n')
      .filter(line => line.includes('enabled'))
      .map(line => line.split(/\s+/)[0])
      .filter(service => service && service.endsWith('.service'));
  } catch (error) {
    // Gracefully handle missing systemctl
  }

  try {
    // Python packages (optional)
    const pipOutput = execSync('pip list', { 
      encoding: 'utf-8', 
      stdio: 'pipe' 
    });
    // Basic parsing - skip header lines
    results.pipPackages = pipOutput.split('\n')
      .slice(2) // Skip header
      .filter(line => line.trim())
      .map(line => line.split(/\s+/)[0])
      .filter(pkg => pkg);
  } catch (error) {
    // Gracefully skip if pip not available
  }

  // lobsterfile.seed is "inferred, not authoritative": It captures current 
  // package state, not the sequence of commands that built it. May include 
  // system packages that predate the claw. The agent should refine over time.
  let seedContent = '#!/bin/bash\n';
  seedContent += '# lobsterfile.seed — inferred environment (not authoritative)\n';
  seedContent += '# Generated by environment audit - review and refine as needed\n';
  seedContent += '# This captures current state, not the build sequence\n\n';

  // Add APT packages
  if (results.packages.length > 0) {
    seedContent += '# APT packages\n';
    for (const pkg of results.packages) {
      seedContent += `apt-get install -y ${pkg}\n`;
    }
    seedContent += '\n';
  }

  // Add npm packages
  if (results.npmPackages.length > 0) {
    seedContent += '# Global npm packages\n';
    for (const pkg of results.npmPackages) {
      seedContent += `npm install -g ${pkg}\n`;
    }
    seedContent += '\n';
  }

  // Add enabled services
  if (results.services.length > 0) {
    seedContent += '# Enabled services\n';
    for (const service of results.services) {
      seedContent += `systemctl enable ${service}\n`;
    }
    seedContent += '\n';
  }

  // Write seed file
  const seedPath = path.join(outputDir, 'lobsterfile.seed');
  
  // Don't overwrite existing Lobsterfile
  const lobsterfilePath = path.join(outputDir, 'lobsterfile');
  if (fs.existsSync(lobsterfilePath)) {
    // Only write .seed, not the main file
  }
  
  fs.writeFileSync(seedPath, seedContent);
}

/**
 * Re-export detectPlaceholders from lobsterfile.js
 */
export const detectPlaceholders = lobsterfileDetectPlaceholders;

/**
 * Write variables to lobsterfile.env file
 * @param {object} vars - Variables to write (key: value pairs)
 */
export function writeLobsterfileEnv(vars) {
  // Standard location for lobsterfile.env
  const envPath = path.join(process.cwd(), 'lobsterfile.env');
  
  let content = '';
  
  // Add header if file doesn't exist
  if (!fs.existsSync(envPath)) {
    content = '# lobsterfile.env — captured at backup time\n';
  }
  
  // Add variables
  for (const [key, value] of Object.entries(vars)) {
    content += `${key}=${value}\n`;
  }
  
  fs.writeFileSync(envPath, content);
}