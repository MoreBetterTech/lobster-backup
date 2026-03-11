/**
 * Lobster Scan - System File Scanner
 * 
 * Scans system locations for files likely related to the OpenClaw environment
 * and helps users register relevant ones in the external manifest.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Read scan inputs from OpenClaw configuration
 * @returns {object} Scan inputs including gateway port, workspace path, and grep targets
 */
export function readScanInputs() {
  const home = os.homedir();
  const openclawJsonPath = path.join(home, '.openclaw', 'openclaw.json');
  const externalManifestPath = path.join(home, '.openclaw', 'lobster-external-manifest.json');
  
  let gatewayPort = 18789;  // default
  let workspacePath = path.join(home, '.openclaw', 'workspace');  // default
  let warning = null;
  
  // Try to read openclaw.json
  if (fs.existsSync(openclawJsonPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(openclawJsonPath, 'utf8'));
      if (config.port) gatewayPort = config.port;
      if (config.workspace) workspacePath = config.workspace;
    } catch (error) {
      warning = `Failed to parse openclaw.json: ${error.message}. Using defaults.`;
    }
  } else {
    warning = 'openclaw.json not found. Using default port patterns.';
  }
  
  // Build grep targets
  const grepTargets = [
    gatewayPort.toString(),
    workspacePath,
    '8501',   // Common Streamlit port
    '18889'   // Secondary OpenClaw instance
  ];
  
  // Read existing external manifest
  let existingManifest = [];
  if (fs.existsSync(externalManifestPath)) {
    try {
      existingManifest = JSON.parse(fs.readFileSync(externalManifestPath, 'utf8'));
      if (!Array.isArray(existingManifest)) existingManifest = [];
    } catch (error) {
      // If manifest is corrupted, start with empty array
      existingManifest = [];
    }
  }
  
  return {
    gatewayPort,
    workspacePath,
    grepTargets,
    existingManifest,
    warning
  };
}

/**
 * Scan paths for files that might be related to OpenClaw
 * @param {object} inputs - Scan inputs from readScanInputs()
 * @param {string[]} scanPaths - Array of paths to scan
 * @returns {object[]} Array of findings with path, reason, and snippet
 */
export function scanForFindings(inputs, scanPaths) {
  const findings = [];
  const { grepTargets, existingManifest } = inputs;
  
  for (const scanPath of scanPaths) {
    try {
      scanDirectory(scanPath, inputs, findings);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Skip missing directories gracefully
        continue;
      }
      // For other errors, continue scanning other paths
      continue;
    }
  }
  
  return findings;
}

/**
 * Recursively scan a directory for relevant files
 * @param {string} dirPath - Directory to scan
 * @param {object} inputs - Scan inputs
 * @param {object[]} findings - Array to accumulate findings
 */
function scanDirectory(dirPath, inputs, findings) {
  const { grepTargets, existingManifest } = inputs;
  
  try {
    const entries = fs.readdirSync(dirPath);
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry);
      
      // Skip if already in external manifest
      if (existingManifest.includes(fullPath)) {
        continue;
      }
      
      try {
        const stat = fs.statSync(fullPath);
        
        if (stat.isFile()) {
          // Check if file content matches our grep targets
          const finding = checkFileContent(fullPath, grepTargets);
          if (finding) {
            findings.push(finding);
          }
        }
        
        if (stat.isDirectory()) {
          // For ~/.config directories, check if directory name matches tools
          if (fullPath.includes('.config')) {
            const toolCheck = checkToolReference(fullPath, inputs);
            if (toolCheck) {
              findings.push(toolCheck);
            }
          }
          
          // Recursively scan subdirectories (with depth limit to avoid infinite loops)
          if (shouldScanSubdirectory(fullPath)) {
            scanDirectory(fullPath, inputs, findings);
          }
        }
      } catch (error) {
        if (error.code === 'EACCES') {
          // Skip files we can't access, but warn
          console.warn(`Warning: Permission denied reading ${fullPath}, skipping`);
          continue;
        }
        // Other errors, skip this entry
        continue;
      }
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Directory doesn't exist, that's fine
      return;
    }
    if (error.code === 'EACCES') {
      console.warn(`Warning: Permission denied reading ${dirPath}, skipping`);
      return;
    }
    // Other errors, skip this directory
    return;
  }
}

/**
 * Check if we should scan a subdirectory
 * @param {string} dirPath - Directory path
 * @returns {boolean} Whether to scan subdirectory
 */
function shouldScanSubdirectory(dirPath) {
  // Avoid deep recursion and known uninteresting paths
  const baseName = path.basename(dirPath);
  const skipDirs = ['node_modules', '.git', 'dist', 'build', '__pycache__'];
  
  if (skipDirs.includes(baseName)) {
    return false;
  }
  
  // Limit depth to avoid excessive scanning
  const pathDepth = dirPath.split(path.sep).length;
  return pathDepth < 10;  // Arbitrary depth limit
}

/**
 * Check file content for grep targets
 * @param {string} filePath - File to check
 * @param {string[]} grepTargets - Targets to search for
 * @returns {object|null} Finding object or null
 */
