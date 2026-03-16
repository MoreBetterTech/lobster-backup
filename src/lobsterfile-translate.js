/**
 * lobsterfile-translate.js — Cross-distro Lobsterfile translation
 * 
 * Translates Lobsterfile commands when restoring to a different Linux family
 * than the one the backup was made on. Handles package manager commands,
 * repo setup recipes, and distro-specific idioms.
 * 
 * Translation is best-effort: some commands (custom scripts, manual downloads)
 * can't be automatically translated. Those are left as-is with a warning comment.
 */

import { FAMILY_PACKAGE_MANAGERS } from './os-detect.js';

/**
 * Package name mappings between distro families.
 * Most packages have the same name, but some differ.
 */
const PACKAGE_NAME_MAP = {
  // debian name → { rhel, arch, alpine }
  'build-essential': { rhel: 'gcc gcc-c++ make', arch: 'base-devel', alpine: 'build-base' },
  'python3-pip':     { rhel: 'python3-pip',      arch: 'python-pip',  alpine: 'py3-pip' },
  'tesseract-ocr':   { rhel: 'tesseract',        arch: 'tesseract',   alpine: 'tesseract-ocr' },
  'ffmpeg':          { rhel: 'ffmpeg',            arch: 'ffmpeg',      alpine: 'ffmpeg' },
  'age':             { rhel: 'age',               arch: 'age',         alpine: 'age' },
  'sqlite3':         { rhel: 'sqlite',            arch: 'sqlite',      alpine: 'sqlite' },
};

/**
 * Known third-party repo setup patterns and their per-family equivalents.
 * Each entry matches a block of commands and provides replacements.
 */
const REPO_RECIPES = {
  caddy: {
    // Detect Caddy apt repo setup
    detect: (line) => line.includes('cloudsmith.io') && line.includes('caddy'),
    debian: [
      "sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl",
      "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true",
      "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null",
    ],
    rhel: [
      "sudo dnf install -y 'dnf-command(copr)'",
      "sudo dnf copr enable @caddy/caddy -y",
    ],
    arch: [
      "# Caddy: install from community repo or AUR",
    ],
    alpine: [
      "# Caddy: install from community repo",
    ],
  },
  nodesource: {
    detect: (line) => line.includes('nodesource.com'),
    debian: [
      "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -",
    ],
    rhel: [
      "curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -",
    ],
    arch: [
      "# Node.js: available in community repo",
    ],
    alpine: [
      "# Node.js: available in main repo",
    ],
  },
  github_cli: {
    detect: (line) => line.includes('cli.github.com') || line.includes('githubcli-archive-keyring'),
    debian: [
      "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null",
      "sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg",
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli-stable.list > /dev/null',
    ],
    rhel: [
      "sudo dnf install -y 'dnf-command(config-manager)'",
      "sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo",
    ],
    arch: [
      "# gh CLI: available in community repo",
    ],
    alpine: [
      "# gh CLI: install via community or apk",
    ],
  },
};

/**
 * Translate a single Lobsterfile line from one family to another
 * @param {string} line - Original command line
 * @param {string} sourceFamily - Source OS family
 * @param {string} targetFamily - Target OS family
 * @returns {object} { translated: string, changed: boolean, warning?: string }
 */
export function translateLine(line, sourceFamily, targetFamily) {
  let trimmed = line.trim();
  
  // Skip empty lines and comments
  if (!trimmed || trimmed.startsWith('#')) {
    return { translated: line, changed: false };
  }
  
  const sourcePM = FAMILY_PACKAGE_MANAGERS[sourceFamily];
  const targetPM = FAMILY_PACKAGE_MANAGERS[targetFamily];
  
  if (!sourcePM || !targetPM) {
    return { translated: line, changed: false, warning: `Unknown OS family: ${!sourcePM ? sourceFamily : targetFamily}` };
  }
  
  let result = line;
  let changed = false;
  let warning;

  // Strip Debian-specific options before translating the command itself,
  // so the install pattern match sees a clean command line.
  if (sourceFamily === 'debian' && targetFamily !== 'debian') {
    if (result.includes('DEBIAN_FRONTEND=noninteractive')) {
      result = result.replace(/DEBIAN_FRONTEND=noninteractive\s*/, '');
      changed = true;
    }
    if (result.includes('Dpkg::Options')) {
      result = result.replace(/-o\s+Dpkg::Options::="[^"]*"\s*/g, '');
      changed = true;
    }
    // Re-trim after stripping
    trimmed = result.trim();
  }
  
  // Translate package manager commands
  // apt-get install → dnf install, etc.
  if (trimmed.includes(sourcePM.install.split(' ')[0])) {
    // Extract the install command pattern
    const installPatterns = [
      // sudo apt-get install -y pkg1 pkg2
      new RegExp(`(sudo\\s+)?${escapeRegex(sourcePM.install)}\\s+(.+)`, 'i'),
      // apt-get install -y pkg1 pkg2
      new RegExp(`${escapeRegex(sourcePM.install)}\\s+(.+)`, 'i'),
    ];
    
    for (const pattern of installPatterns) {
      const match = trimmed.match(pattern);
      if (match) {
        const sudo = match[1] || '';
        const packages = match[match.length - 1].trim();
        
        // Translate package names
        const translatedPkgs = translatePackageNames(packages, sourceFamily, targetFamily);
        result = `${sudo}${targetPM.install} ${translatedPkgs}`;
        changed = true;
        break;
      }
    }
  }
  
  // Translate update command
  if (trimmed.includes(sourcePM.update.split(' ')[0]) && 
      trimmed.includes('update')) {
    const sudoPrefix = trimmed.startsWith('sudo') ? 'sudo ' : '';
    result = `${sudoPrefix}${targetPM.update}`;
    changed = true;
  }
  
  // Handle line-continuation backslashes (multi-line apt install)
  if (result.endsWith('\\')) {
    // Keep the continuation — it's part of the package list
  }

  return { translated: result, changed, warning };
}

