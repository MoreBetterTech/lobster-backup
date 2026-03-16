/**
 * OS Detection Tests
 * Tests for OS identification, family classification, and cross-OS comparison.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseOsRelease,
  classifyFamily,
  detectOS,
  compareOS,
} from '../src/os-detect.js';
import fs from 'node:fs';
import os from 'node:os';

vi.mock('node:fs');

describe('OS Detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(os, 'arch').mockReturnValue('x86_64');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseOsRelease', () => {
    it('parses standard /etc/os-release format', () => {
      const content = `PRETTY_NAME="Ubuntu 24.04 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
ID=ubuntu
ID_LIKE=debian`;
      const result = parseOsRelease(content);
      expect(result.PRETTY_NAME).toBe('Ubuntu 24.04 LTS');
      expect(result.ID).toBe('ubuntu');
      expect(result.ID_LIKE).toBe('debian');
      expect(result.VERSION_ID).toBe('24.04');
    });

    it('handles single-quoted values', () => {
      const content = "NAME='Rocky Linux'";
      const result = parseOsRelease(content);
      expect(result.NAME).toBe('Rocky Linux');
    });

    it('handles unquoted values', () => {
      const content = 'ID=debian';
      const result = parseOsRelease(content);
      expect(result.ID).toBe('debian');
    });

    it('skips comments and empty lines', () => {
      const content = '# comment\n\nID=ubuntu\n';
      const result = parseOsRelease(content);
      expect(result.ID).toBe('ubuntu');
      expect(Object.keys(result).length).toBe(1);
    });
  });

  describe('classifyFamily', () => {
    it('classifies Ubuntu as debian family', () => {
      expect(classifyFamily('ubuntu', 'debian')).toBe('debian');
    });

    it('classifies Debian as debian family (no ID_LIKE)', () => {
      expect(classifyFamily('debian')).toBe('debian');
    });

    it('classifies Rocky Linux as rhel family', () => {
      expect(classifyFamily('rocky', 'rhel centos fedora')).toBe('rhel');
    });

    it('classifies Fedora as rhel family', () => {
      expect(classifyFamily('fedora')).toBe('rhel');
    });

    it('classifies Amazon Linux as rhel family', () => {
      expect(classifyFamily('amzn')).toBe('rhel');
    });

    it('classifies Arch as arch family', () => {
      expect(classifyFamily('arch')).toBe('arch');
    });

    it('classifies Manjaro as arch family', () => {
      expect(classifyFamily('manjaro', 'arch')).toBe('arch');
    });

    it('classifies Alpine as alpine family', () => {
      expect(classifyFamily('alpine')).toBe('alpine');
    });

    it('classifies openSUSE as suse family', () => {
      expect(classifyFamily('opensuse')).toBe('suse');
    });

    it('returns unknown for unrecognized distros', () => {
      expect(classifyFamily('customos')).toBe('unknown');
    });

    it('uses ID_LIKE as fallback when ID is unknown', () => {
      expect(classifyFamily('pop', 'ubuntu debian')).toBe('debian');
    });
  });

  describe('detectOS', () => {
    it('detects Ubuntu from os-release', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(
        'ID=ubuntu\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04 LTS"'
      );

      const result = detectOS('/etc/os-release');
      expect(result.id).toBe('ubuntu');
      expect(result.family).toBe('debian');
      expect(result.version).toBe('24.04');
    });

    it('detects Rocky Linux from os-release', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(
        'ID="rocky"\nNAME="Rocky Linux"\nVERSION_ID="9.3"\nID_LIKE="rhel centos fedora"\nPRETTY_NAME="Rocky Linux 9.3"'
      );

      const result = detectOS('/etc/os-release');
      expect(result.id).toBe('rocky');
      expect(result.family).toBe('rhel');
    });

    it('returns unknown when os-release is missing', () => {
      fs.existsSync.mockReturnValue(false);

      const result = detectOS('/etc/os-release');
      expect(result.family).toBe('unknown');
    });

    it('includes architecture', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('ID=ubuntu\nVERSION_ID="24.04"');

      const result = detectOS('/etc/os-release');
      expect(result.arch).toBe('x86_64');
    });
  });

  describe('compareOS', () => {
    const ubuntu = { id: 'ubuntu', version: '24.04', family: 'debian', pretty: 'Ubuntu 24.04 LTS' };
    const debian = { id: 'debian', version: '12', family: 'debian', pretty: 'Debian 12 (bookworm)' };
    const rocky = { id: 'rocky', version: '9.3', family: 'rhel', pretty: 'Rocky Linux 9.3' };
    const ubuntuNewer = { id: 'ubuntu', version: '26.04', family: 'debian', pretty: 'Ubuntu 26.04 LTS' };
    const macos = { id: 'macos', version: '14', family: 'macos', pretty: 'macOS' };

    it('same distro + version → no warnings', () => {
      const result = compareOS(ubuntu, ubuntu);
      expect(result.sameFamily).toBe(true);
      expect(result.sameDist).toBe(true);
      expect(result.warnings.length).toBe(0);
    });

    it('same family, different distro → warning but compatible', () => {
      const result = compareOS(ubuntu, debian);
      expect(result.sameFamily).toBe(true);
      expect(result.sameDist).toBe(false);
      expect(result.translationNeeded).toBe(false);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toMatch(/Ubuntu.*Debian/);
    });

    it('different family → translation needed', () => {
      const result = compareOS(ubuntu, rocky);
      expect(result.sameFamily).toBe(false);
      expect(result.translationNeeded).toBe(true);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toMatch(/translated/i);
    });

    it('same distro, different version → minor warning', () => {
      const result = compareOS(ubuntu, ubuntuNewer);
      expect(result.sameFamily).toBe(true);
      expect(result.sameDist).toBe(true);
      expect(result.sameVersion).toBe(false);
      expect(result.warnings.length).toBe(1);
    });

    it('Linux ↔ macOS → incompatible', () => {
      const result = compareOS(ubuntu, macos);
      expect(result.compatible).toBe(false);
      expect(result.warnings.some(w => /not supported/i.test(w))).toBe(true);
    });
  });
});