function checkFileContent(filePath, grepTargets) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Check for grep targets or openclaw-related patterns
    let matchedTarget = null;
    for (const target of grepTargets) {
      if (content.includes(target)) {
        matchedTarget = target;
        break;
      }
    }
    
    // Also check for general openclaw/node patterns in systemd files
    if (!matchedTarget && filePath.includes('systemd')) {
      if (content.includes('openclaw') || 
          (content.includes('node') && content.includes('.openclaw'))) {
        matchedTarget = 'openclaw';
      }
    }
    
    if (matchedTarget) {
      let reason = '';
      let snippet = '';
      
      // Generate appropriate reason based on file type and content
      const fileName = path.basename(filePath);
      const dirName = path.dirname(filePath);
      
      if (dirName.includes('systemd') && fileName.endsWith('.service')) {
        reason = 'Systemd unit file that may execute OpenClaw-related processes';
      } else if (fileName === 'Caddyfile' || dirName.includes('caddy')) {
        reason = `Caddy configuration containing port ${matchedTarget}`;
      } else if (dirName.includes('nginx')) {
        reason = `Nginx configuration with proxy to localhost:${matchedTarget}`;
      } else if (content.includes('reverse_proxy') || content.includes('proxy_pass')) {
        reason = `Configuration file with proxy to ${matchedTarget}`;
      } else {
        reason = `Contains reference to ${matchedTarget}`;
      }
      
      // Extract a snippet around the match
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(matchedTarget) || 
            (matchedTarget === 'openclaw' && (lines[i].includes('openclaw') || 
             (lines[i].includes('node') && lines[i].includes('.openclaw'))))) {
          snippet = lines[i].trim();
          if (snippet.length > 80) {
            snippet = snippet.substring(0, 77) + '...';
          }
          break;
        }
      }
      
      return {
        path: filePath,
        reason,
        snippet
      };
    }
  } catch (error) {
    if (error.code === 'EACCES') {
      throw error;  // Re-throw permission errors to be handled by caller
    }
    // For other errors (binary files, encoding issues, etc.), skip
    return null;
  }
  
  return null;
}

/**
 * Check if a directory name matches tools referenced in TOOLS.md
 * @param {string} dirPath - Directory path
 * @param {object} inputs - Scan inputs
 * @returns {object|null} Finding object or null
 */
function checkToolReference(dirPath, inputs) {
  const dirName = path.basename(dirPath);
  
  // Common tools that might have config directories
  const knownTools = [
    'elevenlabs',
    'openai',
    'anthropic',
    'github',
    'slack',
    'discord',
    'telegram',
    'caddy',
    'nginx',
    'openclaw'
  ];
  
  let isRelevantTool = false;
  
  // Check if tools content is provided and mentions this tool
  if (inputs.toolsContent) {
    const toolsLower = inputs.toolsContent.toLowerCase();
    const dirNameLower = dirName.toLowerCase();
    if (toolsLower.includes(dirNameLower) || 
        knownTools.some(tool => tool === dirNameLower)) {
      isRelevantTool = true;
    }
  } else {
    // Fallback to known tools list
    isRelevantTool = knownTools.some(tool => dirName.toLowerCase().includes(tool));
  }
  
  if (isRelevantTool) {
    return {
      path: dirPath,
      reason: `Configuration directory for ${dirName} (potential tool reference)`,
      snippet: `Directory: ${dirName}`
    };
  }
  
  return null;
}

/**
 * Present findings to user (returns as-is for now)
 * @param {object[]} findings - Array of findings
 * @returns {object[]} Same findings array
 */
export function presentFindings(findings) {
  // This is the presentation layer - in a full implementation,
  // this might format findings for display, but tests expect
  // the raw findings array to be returned
  return findings;
}

/**
 * Register confirmed paths to the external manifest
 * @param {string[]} confirmedPaths - Array of paths to register
 */
export function registerFindings(confirmedPaths) {
  const home = os.homedir();
  const externalManifestPath = path.join(home, '.openclaw', 'lobster-external-manifest.json');
  
  let existingManifest = [];
  
  // Read existing manifest if it exists
  if (fs.existsSync(externalManifestPath)) {
    try {
      existingManifest = JSON.parse(fs.readFileSync(externalManifestPath, 'utf8'));
      if (!Array.isArray(existingManifest)) existingManifest = [];
    } catch (error) {
      // If manifest is corrupted, start with empty array
      existingManifest = [];
    }
  }
  
  // Add new paths, avoiding duplicates
  for (const newPath of confirmedPaths) {
    if (!existingManifest.includes(newPath)) {
      existingManifest.push(newPath);
    }
  }
  
  // Ensure .openclaw directory exists
  const openclawDir = path.dirname(externalManifestPath);
  if (!fs.existsSync(openclawDir)) {
    fs.mkdirSync(openclawDir, { recursive: true });
  }
  
  // Write updated manifest
  fs.writeFileSync(
    externalManifestPath,
    JSON.stringify(existingManifest, null, 2),
    'utf8'
  );
}