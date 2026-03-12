/**
 * backup.js — Core backup functionality for lobster-backup
 * 
 * Implements backup orchestration, locking, archive creation, and encryption.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { generateInternalManifest, readExternalManifest, detectGitRepo } from './manifest.js';
import { detectNewVariables, parseEnvFile } from './lobsterfile-env.js';
import { encryptArchive } from './crypto.js';

let lockFilePath;

/**
 * Get the path to the lock file
 */
function getLockPath() {
  if (!lockFilePath) {
    lockFilePath = path.join(os.homedir(), '.openclaw', 'lobster-backup.lock');
  }
  return lockFilePath;
}

/**
 * Acquire lock file with current PID
 * 
 * PID-based lock file: Prevents concurrent backups. Uses kill(pid, 0) to 
 * detect if lock-holder is still alive. Dead process = stale lock that's 
 * safe to recover. This is cheaper and more reliable than file timestamps 
 * for stale detection.
 */
export function acquireLock() {
  const lockPath = getLockPath();
  
  if (fs.existsSync(lockPath)) {
    const existingPid = fs.readFileSync(lockPath, 'utf8').trim();
    const pid = parseInt(existingPid);
    
    if (isNaN(pid)) {
      // Invalid PID in lock file, treat as stale
      fs.unlinkSync(lockPath);
    } else {
      try {
        // kill(pid, 0) checks if process exists without sending a signal
        process.kill(pid, 0);
        // If we get here, process is alive
        throw new Error('Backup is already running or locked by another process');
      } catch (error) {
        if (error.code === 'ESRCH') {
          // Process is dead (No such process), clean up stale lock
          fs.unlinkSync(lockPath);
        } else {
          // Re-throw other errors (like permission denied or our custom error)
          throw error;
        }
      }
    }
  }
  
  // Create new lock file with current PID
  fs.writeFileSync(lockPath, process.pid.toString());
}

/**
 * Release the lock file
 */
