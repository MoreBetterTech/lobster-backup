import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Read existing Lobsterfile content
 * @param {string} lobsterfilePath - Path to the Lobsterfile
 * @returns {string} File content
 */
export function readLobsterfile(lobsterfilePath) {
  if (!fs.existsSync(lobsterfilePath)) {
    return '';
  }
  
  return fs.readFileSync(lobsterfilePath, 'utf-8');
}

/**
 * Append a new step to the Lobsterfile
 * @param {string} lobsterfilePath - Path to the Lobsterfile
 * @param {string} content - Content to append
 */
export function appendToLobsterfile(lobsterfilePath, content) {
  fs.appendFileSync(lobsterfilePath, content);
}

/**
 * Validate Lobsterfile is syntactically valid bash
 * 
 * bash -n validation: Cheap syntax check before execution. Catches obvious 
 * errors (unclosed quotes, mismatched brackets) without running anything. 
 * This is the last gate before the Lobsterfile gets sudo powers.
 * 
 * @param {string} content - Lobsterfile content to validate
 * @returns {object} Validation result { valid: boolean, error?: string }
 */
export function validateLobsterfile(content) {
  try {
    // Use bash -n to check syntax without executing
    execSync('bash -n', { 
      input: content,
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    
    return { valid: true };
  } catch (error) {
    return { 
      valid: false, 
      error: error.message 
    };
  }
}

/**
 * Initialize a new Lobsterfile at the given path.
 * Creates the file with a shebang + header. Optionally seeds from lobsterfile.seed.
 * 
 * This is the missing piece — setup generated lobsterfile.seed but never promoted
 * it to the actual Lobsterfile. Without this, the backup silently skips the
 * Lobsterfile and restore can't rebuild the environment.
 * 
 * @param {string} lobsterfilePath - Path to create the Lobsterfile
 * @param {object} [options] - Options
 * @param {string} [options.seedPath] - Path to lobsterfile.seed to incorporate
 * @param {boolean} [options.force] - Overwrite existing Lobsterfile
 * @returns {object} { created: boolean, path: string, seeded: boolean }
 */
export function initLobsterfile(lobsterfilePath, options = {}) {
  const { seedPath, force = false } = options;
  
  // Don't overwrite existing Lobsterfile unless forced
  if (fs.existsSync(lobsterfilePath) && !force) {
    return { created: false, path: lobsterfilePath, seeded: false, reason: 'already exists' };
  }
  
  let content = '#!/bin/bash\n';
  content += '# Lobsterfile — system environment rebuild script\n';
  content += '# Maintained in real-time by the agent. Updated whenever system state changes.\n';
  content += '# This file is turned into a bash script for automated restore.\n';
  content += '#\n';
  content += '# Rules:\n';
  content += '#   - Prefix commands requiring root with sudo\n';
  content += '#   - Write every step idempotently\n';
  content += '#   - Use {{VARIABLE}} placeholders for environment-specific values\n';
  content += '\n';
  
  let seeded = false;
  
  // If a seed file exists, incorporate its content (minus the header)
  if (seedPath && fs.existsSync(seedPath)) {
    const seedContent = fs.readFileSync(seedPath, 'utf-8');
    const seedLines = seedContent.split('\n');
    // Skip the seed header: contiguous block of comment/blank lines at the top.
    // Header ends at the first non-comment, non-blank line (an actual command).
    let firstCommandIdx = seedLines.findIndex(line => 
      line.trim() !== '' && !line.trim().startsWith('#')
    );
    if (firstCommandIdx === -1) firstCommandIdx = seedLines.length;
    const seedBody = seedLines.slice(firstCommandIdx).join('\n');
    
    if (seedBody.trim()) {
      content += '# --- Seeded from environment audit ---\n';
      content += seedBody + '\n';
      content += '# --- End seed ---\n\n';
      seeded = true;
    }
  }
  
  // Ensure parent directory exists
  const dir = path.dirname(lobsterfilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  fs.writeFileSync(lobsterfilePath, content, { mode: 0o644 });
  
  return { created: true, path: lobsterfilePath, seeded };
}

/**
 * Detect {{VARIABLE}} placeholders in content
 * @param {string} content - Content to scan for placeholders
 * @returns {string[]} Array of unique variable names
 */
export function detectPlaceholders(content) {
  const variables = new Set();
  
  // Match {{VARIABLE_NAME}} pattern
  // Variables must start with A-Z or _, followed by A-Z, 0-9, or _
  const placeholderRegex = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
  
  let match;
  while ((match = placeholderRegex.exec(content)) !== null) {
    const variableName = match[1];
    
    // Empty {{}} is an error: A malformed placeholder should be caught at 
    // validation time, not silently ignored during substitution where it 
    // would produce broken commands.
    if (!variableName) {
      throw new Error('Empty placeholder {{}} found - malformed variable');
    }
    
    variables.add(variableName);
  }
  
  // Check for empty placeholders explicitly
  if (content.includes('{{}}')) {
    throw new Error('Empty placeholder {{}} found - malformed variable');
  }
  
  return Array.from(variables);
}