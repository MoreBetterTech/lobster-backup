/**
 * restore.js — Restore module for lobster-backup
 * 
 * Implements backup listing, selection, decryption, file restoration,
 * Lobsterfile execution, and complete restore orchestration.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { decryptArchive, derivePassphraseKey, unwrapVaultKey } from './crypto.js';
import { substituteVariables, parseEnvFile } from './lobsterfile-env.js';

/**
 * List available backup files in the backup directory
 * @param {string} backupDir - Directory containing backup files
 * @returns {Array} Array of backup objects with {filename, timestamp, size, path}
 */
export function listBackups(backupDir) {
  try {
    const files = fs.readdirSync(backupDir);
    
    // Filter for backup-*.tar.gz.age files (supports both colon and dash timestamps)
    const backupFiles = files.filter(file => 
      /^backup-\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2}\.tar\.gz\.age$/.test(file)
    );
    
    // Convert to backup objects with metadata
    const backups = backupFiles.map(filename => {
      const fullPath = path.join(backupDir, filename);
      const stats = fs.statSync(fullPath);
      
      // Extract timestamp from filename (convert dashes back to colons for Date parsing)
      const timestampMatch = filename.match(/backup-(\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2})/);
      let timestamp;
      if (timestampMatch) {
        // Normalize separators: the time portion uses dashes in new format
        const raw = timestampMatch[1];
        const normalized = raw.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
        timestamp = new Date(normalized);
      } else {
        timestamp = new Date(0);
      }
      
      return {
        filename,
        timestamp,
        size: stats.size,
        path: fullPath
      };
    });
    
    // Sort by timestamp (newest first)
    return backups.sort((a, b) => b.timestamp - a.timestamp);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Backup directory not found: ${backupDir}`);
    }
    throw error;
  }
}

/**
 * Select a backup file based on options
 * @param {string} backupDir - Directory containing backup files
 * @param {Object} options - Selection options
 * @param {string} [options.from] - Specific backup file path
 * @param {boolean} [options.interactive] - Enter interactive selection mode
 * @returns {Object} Selection result
 */
export function selectBackup(backupDir, options = {}) {
  if (options.from) {
    // Specific backup requested
    if (!fs.existsSync(options.from)) {
      throw new Error(`Backup file not found: ${options.from}`);
    }
    return { selectedPath: options.from };
  }
  
  if (options.interactive) {
    // Interactive mode - return backup list for user selection
    const backups = listBackups(backupDir);
    return { backups, interactive: true };
  }
  
  // Default: auto-select most recent
  const backups = listBackups(backupDir);
  if (backups.length === 0) {
    throw new Error(`No backup files found in ${backupDir}`);
  }
  
  return { selectedPath: backups[0].path };
}

/**
 * Check OpenClaw version compatibility
 * @param {Object} params - Version comparison parameters
 * @param {string} params.backupVersion - Version from backup metadata
 * @param {string} params.currentVersion - Current OC version
 * @returns {Object} Version check result
 */
export function checkOCVersion({ backupVersion, currentVersion }) {
  // Simple version comparison (assuming semver-like format)
  const parseVersion = (version) => {
    return version.split('.').map(Number);
  };
  
  const backup = parseVersion(backupVersion);
  const current = parseVersion(currentVersion);
  
  // Compare version arrays
  for (let i = 0; i < Math.max(backup.length, current.length); i++) {
    const b = backup[i] || 0;
    const c = current[i] || 0;
    
    if (b > c) {
      // Version check: newer backup on older OC warns but doesn't block. 
      // The user might be restoring to an older machine intentionally. 
      // Hard-blocking would make disaster recovery harder. Warn and let them decide.
      return {
        warning: `This backup was created with OpenClaw ${backupVersion}. You are running ${currentVersion}. We recommend updating OpenClaw first.`,
        promptRequired: true
      };
    }
    
    if (c > b) {
      return {
        proceed: true,
        note: `Restoring backup from OpenClaw ${backupVersion} to ${currentVersion} (newer version)`
      };
    }
  }
  
  // Same version
  return { proceed: true };
}

/**
 * Check for existing OpenClaw installation
 * @returns {Object} Installation check result
 */
export function checkExistingInstall() {
  const ocDir = path.join(os.homedir(), '.openclaw');
  
  if (fs.existsSync(ocDir)) {
    return {
      existingInstall: true,
      warning: "An existing OpenClaw installation was detected. Proceeding will overwrite your current workspace.",
      offerBackup: true
    };
  }
  
  return { existingInstall: false };
}

/**
 * Verify archive integrity using checksums
 * @param {Object|null} meta - Metadata from meta.json
 * @param {Object} archiveFiles - Files and their checksums from archive
 * @param {Object} [options] - Verification options
 * @param {number} [options.expectedVersion] - Expected format version
 * @returns {Object} Verification result
 */
export function verifyArchiveIntegrity(meta, archiveFiles, options = {}) {
  if (!meta) {
    throw new Error("Archive metadata (meta.json) is missing or required");
  }
  
  // Check format version if specified
  if (options.expectedVersion && meta.formatVersion !== options.expectedVersion) {
    return {
      versionWarning: `Archive format version ${meta.formatVersion} differs from expected ${options.expectedVersion}`,
      promptRequired: true,
      valid: true
    };
  }
  
  // Verify checksums
  if (meta.checksums) {
    for (const [filePath, expectedChecksum] of Object.entries(meta.checksums)) {
      const actualChecksum = archiveFiles[filePath];
      if (actualChecksum !== expectedChecksum) {
        throw new Error(`Checksum mismatch for ${filePath}: archive may be corrupted`);
      }
    }
  }
  
  return { valid: true };
}

/**
 * Preview what would be restored without actually restoring
 * @param {Object} params - Restore preview parameters
 * @param {Array} params.internalFiles - Internal files to restore
 * @param {Array} params.externalFiles - External files to restore
 * @param {string} params.lobsterfile - Lobsterfile content
 * @returns {Object} Preview of what would be restored
 */
export function dryRunRestore({ internalFiles, externalFiles, lobsterfile }) {
  return {
    wouldRestore: {
      internal: internalFiles || [],
      external: externalFiles || [],
      lobsterfile: !!(lobsterfile && lobsterfile.trim())
    }
  };
}

/**
 * Prompt for decryption credential
 * @param {Object} mockIO - IO interface for prompting
 * @returns {Promise} Prompt result
 */
export async function promptForCredential(mockIO) {
  return await mockIO.prompt();
}

/**
 * Decrypt a backup archive using age
 * @param {Object} params - Decryption parameters
 * @param {string} params.archivePath - Path to encrypted archive
 * @param {string} params.credentialType - Type of credential ('passphrase' or 'recovery')
 * @param {string} [params.passphrase] - Passphrase for decryption
 * @param {string} [params.recoveryKey] - Recovery key for decryption
 * @param {Object} params.config - Configuration with wrapped keys and salts
 * @returns {Promise<Object>} Decryption result
 */
export async function decryptBackup({ archivePath, credentialType, passphrase, recoveryKey, config }) {
  try {
    // Step 1: Verify credentials by unwrapping the vault key.
    // This proves the passphrase/recovery key is correct before we attempt decryption.
    if (credentialType === 'passphrase' && passphrase) {
      if (!config.argon2Salt || !config.vaultKeyWrappedPassphrase) {
        throw new Error('Missing Argon2 salt or wrapped vault key in config');
      }
      const salt = Buffer.from(config.argon2Salt, 'base64');
      const wrappingKey = await derivePassphraseKey(passphrase, salt);
      const wrappedVaultKey = Buffer.from(config.vaultKeyWrappedPassphrase, 'base64');
      await unwrapVaultKey(wrappedVaultKey, wrappingKey);
    } else if (credentialType === 'recovery' && recoveryKey) {
      if (!config.vaultKeyWrappedRecovery) {
        throw new Error('Missing recovery-wrapped vault key in config');
      }
      const recoveryKeyBuffer = Buffer.from(recoveryKey, 'base64');
      const wrappedVaultKey = Buffer.from(config.vaultKeyWrappedRecovery, 'base64');
      await unwrapVaultKey(wrappedVaultKey, recoveryKeyBuffer);
    } else {
      throw new Error('Invalid credential type or missing credentials');
    }

    // Step 2: Use the age private key from config to decrypt the archive.
    // The private key is what age needs to decrypt files encrypted to the matching public key.
    if (!config.agePrivateKey) {
      throw new Error('Missing age private key in config — was setup completed?');
    }

    const tmpIdentityPath = path.join(os.tmpdir(), `lobster-identity-${Date.now()}`);
    try {
      fs.writeFileSync(tmpIdentityPath, config.agePrivateKey + '\n', { mode: 0o600 });

      // Step 3: Decrypt archive using the age private key
      const result = await decryptArchive({
        inputPath: archivePath,
        identityPath: tmpIdentityPath,
      });
      return { success: true, data: result };
    } finally {
      // Always clean up the temporary identity file — it contains key material
      try { fs.unlinkSync(tmpIdentityPath); } catch { /* ignore */ }
    }

  } catch (error) {
    const errorMsg = error.message.toLowerCase();

    // Check unwrap failures first — these mean wrong passphrase/recovery key
    if (errorMsg.includes('failed to unwrap') || errorMsg.includes('corrupted data')) {
      throw new Error('Wrong passphrase or recovery key provided');
    }
    if (errorMsg.includes('no identity') || errorMsg.includes('matched')) {
      throw new Error('Wrong passphrase or recovery key provided');
    }
    // Archive-level errors (age reports header issues)
    if (errorMsg.includes('header is invalid')) {
      throw new Error('Archive is corrupted or has an invalid header');
    }
    if (errorMsg.includes('failed') || errorMsg.includes('incorrect')) {
      throw new Error('Decryption failed - check your credentials');
    }

    throw error;
  }
}

/**
 * Restore files from extracted archive
 * @param {Object} params - File restoration parameters
 * @param {string} params.archiveDir - Directory containing extracted files
 * @param {Array} params.internalFiles - Internal files to restore
 * @param {Array} params.externalFiles - External files to restore
 * @param {Array} [params.symlinks] - Symlinks to restore
 * @param {boolean} [params.preservePermissions] - Whether to preserve file permissions
 */
export function restoreFiles({ archiveDir, internalFiles, externalFiles, symlinks, preservePermissions }) {
  const homeDir = os.homedir();
  const ocDir = path.join(homeDir, '.openclaw');

  /**
   * Copy a file, optionally preserving its original permissions.
   */
  function copyFile(sourcePath, targetPath) {
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const content = fs.readFileSync(sourcePath);
    fs.writeFileSync(targetPath, content);
    if (preservePermissions) {
      try {
        const stats = fs.statSync(sourcePath);
        fs.chmodSync(targetPath, stats.mode);
      } catch { /* best-effort */ }
    }
  }

  // Restore internal files to ~/.openclaw/
  if (internalFiles && internalFiles.length > 0) {
    for (const relativePath of internalFiles) {
      const sourcePath = path.join(archiveDir, 'internal', relativePath);
      const targetPath = path.join(ocDir, relativePath);
      copyFile(sourcePath, targetPath);
    }
  }

  // Restore external files to their original absolute paths.
  // External manifest stores paths WITHOUT leading '/' (stripped during backup).
  // We prepend '/' here to reconstruct the absolute path.
  if (externalFiles && externalFiles.length > 0) {
    for (const relativePath of externalFiles) {
      const sourcePath = path.join(archiveDir, 'external', relativePath);
      const targetPath = path.join('/', relativePath);

      // Use sudo for system paths — avoids running entire restore as root
      if (targetPath.startsWith('/etc/') || targetPath.startsWith('/var/')) {
        const targetDir = path.dirname(targetPath);
        execFileSync('sudo', ['mkdir', '-p', targetDir], { stdio: 'pipe' });
        execFileSync('sudo', ['cp', sourcePath, targetPath], { stdio: 'pipe' });
        if (preservePermissions) {
          try {
            const stats = fs.statSync(sourcePath);
            const mode = (stats.mode & 0o7777).toString(8);
            execFileSync('sudo', ['chmod', mode, targetPath], { stdio: 'pipe' });
          } catch { /* best-effort */ }
        }
      } else {
        copyFile(sourcePath, targetPath);
      }
    }
  }

  // Restore symlinks
  if (symlinks && symlinks.length > 0) {
    for (const symlink of symlinks) {
      const { linkPath, target } = symlink;

      // Create parent directory
      const linkDir = path.dirname(linkPath);
      if (!fs.existsSync(linkDir)) {
        fs.mkdirSync(linkDir, { recursive: true });
      }

      // Create symlink
      fs.symlinkSync(target, linkPath);
    }
  }
}

/**
 * Display Lobsterfile content for user review
 * 
 * Lobsterfile review is unskippable: A Lobsterfile is a bash script with 
 * embedded sudo commands. Executing it without review would be like running 
 * `curl | sudo bash` — the user MUST have the opportunity to read it.
 * 
 * @param {string} content - Lobsterfile content
 * @param {Object} mockIO - IO interface
 * @returns {Promise<Object>} User confirmation result
 */
export async function displayLobsterfile(content, mockIO) {
  mockIO.write("=== Lobsterfile Review ===\n");
  mockIO.write("The following commands will be executed:\n\n");
  mockIO.write(content);
  mockIO.write("\n\nThese commands will run with sudo where prefixed. Review carefully.\n");
  
  const confirmed = await mockIO.prompt("Proceed with execution? (y/n): ");
  
  return { confirmed: confirmed.toLowerCase() === 'y' };
}

/**
 * Substitute variables in Lobsterfile content
 * @param {string} content - Lobsterfile content with {{VARIABLE}} placeholders
 * @param {Object} envVars - Environment variables for substitution
 * @param {Object} [mockIO] - IO interface for prompting (if provided, will prompt for updates)
 * @returns {Promise<string>|string} Substituted content (async if mockIO provided, sync otherwise)
 */
export function substituteLobsterfile(content, envVars, mockIO) {
  if (mockIO) {
    // Interactive mode - prompt for variable updates
    return (async () => {
      mockIO.write("=== Environment Variables ===\n");
      mockIO.write("Review and update environment variables if needed:\n\n");
      
      const updatedVars = { ...envVars };
      
      for (const [key, value] of Object.entries(envVars)) {
        mockIO.write(`${key} = ${value}\n`);
        const newValue = await mockIO.prompt(`Update ${key} (enter to keep current): `);
        if (newValue.trim()) {
          updatedVars[key] = newValue.trim();
        }
      }
      
      return substituteVariables(content, updatedVars);
    })();
  } else {
    // Synchronous mode - just substitute
    return substituteVariables(content, envVars);
  }
}

/**
 * Execute Lobsterfile bash script
 * @param {Object} params - Execution parameters
 * @param {string} params.content - Lobsterfile content
 * @param {Object} params.envVars - Environment variables for substitution
 * @param {boolean} [params.dryRun] - If true, display but don't execute
 * @param {boolean} [params.continueOnError] - If true, continue executing on errors
 * @param {Object} [params.io] - IO interface for output
 * @returns {Promise<Object>} Execution result
 */
export async function executeLobsterfile({ content, envVars, dryRun, continueOnError, io }) {
  // Substitute variables
  const substitutedContent = substituteVariables(content, envVars);
  
  if (dryRun) {
    if (io) {
      io.write("=== Dry Run - Lobsterfile Preview ===\n");
      io.write(substitutedContent);
      io.write("\n=== End Preview ===\n");
    }
    return { displayed: true };
  }
  
  // Write to temporary file
  const tempPath = `/tmp/lobsterfile-exec-${Date.now()}.sh`;
  fs.writeFileSync(tempPath, substitutedContent, 'utf-8');
  
  const failures = [];
  let exitCode = 0;
  
  // sudo inline, not run-as-root: The restore script runs as regular user. 
  // sudo in the Lobsterfile provides per-command privilege escalation with 
  // syslog audit trail. Running the entire restore as root violates 
  // least-privilege and removes the audit benefit.
  try {
    if (continueOnError) {
      // --continue-on-error as opt-in: For experienced users who know which 
      // steps are independent and want to batch through failures. Not the 
      // default because it requires judgment.
      const lines = substitutedContent.split('\n').filter(line => 
        line.trim() && !line.trim().startsWith('#')
      );
      
      for (const line of lines) {
        try {
          execSync(line, { stdio: 'pipe' });
        } catch (error) {
          failures.push({
            step: line,
            error: error.message
          });
        }
      }
      
      if (failures.length > 0) {
        exitCode = 1;
      }
    } else {
      // fail-fast default for Lobsterfile execution: A failed step early in 
      // the script likely means subsequent steps will fail too (e.g., if apt 
      // install fails, the service that depends on it won't start). Continuing 
      // wastes time and potentially leaves the system in a worse state.
      execSync(`bash ${tempPath}`, { stdio: 'pipe' });
    }
  } catch (error) {
    exitCode = 1;
    if (!continueOnError) {
      throw error;
    }
  } finally {
    // Temp file cleanup after Lobsterfile execution: The substituted script 
    // contains real commands with real values (IPs, domains, ports). Leaving 
    // it in /tmp is an information leak.
    fs.unlinkSync(tempPath);
  }
  
  const nextSteps = [
    "Restart OpenClaw gateway to apply configuration changes",
    "Run lobster scan to verify all services are properly restored"
  ];
  
  const result = { exitCode, nextSteps };
  if (failures.length > 0) {
    result.failures = failures;
  }
  
  return result;
}

/**
 * Compute SHA-256 checksums for all files in an extracted archive directory
 * @param {string} extractDir - Directory containing extracted archive files
 * @returns {Object} Map of relative file paths to their SHA-256 hex digests
 */
export function computeArchiveChecksums(extractDir) {
  const checksums = {};

  function walkDir(dir, prefix = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkDir(fullPath, relativePath);
      } else if (entry.isFile()) {
        // Skip meta.json itself — its checksums field can't include its own hash
        if (relativePath === 'meta.json') continue;
        const content = fs.readFileSync(fullPath);
        const hash = createHash('sha256').update(content).digest('hex');
        checksums[relativePath] = hash;
      }
    }
  }

  walkDir(extractDir);
  return checksums;
}

/**
 * Main restore orchestration function
 * @param {Object} params - Restore parameters
 * @param {Object} params.config - Configuration object
 * @param {boolean} [params.dryRun] - If true, preview only
 * @param {Object} params.io - IO interface for user interaction
 * @returns {Promise<Object>} Restore result
 */
export async function runRestore({ config, dryRun, io, from, credentialType, passphrase, recoveryKey }) {
  // Step 1: Select backup
  const selection = selectBackup(config.backupPath, { from });
  if (!selection.selectedPath) {
    throw new Error('No backup selected');
  }
  const archivePath = selection.selectedPath;
  io.write(`Selected backup: ${path.basename(archivePath)}\n`);

  // Step 2: Preflight checks
  const installCheck = checkExistingInstall();
  if (installCheck.existingInstall) {
    io.write(`⚠️  ${installCheck.warning}\n`);
    if (installCheck.offerBackup) {
      const proceed = await io.prompt('Continue anyway? [y/n]: ');
      if (proceed.toLowerCase() !== 'y') {
        return { restored: false, cancelled: true };
      }
    }
  }

  // Step 3: Dry run preview
  if (dryRun) {
    io.write('=== Dry Run Preview ===\n');
    io.write(`Archive: ${path.basename(archivePath)}\n`);
    io.write('No changes will be made.\n');
    return {
      restored: false,
      dryRun: true,
      completed: true,
      preview: `Would restore from ${path.basename(archivePath)}`
    };
  }

  // Step 4: Decrypt backup using the vault key unwrapping chain
  io.write('Decrypting backup archive...\n');
  const decryptResult = await decryptBackup({
    archivePath,
    credentialType: credentialType || 'passphrase',
    passphrase,
    recoveryKey,
    config,
  });

  // Step 5: Extract archive to temp directory
  const extractDir = path.join(os.tmpdir(), `lobster-restore-${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'pipe' });

    // Step 6: Verify integrity via checksums in meta.json
    const metaPath = path.join(extractDir, 'meta.json');
    let meta = null;
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }

    if (meta && meta.checksums) {
      io.write('Verifying archive integrity...\n');
      const archiveChecksums = computeArchiveChecksums(extractDir);
      verifyArchiveIntegrity(meta, archiveChecksums);
    }

    // Step 7: Read manifests
    const internalManifestPath = path.join(extractDir, 'manifest-internal.json');
    const externalManifestPath = path.join(extractDir, 'manifest-external.json');
    const internalFiles = fs.existsSync(internalManifestPath)
      ? JSON.parse(fs.readFileSync(internalManifestPath, 'utf8'))
      : [];
    const externalFiles = fs.existsSync(externalManifestPath)
      ? JSON.parse(fs.readFileSync(externalManifestPath, 'utf8'))
      : [];

    // Step 8: Restore files
    io.write('Restoring files...\n');
    restoreFiles({
      archiveDir: extractDir,
      internalFiles,
      externalFiles,
      preservePermissions: true,
    });

    // Step 9: Handle Lobsterfile
    const lobsterfilePath = path.join(extractDir, 'lobsterfile');
    if (fs.existsSync(lobsterfilePath)) {
      const lobsterfileContent = fs.readFileSync(lobsterfilePath, 'utf8');

      // Load env vars
      const envFilePath = path.join(extractDir, 'lobsterfile.env');
      let envVars = {};
      if (fs.existsSync(envFilePath)) {
        envVars = parseEnvFile(fs.readFileSync(envFilePath, 'utf8'));
      }

      // Prompt for variable updates
      const substitutedContent = await substituteLobsterfile(lobsterfileContent, envVars, io);

      // Display for review (unskippable)
      const reviewResult = await displayLobsterfile(substitutedContent, io);
      if (reviewResult.confirmed) {
        io.write('Executing Lobsterfile...\n');
        await executeLobsterfile({ content: lobsterfileContent, envVars, io });
      } else {
        io.write('Lobsterfile execution skipped by user.\n');
      }
    }

    io.write('✅ Restore complete!\n');
    return {
      restored: true,
      dryRun: false,
      completed: true,
      filesRestored: { internal: internalFiles.length, external: externalFiles.length },
    };

  } finally {
    // Clean up extraction directory
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}