/**
 * Lobster Scan - System File Scanner
 * 
 * Heuristic, not audit: scan doesn't guarantee coverage. It catches the 
 * common cases — reverse proxy configs, systemd units, tool configs. 
 * Humans install things the agent never touched; scan is the safety net 
 * for those.
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
  
  // Reads openclaw.json for port: The gateway port is the strongest grep signal. 
  // If Caddy/nginx is proxying to localhost:18789, that's almost certainly OC-related.
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
          // Silently skip permission-denied files. Most are system files 
          // (shadow, ssh keys, apt locks) that are never OC-related.
          // Printing warnings for each one floods the terminal and obscures
          // the actual scan results.
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
      // Silently skip — see note above about permission-denied noise
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
  const baseName = path.basename(dirPath);
  
  // Skip known-uninteresting directories
  const skipDirs = [
    'node_modules', '.git', 'dist', 'build', '__pycache__',
    // System dirs that are never OC-related but contain many permission-denied files:
    'apt', 'dpkg', 'snapd', 'cloud', 'apparmor', 'polkit-1',
    'private', 'udisks2', 'fwupd', 'ldconfig', 'amazon',
    'cache', 'lock', 'lost+found',
  ];
  
  if (skipDirs.includes(baseName)) {
    return false;
  }

  // For /var, only scan specific subdirectories known to hold web/app configs
  if (dirPath.startsWith('/var/')) {
    const allowedVarPaths = ['/var/www', '/var/log/caddy', '/var/log/nginx'];
    const isAllowed = allowedVarPaths.some(p => dirPath.startsWith(p) || dirPath === p.slice(0, dirPath.length));
    if (!isAllowed && dirPath.split(path.sep).length > 3) {
      return false; // Don't recurse deep into /var/lib/*, /var/cache/*, etc.
    }
  }
  
  // Limit depth to avoid excessive scanning
  const pathDepth = dirPath.split(path.sep).length;
  return pathDepth < 8;
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
 * Verify that external dependencies in the manifest have corresponding
 * install/enable steps in the Lobsterfile. Warns about gaps that would
 * cause restore to fail (e.g., Caddyfile restored but Caddy not installed).
 * 
 * @param {string[]} externalManifest - Array of registered external paths
 * @param {string} lobsterfileContent - Content of the Lobsterfile
 * @returns {object[]} Array of warnings { path, package, type, message }
 */
export function verifyLobsterfileCoverage(externalManifest, lobsterfileContent) {
  const warnings = [];
  const lfLower = lobsterfileContent.toLowerCase();
  
  // Map of path patterns to expected packages/services
  const pathToPackage = [
    { pattern: /\/caddy\//i, pkg: 'caddy', service: 'caddy' },
    { pattern: /\/nginx\//i, pkg: 'nginx', service: 'nginx' },
    { pattern: /\/apache2?\//i, pkg: 'apache2', service: 'apache2' },
    { pattern: /\/redis\//i, pkg: 'redis-server', service: 'redis' },
    { pattern: /\/postgresql\//i, pkg: 'postgresql', service: 'postgresql' },
    { pattern: /\/mysql\//i, pkg: 'mysql-server', service: 'mysql' },
    { pattern: /\/docker\//i, pkg: 'docker', service: 'docker' },
  ];
  
  // Check each external path for known service patterns
  for (const extPath of externalManifest) {
    for (const { pattern, pkg, service } of pathToPackage) {
      if (pattern.test(extPath)) {
        // Check if Lobsterfile mentions installing or enabling this package
        const hasInstall = lfLower.includes(`install`) && lfLower.includes(pkg);
        const hasEnable = lfLower.includes(`enable`) && lfLower.includes(service);
        
        if (!hasInstall) {
          warnings.push({
            path: extPath,
            package: pkg,
            type: 'missing-install',
            message: `${extPath} registered but no '${pkg}' install found in Lobsterfile`,
          });
        }
        if (!hasEnable) {
          warnings.push({
            path: extPath,
            package: service,
            type: 'missing-enable',
            message: `${extPath} registered but no '${service}' service enable found in Lobsterfile`,
          });
        }
        break;  // Only match first pattern per path
      }
    }
    
    // Check systemd units — the service file itself should have an enable step
    if (extPath.includes('/systemd/') && extPath.endsWith('.service')) {
      const serviceName = path.basename(extPath);
      if (!lfLower.includes(serviceName.replace('.service', ''))) {
        warnings.push({
          path: extPath,
          package: serviceName,
          type: 'missing-service',
          message: `${extPath} registered but '${serviceName}' not referenced in Lobsterfile`,
        });
      }
    }
  }
  
  return warnings;
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