import fs from 'node:fs';
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