export function releaseLock() {
  const lockPath = getLockPath();
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    // Ignore errors if lock file doesn't exist
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Check for stale lock files and clean them up
 * This is primarily for external tools to check lock state
 */
export function checkStaleLock() {
  const lockPath = getLockPath();
  
  if (!fs.existsSync(lockPath)) {
    return false; // No lock exists
  }
  
  const existingPid = fs.readFileSync(lockPath, 'utf8').trim();
  
  try {
    process.kill(parseInt(existingPid), 0);
    return true; // Process is alive, lock is valid
  } catch (error) {
    if (error.code === 'ESRCH') {
      // Process is dead, clean up stale lock
      fs.unlinkSync(lockPath);
      return false; // Lock was stale and has been cleaned up
    }
    throw error;
  }
}

/**
 * Create the backup archive (tarball)
 * @param {object} options - Archive creation options
 * @param {string[]} options.internalManifest - List of internal files to backup
 * @param {string[]} options.externalManifest - List of external files to backup  
 * @param {string} options.backupDir - Directory to store backup
 * @param {string} [options.lobsterfilePath] - Path to lobsterfile
 * @param {string} [options.lobsterfileEnvPath] - Path to lobsterfile.env
 * @param {object[]} [options.gitRepos] - Array of git repo info with hasRemote flag
 * @returns {Promise<string>} Path to created tarball
 */
export async function createArchive(options) {
  const {
    internalManifest = [],
    externalManifest = [],
    backupDir,
    lobsterfilePath,
    lobsterfileEnvPath,
    gitRepos = []
  } = options;
  
  const timestamp = new Date().toISOString().replace(/\./g, '').slice(0, 19);
  const tarballPath = path.join(backupDir, `backup-${timestamp}.tar.gz`);
  
  // Create backup directory if it doesn't exist
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  
  // Create temporary directory for staging files
  const tempDir = path.join(backupDir, `.tmp-${timestamp}`);
  fs.mkdirSync(tempDir, { recursive: true });
  
  try {
    // Get OpenClaw version
    let ocVersion = 'unknown';
    try {
      ocVersion = execSync('openclaw --version', { encoding: 'utf8' }).trim();
    } catch (error) {
      // Fallback if openclaw command fails
      ocVersion = 'unknown';
    }
    
    // Create meta.json
    const meta = {
      ocVersion,
      timestamp: new Date().toISOString(),
      checksums: {
        internal: 'placeholder', // TODO: implement actual checksums
        external: 'placeholder'
      }
    };
    fs.writeFileSync(path.join(tempDir, 'meta.json'), JSON.stringify(meta, null, 2));
    
    // Write manifest files
    fs.writeFileSync(
      path.join(tempDir, 'manifest-internal.json'),
      JSON.stringify(internalManifest, null, 2)
    );
    fs.writeFileSync(
      path.join(tempDir, 'manifest-external.json'),
      JSON.stringify(externalManifest, null, 2)
    );
    
    // Build tar command
    let tarCmd = `tar -czf "${tarballPath}"`;
    
    // Add exclusions
    const exclusions = [
      '--exclude=node_modules',
      '--exclude=.git',
      '--exclude=__pycache__',
      '--exclude=*.pyc',
      '--exclude=*.pyo',
      '--exclude=.venv',
      '--exclude=venv',
      '--exclude=env',
      '--exclude=dist',
      '--exclude=build',
      '--exclude=*.tar.gz',
      '--exclude=*.zip'
    ];
    tarCmd += ` ${exclusions.join(' ')}`;
    
    // Add files at top level
    tarCmd += ` -C "${tempDir}" meta.json manifest-internal.json manifest-external.json`;
    
    // Add lobsterfile if provided
    if (lobsterfilePath && fs.existsSync(lobsterfilePath)) {
      tarCmd += ` --add-file="${lobsterfilePath}" --transform='s|.*/||'`;
    }
    
    // Add lobsterfile.env if provided
    if (lobsterfileEnvPath && fs.existsSync(lobsterfileEnvPath)) {
      tarCmd += ` --add-file="${lobsterfileEnvPath}" --transform='s|.*/||'`;
    }
    
    // Add internal files with internal/ prefix
    for (const filePath of internalManifest) {
      if (fs.existsSync(filePath)) {
        const homeDir = os.homedir();
        const openclawDir = path.join(homeDir, '.openclaw');
        
        if (filePath.startsWith(openclawDir)) {
          // Strip the ~/.openclaw prefix and add internal/ prefix
          const relativePath = path.relative(openclawDir, filePath);
          tarCmd += ` --add-file="${filePath}" --transform='s|^|internal/|'`;
        }
      }
    }
    
    // Add external files with external/ prefix (excluding git repos with remotes)
    for (const filePath of externalManifest) {
      // Git repos with remotes skip tarballing: Tarballing a git repo gives 
      // a snapshot without history (since .git/ is excluded). A fresh 
      // 'git clone' from the remote is strictly better — you get full 
      // history AND the correct reconstitution path.
      const repo = gitRepos.find(r => r.path === filePath);
      if (repo && repo.hasRemote) {
        continue; // Skip - this is handled by Lobsterfile clone entries
      }
      
      if (fs.existsSync(filePath)) {
        // Strip leading / and add external/ prefix
        const pathWithoutRoot = filePath.startsWith('/') ? filePath.slice(1) : filePath;
        tarCmd += ` --add-file="${filePath}" --transform='s|^|external/${pathWithoutRoot}|'`;
      }
    }
    
    // Execute tar command
    execSync(tarCmd, { stdio: 'pipe' });
    
    return tarballPath;
  } finally {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Run the complete backup process
 * @param {object} options - Backup options
 * @param {object} options.config - Backup configuration
 * @param {boolean} [options.dryRun] - If true, don't actually create backup
 * @param {boolean} [options.now] - If true, this is a manual backup
 * @param {boolean} [options.forceError] - For testing - force an error
 * @param {boolean} [options.detectOnly] - Only detect new variables, don't backup
 * @returns {Promise<object>} Result object with success, filename, warnings, etc.
 */
export async function runBackup(options) {
  const {
    config,
    dryRun = false,
    now = false,
    forceError = false,
    detectOnly = false
  } = options;
  
  let lockAcquired = false;
  let tempFiles = [];
  
  try {
    // Acquire lock
    acquireLock();
    lockAcquired = true;
    
    // Generate timestamp for filename
    const timestamp = new Date().toISOString().replace(/\./g, '').slice(0, 19);
    const filename = `backup-${timestamp}.tar.gz.age`;
    
    const warnings = [];
    
    // Check for new lobsterfile.env variables if detectOnly
    if (detectOnly) {
      const homeDir = os.homedir();
      const lobsterfilePath = path.join(homeDir, '.openclaw', 'lobsterfile');
      const lobsterfileEnvPath = path.join(homeDir, '.openclaw', 'lobsterfile.env');
      
      if (fs.existsSync(lobsterfilePath)) {
        const lobsterfileContent = fs.readFileSync(lobsterfilePath, 'utf8');
        
        let existingEnv = {};
        if (fs.existsSync(lobsterfileEnvPath)) {
          const envContent = fs.readFileSync(lobsterfileEnvPath, 'utf8');
          existingEnv = parseEnvFile(envContent);
        }
        
        const newVariables = detectNewVariables(lobsterfileContent, existingEnv);
        return { newVariables };
      } else {
        return { newVariables: [] };
      }
    }
    
    // Generate manifests
    const internalManifest = generateInternalManifest();
    
    // Check for external manifest
    const externalManifestPath = path.join(os.homedir(), '.openclaw', 'lobster-external-manifest.json');
    let externalManifest = [];
    
    if (!fs.existsSync(externalManifestPath)) {
      warnings.push('No external manifest found - proceeding with internal files only');
    } else {
      try {
        externalManifest = readExternalManifest() || [];
      } catch (error) {
        warnings.push('Error reading external manifest - proceeding with internal files only');
      }
    }
    
    // Ensure externalManifest is an array
    if (!Array.isArray(externalManifest)) {
      externalManifest = [];
    }
    
    // If dry run, return early
    if (dryRun) {
      return {
        filename,
        success: true,
        manual: !!now,
        warnings
      };
    }
    
    // Force error for testing
    if (forceError) {
      throw new Error('Forced error for testing');
    }
    
    // Create archive
    const homeDir = os.homedir();
    const lobsterfilePath = path.join(homeDir, '.openclaw', 'lobsterfile');
    const lobsterfileEnvPath = path.join(homeDir, '.openclaw', 'lobsterfile.env');
    
    // Detect git repos
    const gitRepos = [];
    for (const filePath of externalManifest) {
      const repoInfo = detectGitRepo(filePath);
      if (repoInfo) {
        gitRepos.push(repoInfo);
      }
    }
    
    const tarballPath = await createArchive({
      internalManifest,
      externalManifest,
      backupDir: config.backupPath,
      lobsterfilePath,
      lobsterfileEnvPath,
      gitRepos
    });
    
    tempFiles.push(tarballPath);
    
    // Encrypt archive  
    const encryptedPath = path.join(config.backupPath, filename);
    await encryptArchive({
      inputPath: tarballPath,
      outputPath: encryptedPath,
      recipients: config.recipients || ['age1defaultpublickey'] // fallback for tests
    });
    
    // Plaintext cleanup on encryption success: Security-critical.
    // If age succeeds, we must delete the unencrypted tarball with secrets.
    fs.unlinkSync(tarballPath);
    tempFiles = tempFiles.filter(f => f !== tarballPath);
    
    return {
      filename,
      success: true,
      manual: !!now,
      warnings
    };
    
  } catch (error) {
    // Plaintext cleanup on encryption failure: Security-critical. If age 
    // fails mid-encrypt, an unencrypted tarball with secrets sits on disk.
    // The finally/catch blocks ensure it's deleted.
    for (const file of tempFiles) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
    
    // Clean up lock file on error as well
    if (lockAcquired) {
      releaseLock();
      lockAcquired = false;
    }
    
    throw error;
  } finally {
    // Lock file in finally block: The lock MUST be released even on error.
    // A leaked lock blocks all future backups until manual intervention.
    if (lockAcquired) {
      releaseLock();
    }
  }
}