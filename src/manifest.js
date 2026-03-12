import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

/**
 * Default exclusion patterns (always excluded)
 */
const DEFAULT_EXCLUSIONS = [
  '.git/',
  'node_modules/',
  '*.log',
  'tmp/',
  'cache/',
  '.cache/'
];

/**
 * Check if a path matches any exclusion pattern
 */
function isExcluded(filePath, exclusions = []) {
  const allExclusions = [...DEFAULT_EXCLUSIONS, ...exclusions];
  
  for (const pattern of allExclusions) {
    if (pattern.endsWith('/')) {
      // Directory pattern
      if (filePath.includes(pattern) || filePath.includes(pattern.slice(0, -1))) {
        return true;
      }
    } else if (pattern.startsWith('*')) {
      // File extension pattern
      if (filePath.endsWith(pattern.slice(1))) {
        return true;
      }
    } else {
      // Exact match
      if (filePath.includes(pattern)) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Recursively walk a directory and collect all files
 * Skips excluded directories and files
 */
function walkDirectory(dir, exclusions = []) {
  const files = [];
  
  if (!fs.existsSync(dir)) {
    return files;
  }
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        // Don't traverse excluded directories: Performance. Walking into 
        // node_modules/ on a large project can take seconds and find nothing 
        // useful. Exclude at the directory level, not the file level.
        if (!isExcluded(fullPath + '/', exclusions)) {
          files.push(...walkDirectory(fullPath, exclusions));
        }
      } else if (entry.isFile()) {
        if (!isExcluded(fullPath, exclusions)) {
          files.push(fullPath);
        }
      }
    }
  } catch (error) {
    // Skip directories we can't read
  }
  
  return files;
}

/**
 * Generate internal manifest - files from ~/.openclaw/
 * @param {string} ocDir - Path to .openclaw directory (defaults to ~/.openclaw)
 * @param {object} config - Configuration with exclusions
 * @returns {Array} List of files to backup
 */
export function generateInternalManifest(ocDir = null, config = {}) {
  if (!ocDir) {
    ocDir = path.join(os.homedir(), '.openclaw');
  }
  
  const exclusions = config.exclusions || [];
  const files = [];
  
  // Specific paths to include
  const specificPaths = [
    'workspace/MEMORY.md',
    'workspace/SOUL.md', 
    'workspace/USER.md',
    'workspace/IDENTITY.md',
    'workspace/AGENTS.md',
    'workspace/TOOLS.md',
    'workspace/HEARTBEAT.md',
    'openclaw.json',
    'cron/jobs.json'
  ];
  
  // Add specific paths if they exist
  for (const relativePath of specificPaths) {
    const fullPath = path.join(ocDir, relativePath);
    if (fs.existsSync(fullPath) && !isExcluded(fullPath, exclusions)) {
      files.push(fullPath);
    }
  }
  
  // Walk specific directories
  const directories = [
    'workspace/memory',
    'skills',
    'identity'
  ];
  
  for (const dir of directories) {
    const fullDir = path.join(ocDir, dir);
    files.push(...walkDirectory(fullDir, exclusions));
  }
  
  return files;
}

/**
 * Read external manifest from ~/.openclaw/lobster-external-manifest.json
 * @returns {Array} List of external paths
 */