/**
 * Translate package names between families
 * @param {string} packages - Space-separated package names (may include \ continuations)
 * @param {string} sourceFamily - Source OS family
 * @param {string} targetFamily - Target OS family
 * @returns {string} Translated package names
 */
export function translatePackageNames(packages, sourceFamily, targetFamily) {
  if (sourceFamily === targetFamily) return packages;
  
  // Split on whitespace, preserving backslash continuations
  const parts = packages.split(/\s+/).filter(p => p && p !== '\\');
  
  const translated = parts.map(pkg => {
    const mapping = PACKAGE_NAME_MAP[pkg];
    if (mapping && mapping[targetFamily]) {
      return mapping[targetFamily];
    }
    return pkg; // Same name or unknown — pass through
  });
  
  return translated.join(' ');
}

/**
 * Join backslash-continued lines into logical commands.
 * "sudo apt install -y \\\n  caddy \\\n  curl" → one logical line.
 * Returns array of { text, originalLineCount } for re-splitting after translation.
 */
function joinContinuationLines(lines) {
  const logical = [];
  let current = '';
  let lineCount = 0;
  
  for (const line of lines) {
    lineCount++;
    if (line.trimEnd().endsWith('\\')) {
      // Continuation: strip trailing backslash, join with next line
      current += line.trimEnd().slice(0, -1).trimEnd() + ' ';
    } else {
      current += line;
      logical.push({ text: current, originalLineCount: lineCount });
      current = '';
      lineCount = 0;
    }
  }
  
  // Handle trailing continuation without final line
  if (current) {
    logical.push({ text: current, originalLineCount: lineCount });
  }
  
  return logical;
}

/**
 * Translate an entire Lobsterfile from one OS family to another
 * @param {string} content - Original Lobsterfile content
 * @param {string} sourceFamily - Source OS family
 * @param {string} targetFamily - Target OS family
 * @returns {object} { translated: string, changes: number, warnings: string[] }
 */
export function translateLobsterfile(content, sourceFamily, targetFamily) {
  if (sourceFamily === targetFamily) {
    return { translated: content, changes: 0, warnings: [] };
  }
  
  const lines = content.split('\n');
  const translatedLines = [];
  let changes = 0;
  const warnings = [];
  
  // Join continuation lines so multi-line apt install commands are
  // treated as single logical commands for translation.
  const logicalLines = joinContinuationLines(lines);
  
  // First pass: identify known repo setup blocks for recipe replacement
  const skipIndices = new Set();
  
  for (let i = 0; i < logicalLines.length; i++) {
    const line = logicalLines[i].text.trim();
    if (!line || line.startsWith('#')) continue;
    
    for (const [name, recipe] of Object.entries(REPO_RECIPES)) {
      if (recipe.detect(line)) {
        const sourceRecipe = recipe[sourceFamily] || [];
        const targetRecipe = recipe[targetFamily] || [];
        
        if (targetRecipe.length > 0 && sourceRecipe.length > 0) {
          let j = i;
          for (const srcLine of sourceRecipe) {
            while (j < logicalLines.length) {
              if (logicalLines[j].text.trim() && !logicalLines[j].text.trim().startsWith('#') && 
                  linesMatch(logicalLines[j].text.trim(), srcLine.trim())) {
                skipIndices.add(j);
                j++;
                break;
              }
              j++;
            }
          }
          
          if (skipIndices.has(i)) {
            translatedLines.push(`# --- Translated from ${sourceFamily} to ${targetFamily} ---`);
            for (const targetLine of targetRecipe) {
              translatedLines.push(targetLine);
            }
            changes++;
          }
        }
        break;
      }
    }
  }
  
  // Second pass: translate remaining logical lines
  for (let i = 0; i < logicalLines.length; i++) {
    if (skipIndices.has(i)) continue;
    
    const { translated, changed, warning } = translateLine(logicalLines[i].text, sourceFamily, targetFamily);
    translatedLines.push(translated);
    if (changed) changes++;
    if (warning) warnings.push(warning);
  }
  
  return {
    translated: translatedLines.join('\n'),
    changes,
    warnings,
  };
}

/**
 * Fuzzy line matching for repo recipe detection
 */
function linesMatch(a, b) {
  // Normalize whitespace and compare
  const normA = a.replace(/\s+/g, ' ').trim();
  const normB = b.replace(/\s+/g, ' ').trim();
  // Check if one contains the key parts of the other
  return normA === normB || normA.includes(normB) || normB.includes(normA);
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
