/**
 * backup.js — Core backup functionality for lobster-backup
 * 
 * Implements backup orchestration, locking, archive creation, and encryption.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { generateInternalManifest, readExternalManifest, detectGitRepo } from './manifest.js';
import { detectNewVariables, parseEnvFile } from './lobsterfile-env.js';
import { encryptArchive } from './crypto.js';
import { detectOS } from './os-detect.js';

/**
 * Capture apt source files and their referenced keyrings.
 * 
 * Third-party packages (Caddy, Node.js, gh) need custom apt repos to install.
 * The environment audit discovers they're installed but not HOW. This function
 * snapshots /etc/apt/sources.list.d/ (excluding default OS sources) and any
 * keyring files they reference via signed-by directives.
 * 
 * @returns {object} { sourceFiles: string[], keyringFiles: string[] }
 */
export function captureAptSources() {
  const sourcesDir = '/etc/apt/sources.list.d';
  const sourceFiles = [];
  const keyringFiles = new Set();
  
  // Default OS source patterns to skip — these come with the OS and don't
  // need to be restored. We only want third-party repos.
  const defaultPatterns = [
    /^ubuntu/i,
    /^debian/i,
  ];
  
  if (!fs.existsSync(sourcesDir)) {
    return { sourceFiles: [], keyringFiles: [] };
  }
  
  const entries = fs.readdirSync(sourcesDir);
  
  for (const entry of entries) {
    // Skip default OS source files
    if (defaultPatterns.some(p => p.test(entry))) {
      continue;
    }
    
    // Only process .list, .sources files (not .save backups)
    if (!entry.endsWith('.list') && !entry.endsWith('.sources')) {
      continue;
    }
    
    const fullPath = path.join(sourcesDir, entry);
    sourceFiles.push(fullPath);
    
    // Parse the file to find signed-by keyring references
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      
      // Match both formats:
      //   deb [signed-by=/usr/share/keyrings/foo.gpg] ...  (.list format)
      //   Signed-By: /usr/share/keyrings/foo.gpg            (.sources format)
      const signedByMatches = content.matchAll(/signed-by[=:]\s*([^\]\s,]+)/gi);
      for (const match of signedByMatches) {
        const keyringPath = match[1].trim();
        if (fs.existsSync(keyringPath)) {
          keyringFiles.add(keyringPath);
        }
      }
    } catch {
      // If we can't read the file, just include it without keyring extraction
    }
  }
  
  return { sourceFiles, keyringFiles: Array.from(keyringFiles) };
}

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
  
  // Replace colons and dots to produce filesystem-safe timestamps (e.g. 2026-03-12T14-32-45)
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
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
    
    // Checksums are computed per-file and stored in meta.json so that 
    // restore can verify archive integrity before touching the filesystem.
    // meta.json itself is excluded from checksums (can't hash its own content).
    const fileChecksums = {};

    function checksumFile(filePath, archiveRelativePath) {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath);
        fileChecksums[archiveRelativePath] = createHash('sha256').update(content).digest('hex');
      }
    }
    
    // Write manifest files
    const manifestInternalContent = JSON.stringify(internalManifest, null, 2);
    const manifestExternalContent = JSON.stringify(externalManifest, null, 2);
    fs.writeFileSync(path.join(tempDir, 'manifest-internal.json'), manifestInternalContent);
    fs.writeFileSync(path.join(tempDir, 'manifest-external.json'), manifestExternalContent);
    checksumFile(path.join(tempDir, 'manifest-internal.json'), 'manifest-internal.json');
    checksumFile(path.join(tempDir, 'manifest-external.json'), 'manifest-external.json');

    // Stage files into tempDir using directory structure instead of --add-file/--transform.
    // This avoids GNU tar-specific flags and eliminates shell injection via filenames.

    // Capture user crontab — system crontab entries (not OpenClaw's internal
    // cron/jobs.json) would be lost on restore. Stored as a file in the archive
    // so restore can replay it with `crontab`.
    try {
      const crontabContent = execSync('crontab -l', { encoding: 'utf8', stdio: 'pipe' });
      if (crontabContent.trim()) {
        fs.writeFileSync(path.join(tempDir, 'crontab'), crontabContent);
        checksumFile(path.join(tempDir, 'crontab'), 'crontab');
      }
    } catch {
      // No crontab for this user — that's fine, skip silently
    }

    // Capture apt sources and referenced keyrings.
    // Third-party packages (Caddy, Node.js, gh CLI) require custom apt repos.
    // `apt-mark showmanual` discovers the package is installed but NOT how it
    // was installed. Without the repo + keyring, `apt install caddy` on a fresh
    // box fails with "package not found." Snapshotting sources.list.d/ and the
    // keyrings they reference solves this generically for any third-party repo.
    try {
      const aptSources = captureAptSources();
      if (aptSources.sourceFiles.length > 0 || aptSources.keyringFiles.length > 0) {
        const aptStageDir = path.join(tempDir, 'apt-sources');
        
        // Stage source files
        for (const sf of aptSources.sourceFiles) {
          const destDir = path.join(aptStageDir, 'sources.list.d');
          fs.mkdirSync(destDir, { recursive: true });
          const destPath = path.join(destDir, path.basename(sf));
          fs.copyFileSync(sf, destPath);
          checksumFile(destPath, `apt-sources/sources.list.d/${path.basename(sf)}`);
        }
        
        // Stage keyring files
        for (const kf of aptSources.keyringFiles) {
          const destDir = path.join(aptStageDir, 'keyrings');
          fs.mkdirSync(destDir, { recursive: true });
          const destPath = path.join(destDir, path.basename(kf));
          fs.copyFileSync(kf, destPath);
          checksumFile(destPath, `apt-sources/keyrings/${path.basename(kf)}`);
        }
      }
    } catch {
      // Apt source capture is best-effort — don't fail the backup
    }

    // Stage lobsterfile if provided
    if (lobsterfilePath && fs.existsSync(lobsterfilePath)) {
      fs.copyFileSync(lobsterfilePath, path.join(tempDir, 'lobsterfile'));
      checksumFile(path.join(tempDir, 'lobsterfile'), 'lobsterfile');
    }

    // Stage lobsterfile.env if provided
    if (lobsterfileEnvPath && fs.existsSync(lobsterfileEnvPath)) {
      fs.copyFileSync(lobsterfileEnvPath, path.join(tempDir, 'lobsterfile.env'));
      checksumFile(path.join(tempDir, 'lobsterfile.env'), 'lobsterfile.env');
    }

    // Stage internal files under internal/ subdirectory
    const internalStageDir = path.join(tempDir, 'internal');
    for (const filePath of internalManifest) {
      if (fs.existsSync(filePath)) {
        const homeDir = os.homedir();
        const openclawDir = path.join(homeDir, '.openclaw');

        if (filePath.startsWith(openclawDir)) {
          const relativePath = path.relative(openclawDir, filePath);
          const destPath = path.join(internalStageDir, relativePath);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(filePath, destPath);
          checksumFile(destPath, `internal/${relativePath}`);
        }
      }
    }

    // Stage external files under external/ subdirectory (excluding git repos with remotes)
    const externalStageDir = path.join(tempDir, 'external');
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
        const pathWithoutRoot = filePath.startsWith('/') ? filePath.slice(1) : filePath;
        const destPath = path.join(externalStageDir, pathWithoutRoot);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(filePath, destPath);
        checksumFile(destPath, `external/${pathWithoutRoot}`);
      }
    }

    // Write meta.json last so it includes all computed checksums.
    // OS info captured here so restore can detect cross-family migrations
    // and translate Lobsterfile commands (e.g. apt → dnf).
    const sourceOS = detectOS();
    const meta = {
      ocVersion,
      timestamp: new Date().toISOString(),
      formatVersion: 1,
      os: {
        id: sourceOS.id,
        name: sourceOS.name,
        version: sourceOS.version,
        family: sourceOS.family,
        arch: sourceOS.arch,
        pretty: sourceOS.pretty,
      },
      checksums: fileChecksums
    };
    fs.writeFileSync(path.join(tempDir, 'meta.json'), JSON.stringify(meta, null, 2));

    // Create tarball from staged directory using execFileSync (no shell injection)
    const tarArgs = ['-czf', tarballPath, '-C', tempDir, '.'];
    execFileSync('tar', tarArgs, { stdio: 'pipe' });
    
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
    // Prerequisites (age, etc.) are checked by the CLI preflight.
    // Acquire lock
    acquireLock();
    lockAcquired = true;
    
    // Generate timestamp for filename (filesystem-safe: no colons or dots)
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
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
    
    // Warn loudly if no Lobsterfile exists — this means restore can't rebuild the environment
    const lobsterfileCheckPath = path.join(os.homedir(), '.openclaw', 'lobsterfile');
    if (!fs.existsSync(lobsterfileCheckPath)) {
      warnings.push('⚠️  No Lobsterfile found! Restore will only restore files — it cannot rebuild packages, services, or system configuration. Run lobster setup or create ~/.openclaw/lobsterfile manually.');
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
      recipients: config.agePublicKey ? [config.agePublicKey] : (config.recipients || [])
    });
    
    // Write decryption sidecar alongside the encrypted archive.
    // Contains the key-wrapping metadata needed to decrypt without
    // ~/.openclaw/lobster-backup.json (solves the chicken/egg problem where
    // the config needed to decrypt is inside the encrypted backup).
    // All fields are safe unencrypted — keys are wrapped, not plaintext.
    const sidecarPath = encryptedPath.replace(/\.age$/, '.meta.json');
    const sidecar = {
      formatVersion: config.formatVersion || 1,
      argon2Salt: config.argon2Salt,
      vaultKeyWrappedPassphrase: config.vaultKeyWrappedPassphrase,
      vaultKeyWrappedRecovery: config.vaultKeyWrappedRecovery,
      agePublicKey: config.agePublicKey,
      agePrivateKeyWrapped: config.agePrivateKeyWrapped,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), { mode: 0o600 });

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