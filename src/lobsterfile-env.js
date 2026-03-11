import fs from 'node:fs';

/**
 * Parse lobsterfile.env file content into key-value pairs
 * @param {string} content - Content of the env file
 * @returns {object} Object with environment variables
 */
export function parseEnvFile(content) {
  const env = {};
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    
    // Find first = to split key and value
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      continue; // Skip lines without =
    }
    
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1); // Don't trim value to preserve spaces
    
    // Validate variable name - must be [A-Z_][A-Z0-9_]*
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(`Invalid variable name: ${key}. Must match [A-Z_][A-Z0-9_]*`);
    }
    
    env[key] = value;
  }
  
  return env;
}

/**
 * Substitute {{VARIABLE}} placeholders in a string with values
 * @param {string} template - Template string with placeholders
 * @param {object} variables - Object with variable values
 * @returns {string} String with substituted values
 */
export function substituteVariables(template, variables) {
  // Replace {{VARIABLE_NAME}} with values
  // Only replace if the content inside braces is a valid variable name
  const result = template.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (match, variableName) => {
    if (!(variableName in variables)) {
      throw new Error(`Missing variable: ${variableName}`);
    }
    return variables[variableName];
  });
  
  return result;
}

/**
 * Write environment variables to lobsterfile.env file
 * @param {string} envFilePath - Path to env file
 * @param {object} variables - Variables to write
 */
export function writeEnvFile(envFilePath, variables) {
  let content = '';
  
  // Preserve existing comments if file exists
  if (fs.existsSync(envFilePath)) {
    const existing = fs.readFileSync(envFilePath, 'utf-8');
    const lines = existing.split('\n');
    
    // Extract comments and non-variable lines
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed || !trimmed.includes('=')) {
        content += line + '\n';
      }
    }
  } else {
    // Add default header comment for new files
    content = '# lobsterfile.env — captured at backup time\n';
  }
  
  // Add variables
  for (const [key, value] of Object.entries(variables)) {
    content += `${key}=${value}\n`;
  }
  
  fs.writeFileSync(envFilePath, content, 'utf-8');
}

/**
 * Detect new variables in Lobsterfile that aren't in the env file
 * @param {string} lobsterfileContent - Content of the Lobsterfile
 * @param {object} existingEnv - Existing environment variables
 * @returns {string[]} Array of new variable names
 */
export function detectNewVariables(lobsterfileContent, existingEnv) {
  // Use same placeholder detection logic as lobsterfile.js
  const variables = new Set();
  
  const placeholderRegex = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
  let match;
  
  while ((match = placeholderRegex.exec(lobsterfileContent)) !== null) {
    const variableName = match[1];
    if (variableName) {
      variables.add(variableName);
    }
  }
  
  // Filter out variables that already exist
  const newVariables = Array.from(variables).filter(
    variableName => !(variableName in existingEnv)
  );
  
  return newVariables;
}