export function readExternalManifest() {
  const manifestPath = path.join(os.homedir(), '.openclaw', 'lobster-external-manifest.json');
  
  if (!fs.existsSync(manifestPath)) {
    return [];
  }
  
  const content = fs.readFileSync(manifestPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Register a new external path in the manifest
 * @param {string} pathToRegister - Path to add
 */
export function registerExternalPath(pathToRegister) {
  const ocDir = path.join(os.homedir(), '.openclaw');
  
  // Reject internal paths in external manifest: Prevents double-backup and 
  // confusion. Internal files are always backed up. Registering them 
  // externally would create ambiguous restore behavior.
  if (pathToRegister.includes(ocDir)) {
    throw new Error('Cannot register internal OpenClaw path as external');
  }
  
  const manifestPath = path.join(ocDir, 'lobster-external-manifest.json');
  const existing = readExternalManifest();
  
  // Deduplicate
  if (!existing.includes(pathToRegister)) {
    existing.push(pathToRegister);
  }
  
  // Ensure directory exists
  const manifestDir = path.dirname(manifestPath);
  if (!fs.existsSync(manifestDir)) {
    fs.mkdirSync(manifestDir, { recursive: true });
  }
  
  fs.writeFileSync(manifestPath, JSON.stringify(existing, null, 2));
}

/**
 * Detect if a directory is a git repository and extract metadata
 * @param {string} dirPath - Path to check
 * @returns {object} Git repo information
 */
export function detectGitRepo(dirPath) {
  const result = {
    isGitRepo: false,
    remoteUrl: null,
    ref: null
  };
  
  const gitDir = path.join(dirPath, '.git');
  if (!fs.existsSync(gitDir)) {
    return result;
  }
  
  result.isGitRepo = true;
  
  try {
    // Get remote URL (prefer origin)
    try {
      const remoteOutput = execSync('git remote get-url origin', { 
        cwd: dirPath, 
        encoding: 'utf-8',
        stdio: 'pipe'
      });
      result.remoteUrl = remoteOutput.trim();
    } catch (error) {
      // No remote named origin, or no remotes at all
      result.remoteUrl = null;
    }
    
    // Git repo detection: detached HEAD → commit SHA. If someone is on a 
    // detached HEAD, pinning to the branch name would be wrong (there isn't 
    // one). The commit SHA is the only correct ref.
    try {
      // First, check if we're in detached HEAD state
      try {
        execSync('git symbolic-ref HEAD', { 
          cwd: dirPath, 
          encoding: 'utf-8',
          stdio: 'pipe'
        });
        // symbolic-ref succeeded, so we're on a branch - get the branch name
        const refOutput = execSync('git rev-parse --abbrev-ref HEAD', { 
          cwd: dirPath, 
          encoding: 'utf-8',
          stdio: 'pipe'
        });
        result.ref = refOutput.trim();
      } catch (symbolicError) {
        // symbolic-ref failed, we're in detached HEAD - get commit SHA
        const commitOutput = execSync('git rev-parse HEAD', { 
          cwd: dirPath, 
          encoding: 'utf-8',
          stdio: 'pipe'
        });
        result.ref = commitOutput.trim();
      }
    } catch (error) {
      result.ref = null;
    }
  } catch (error) {
    // Git commands failed - leave defaults
  }
  
  return result;
}

/**
 * Generate git clone + checkout entry for Lobsterfile
 * @param {object} gitInfo - Git repository information
 * @returns {string} Bash commands for Lobsterfile
 */
export function generateGitCloneEntry(gitInfo) {
  const { remoteUrl, localPath, ref } = gitInfo;
  
  let entry = `# Clone ${remoteUrl} to ${localPath}\n`;
  entry += `git clone ${remoteUrl} ${localPath}\n`;
  entry += `cd ${localPath}\n`;
  
  if (ref) {
    entry += `git checkout ${ref}\n`;
  }
  
  return entry;
}

/**
 * Resolve symlink handling
 * 
 * Symlinks preserved by default: A symlink IS semantic information — it says 
 * "this is an alias." Dereferencing loses that. But warn if the target isn't 
 * in the backup, because a dangling symlink after restore is useless.
 * 
 * @param {string} linkPath - Path to symlink
 * @param {object} options - Options for symlink handling
 * @returns {object} Symlink resolution result
 */
export function resolveSymlinks(linkPath, options = {}) {
  const result = {
    preserveSymlink: true, // Preserve semantic information by default
    target: null,
    warning: null
  };
  
  try {
    const stats = fs.lstatSync(linkPath);
    
    if (!stats.isSymbolicLink()) {
      result.preserveSymlink = false;
      return result;
    }
    
    result.target = fs.readlinkSync(linkPath);
    
    // If dereference option is set, follow the symlink
    if (options.dereference) {
      result.preserveSymlink = false;
      return result;
    }
    
    // Check if target is included in backup
    if (options.manifestPaths) {
      const targetIsIncluded = options.manifestPaths.some(p => 
        result.target.startsWith(p) || p === result.target
      );
      
      if (!targetIsIncluded) {
        result.warning = `Symlink target ${result.target} is not included in backup manifest`;
      }
    }
  } catch (error) {
    // Handle case where symlink can't be read
    result.warning = `Could not read symlink: ${error.message}`;
  }
  
  return result;
}