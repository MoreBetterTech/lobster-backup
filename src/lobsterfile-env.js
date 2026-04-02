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
    
    // Strict variable names [A-Z_][A-Z0-9_]*: Prevents injection via variable 
    // names. If we allowed arbitrary characters, a variable name containing 
    // shell metacharacters could be a vector when substituted into bash.
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
  // Replace {{VARIABLE_NAME}} with values, but skip bash comment lines.
  // The Lobsterfile header contains "Use {{VARIABLE}} placeholders..." as
  // documentation — substituting inside comments would throw "Missing variable"
  // for the example placeholder and break restore on an otherwise valid file.
  const lines = template.split('\n');
  const result = lines.map(line => {
    // Skip comment lines — don't substitute inside bash comments
    if (line.trimStart().startsWith('#')) {
      return line;
    }
    // Missing variable throws, not silently skips: A Lobsterfile with 
    // {{GATEWAY_PORT}} that substitutes to nothing would produce 
    // `reverse_proxy localhost:` — a broken config deployed with sudo. Fail loudly.
    return line.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (match, variableName) => {
      if (!(variableName in variables)) {
        throw new Error(`Missing variable: ${variableName}`);
      }
      return variables[variableName];
    });
  }).join('\n');
  
  return result;
}

/**
 * Write environment variables to lobsterfile.env file
 * @param {string} envFilePath - Path to env file
 * @param {object} variables - Variables to write
 */
export function writeEnvFile(envFilePath, variables) {
  let content = '';
  
  // Preserve comments when writing: Users annotate their env files. 
  // Blowing away comments on every write is hostile.
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
  // Use same placeholder detection logic as lobsterfile.js, but skip comment lines.
  // Comments may contain example placeholders (e.g. "Use {{VARIABLE}} for...").
  const variables = new Set();
  
  const placeholderRegex = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
  const lines = lobsterfileContent.split('\n');
  
  for (const line of lines) {
    // Skip comment lines
    if (line.trimStart().startsWith('#')) continue;
    
    let match;
    while ((match = placeholderRegex.exec(line)) !== null) {
      const variableName = match[1];
      if (variableName) {
        variables.add(variableName);
      }
    }
  }
  
  // Filter out variables that already exist
  const newVariables = Array.from(variables).filter(
    variableName => !(variableName in existingEnv)
  );
  
  return newVariables;
}