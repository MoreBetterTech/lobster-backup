/**
 * os-detect.js — OS detection and family classification
 * 
 * Detects the current OS from /etc/os-release and classifies it into
 * families (debian, rhel, arch, alpine, suse). Used by backup to stamp
 * the archive with source OS info, and by restore to detect cross-family
 * migrations and translate Lobsterfile commands.
 */

import fs from 'node:fs';
import os from 'node:os';

/**
 * OS family classification rules.
 * ID_LIKE in /etc/os-release tells us the lineage.
 * Some distros (debian, fedora, arch) don't set ID_LIKE — they ARE the base.
 */
const FAMILY_MAP = {
  // Debian family
  debian: 'debian',
  ubuntu: 'debian',
  raspbian: 'debian',
  linuxmint: 'debian',
  pop: 'debian',         // Pop!_OS
  elementary: 'debian',
  kali: 'debian',
  
  // RHEL family
  rhel: 'rhel',
  centos: 'rhel',
  fedora: 'rhel',
  rocky: 'rhel',
  almalinux: 'rhel',
  ol: 'rhel',            // Oracle Linux
  amzn: 'rhel',          // Amazon Linux
  
  // Arch family
  arch: 'arch',
  manjaro: 'arch',
  endeavouros: 'arch',
  
  // Alpine
  alpine: 'alpine',
  
  // SUSE family
  opensuse: 'suse',
  sles: 'suse',
};

/**
 * Package manager info per family
 */
export const FAMILY_PACKAGE_MANAGERS = {
  debian: { install: 'apt-get install -y', update: 'apt-get update', remove: 'apt-get remove -y' },
  rhel:   { install: 'dnf install -y',     update: 'dnf check-update || true', remove: 'dnf remove -y' },
  arch:   { install: 'pacman -S --noconfirm', update: 'pacman -Sy', remove: 'pacman -R --noconfirm' },
  alpine: { install: 'apk add',            update: 'apk update',    remove: 'apk del' },
  suse:   { install: 'zypper install -y',  update: 'zypper refresh', remove: 'zypper remove -y' },
};

/**
 * Parse /etc/os-release into a key-value object
 * @param {string} content - File content
 * @returns {object} Parsed key-value pairs
 */
export function parseOsRelease(content) {
  const result = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    let value = trimmed.slice(eqIdx + 1);
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Classify an OS ID into a family
 * @param {string} id - OS ID (e.g. "ubuntu", "rocky")
 * @param {string} [idLike] - ID_LIKE field (e.g. "debian", "rhel fedora")
 * @returns {string} Family name or "unknown"
 */
export function classifyFamily(id, idLike) {
  // Direct match on ID
  const idLower = (id || '').toLowerCase();
  if (FAMILY_MAP[idLower]) {
    return FAMILY_MAP[idLower];
  }
  
  // Check ID_LIKE (can be space-separated list like "rhel centos fedora")
  if (idLike) {
    for (const like of idLike.toLowerCase().split(/\s+/)) {
      if (FAMILY_MAP[like]) {
        return FAMILY_MAP[like];
      }
    }
  }
  
  return 'unknown';
}

/**
 * Detect the current OS information
 * @param {string} [osReleasePath] - Override path to os-release (for testing)
 * @returns {object} { id, name, version, family, arch, pretty }
 */
export function detectOS(osReleasePath) {
  const filePath = osReleasePath || '/etc/os-release';
  
  const result = {
    id: 'unknown',
    name: 'Unknown',
    version: 'unknown',
    family: 'unknown',
    arch: os.arch(),
    pretty: 'Unknown OS',
  };
  
  if (!fs.existsSync(filePath)) {
    // Might be macOS or something without /etc/os-release
    const platform = os.platform();
    if (platform === 'darwin') {
      result.id = 'macos';
      result.name = 'macOS';
      result.family = 'macos';
      result.pretty = 'macOS';
    }
    return result;
  }
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseOsRelease(content);
    
    result.id = parsed.ID || 'unknown';
    result.name = parsed.NAME || 'Unknown';
    result.version = parsed.VERSION_ID || 'unknown';
    result.family = classifyFamily(parsed.ID, parsed.ID_LIKE);
    result.pretty = parsed.PRETTY_NAME || `${result.name} ${result.version}`;
  } catch {
    // Can't read os-release, return defaults
  }
  
  return result;
}

/**
 * Compare source and target OS for compatibility
 * @param {object} sourceOS - OS info from backup metadata
 * @param {object} targetOS - OS info from current system
 * @returns {object} { compatible, sameFamily, sameDist, warnings[] }
 */
export function compareOS(sourceOS, targetOS) {
  const result = {
    compatible: true,
    sameFamily: sourceOS.family === targetOS.family,
    sameDist: sourceOS.id === targetOS.id,
    sameVersion: sourceOS.version === targetOS.version,
    translationNeeded: false,
    warnings: [],
  };
  
  if (!result.sameFamily) {
    // Cross-family: Lobsterfile commands likely need translation
    result.translationNeeded = true;
    result.warnings.push(
      `Lobsterfile was written for ${sourceOS.pretty} (${sourceOS.family} family). ` +
      `Target system is ${targetOS.pretty} (${targetOS.family} family). ` +
      `Package manager commands will be translated.`
    );
  } else if (!result.sameDist) {
    // Same family, different distro (e.g. Ubuntu → Debian)
    result.warnings.push(
      `Lobsterfile was written for ${sourceOS.pretty}. ` +
      `Target system is ${targetOS.pretty}. ` +
      `Same package family — commands should be compatible, but review for distro-specific differences.`
    );
  } else if (!result.sameVersion) {
    // Same distro, different version
    result.warnings.push(
      `Lobsterfile was written for ${sourceOS.pretty}. ` +
      `Target system is ${targetOS.pretty}. ` +
      `Minor differences possible between versions.`
    );
  }
  
  // macOS is a special incompatibility
  if (sourceOS.family === 'macos' || targetOS.family === 'macos') {
    if (sourceOS.family !== targetOS.family) {
      result.compatible = false;
      result.warnings.push(
        'Cross-platform restore between Linux and macOS is not supported. ' +
        'Lobsterfile commands are not translatable.'
      );
    }
  }
  
  return result;
}
