/**
 * inspect.js — Inspect a lobster-backup archive
 * 
 * Decrypts and extracts a backup, then displays its contents:
 * archive structure, meta.json, manifests, and Lobsterfile.
 * Replacement for the old bash inspect.sh that broke when we
 * switched to wrapped age private keys.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decryptBackup, listBackups } from './restore.js';

/**
 * Run the inspect workflow
 * @param {Object} params
 * @param {Object} params.config - lobster-backup config
 * @param {string} [params.backupFile] - specific backup file (path or filename)
 * @param {string} params.credentialType - 'passphrase' or 'recovery'
 * @param {string} [params.passphrase]
 * @param {string} [params.recoveryKey]
 * @param {Object} params.io - IO interface
 */
export async function runInspect({ config, backupFile, credentialType, passphrase, recoveryKey, io }) {
  // Resolve which backup to inspect
  let archivePath;
  
  if (backupFile) {
    // Could be a full path or just a filename
    if (path.isAbsolute(backupFile)) {
      archivePath = backupFile;
    } else if (fs.existsSync(backupFile)) {
      archivePath = path.resolve(backupFile);
    } else {
      // Try in the backup directory
      const candidate = path.join(config.backupPath, backupFile);
      if (fs.existsSync(candidate)) {
        archivePath = candidate;
      } else {
        throw new Error(`Backup file not found: ${backupFile}`);
      }
    }
  } else {
    // Use most recent backup
    const backups = listBackups(config.backupPath);
    if (backups.length === 0) {
      throw new Error(`No backups found in ${config.backupPath}`);
    }
    archivePath = backups[0].path;
  }

  io.write(`🦞 Inspecting: ${path.basename(archivePath)}\n`);

  // Decrypt
  io.write('→ Decrypting...');
  const decryptResult = await decryptBackup({
    archivePath,
    credentialType,
    passphrase,
    recoveryKey,
    config,
  });

  // Write decrypted tarball to temp file
  const decryptedPath = path.join(os.tmpdir(), `lobster-inspect-${Date.now()}.tar.gz`);
  fs.writeFileSync(decryptedPath, decryptResult.data);

  // Extract to temp directory
  const inspectDir = path.join(os.tmpdir(), `lobster-inspect-${Date.now()}`);
  fs.mkdirSync(inspectDir, { recursive: true });

  try {
    io.write('→ Extracting...\n');
    execFileSync('tar', ['-xzf', decryptedPath, '-C', inspectDir], { stdio: 'pipe' });

    // Clean up decrypted tarball immediately
    try { fs.unlinkSync(decryptedPath); } catch { /* ignore */ }

    // Show archive structure
    io.write('=== Archive Structure ===');
    const files = walkDir(inspectDir);
    for (const f of files.sort()) {
      io.write(`  ${f}`);
    }
    io.write('');

    // Show meta.json
    const metaPath = path.join(inspectDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      io.write('=== meta.json ===');
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        io.write(JSON.stringify(meta, null, 2));
      } catch {
        io.write(fs.readFileSync(metaPath, 'utf-8'));
      }
      io.write('');
    }

    // Show internal manifest
    const internalPath = path.join(inspectDir, 'manifest-internal.json');
    if (fs.existsSync(internalPath)) {
      io.write('=== Internal manifest ===');
      try {
        const manifest = JSON.parse(fs.readFileSync(internalPath, 'utf-8'));
        io.write(JSON.stringify(manifest, null, 2));
      } catch {
        io.write(fs.readFileSync(internalPath, 'utf-8'));
      }
      io.write('');
    }

    // Show external manifest
    const externalPath = path.join(inspectDir, 'manifest-external.json');
    if (fs.existsSync(externalPath)) {
      io.write('=== External manifest ===');
      try {
        const manifest = JSON.parse(fs.readFileSync(externalPath, 'utf-8'));
        io.write(JSON.stringify(manifest, null, 2));
      } catch {
        io.write(fs.readFileSync(externalPath, 'utf-8'));
      }
      io.write('');
    }

    // Show Lobsterfile
    const lobsterfilePath = path.join(inspectDir, 'lobsterfile');
    if (fs.existsSync(lobsterfilePath)) {
      io.write('=== Lobsterfile ===');
      io.write(fs.readFileSync(lobsterfilePath, 'utf-8'));
      io.write('');
    }

    // Show lobsterfile.env
    const envPath = path.join(inspectDir, 'lobsterfile.env');
    if (fs.existsSync(envPath)) {
      io.write('=== lobsterfile.env ===');
      io.write(fs.readFileSync(envPath, 'utf-8'));
      io.write('');
    }

    io.write(`📂 Full contents extracted to: ${inspectDir}`);
    io.write(`   Clean up when done: rm -rf ${inspectDir}`);

  } catch (error) {
    // Clean up on failure
    try { fs.unlinkSync(decryptedPath); } catch { /* ignore */ }
    try { fs.rmSync(inspectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Recursively list all files in a directory (relative paths)
 */
function walkDir(dir, prefix = '') {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...walkDir(path.join(dir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}
