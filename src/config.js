import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Get the path to the config file
 */
function getConfigPath() {
  return path.join(os.homedir(), '.openclaw', 'lobster-backup.json');
}

/**
 * Read configuration from ~/.openclaw/lobster-backup.json
 * 
 * Defaults when no config: First-run experience shouldn't crash. Return 
 * sensible defaults so other code can check for unconfigured state gracefully.
 */
export function readConfig() {
  const configPath = getConfigPath();
  
  if (!fs.existsSync(configPath)) {
    // Return sensible defaults when no config exists
    return {
      backupPath: '~/lobster-backups',
      schedule: { hourly: true, daily: true },
      exclusions: [],
    };
  }
  
  const content = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Write configuration to ~/.openclaw/lobster-backup.json with restrictive permissions
 * 
 * 0o600 permissions: Config contains wrapped keys. World-readable config on 
 * a multi-user server (like newdev-utils with both Paul and Nellie) would be 
 * a privilege escalation vector.
 */
export function writeConfig(config) {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);
  
  // Ensure the directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  // Restrictive permissions prevent other users from reading wrapped keys
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Validate config has all required fields
 * Returns { valid: boolean, errors: string[] }
 */
export function validateConfig(config) {
  const errors = [];
  
  const requiredFields = [
    'backupPath',
    'passphraseHash', 
    'vaultKeyWrappedPassphrase',
    'vaultKeyWrappedRecovery',
    'argon2Salt',
    'schedule',
    'exclusions',
    'formatVersion'
  ];
  
  for (const field of requiredFields) {
    if (!(field in config)) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  // Type validations
  if (typeof config.backupPath !== 'string' && config.backupPath !== undefined) {
    errors.push('backupPath must be a string');
  }
  
  if (!Array.isArray(config.exclusions) && config.exclusions !== undefined) {
    errors.push('exclusions must be an array');
  }
  
  if (typeof config.schedule !== 'object' && config.schedule !== undefined) {
    errors.push('schedule must be an object');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Resolve ~ and environment variables in config paths
 */
export function resolveConfigPaths(config) {
  const resolved = { ...config };
  
  if (resolved.backupPath && typeof resolved.backupPath === 'string') {
    if (resolved.backupPath.startsWith('~/')) {
      resolved.backupPath = path.join(os.homedir(), resolved.backupPath.slice(2));
    }
  }
  
  return resolved;
}