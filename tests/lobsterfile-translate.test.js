/**
 * Lobsterfile Translation Tests
 * Tests for cross-distro command translation when restoring to a
 * different Linux family than the backup was made on.
 */
import { describe, it, expect } from 'vitest';
import {
  translateLine,
  translatePackageNames,
  translateLobsterfile,
} from '../src/lobsterfile-translate.js';

describe('Lobsterfile Translation', () => {
  describe('translateLine', () => {
    it('translates apt-get install → dnf install', () => {
      const { translated, changed } = translateLine(
        'sudo apt-get install -y curl git', 'debian', 'rhel'
      );
      expect(translated).toContain('dnf install -y');
      expect(translated).toContain('curl');
      expect(translated).toContain('git');
      expect(changed).toBe(true);
    });

    it('translates apt-get install → pacman -S', () => {
      const { translated, changed } = translateLine(
        'sudo apt-get install -y curl', 'debian', 'arch'
      );
      expect(translated).toContain('pacman -S --noconfirm');
      expect(changed).toBe(true);
    });

    it('translates apt-get install → apk add', () => {
      const { translated, changed } = translateLine(
        'sudo apt-get install -y curl', 'debian', 'alpine'
      );
      expect(translated).toContain('apk add');
      expect(changed).toBe(true);
    });

    it('translates apt-get update → dnf check-update', () => {
      const { translated, changed } = translateLine(
        'sudo apt-get update', 'debian', 'rhel'
      );
      expect(translated).toContain('dnf check-update');
      expect(changed).toBe(true);
    });

    it('strips DEBIAN_FRONTEND for non-debian targets', () => {
      const { translated, changed } = translateLine(
        'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y caddy', 'debian', 'rhel'
      );
      expect(translated).not.toContain('DEBIAN_FRONTEND');
      expect(changed).toBe(true);
    });

    it('strips Dpkg::Options for non-debian targets', () => {
      const { translated, changed } = translateLine(
        'sudo apt-get install -y -o Dpkg::Options::="--force-confold" caddy', 'debian', 'rhel'
      );
      expect(translated).not.toContain('Dpkg::Options');
      expect(changed).toBe(true);
    });

    it('preserves comments unchanged', () => {
      const { translated, changed } = translateLine(
        '# Install caddy web server', 'debian', 'rhel'
      );
      expect(translated).toBe('# Install caddy web server');
      expect(changed).toBe(false);
    });

    it('preserves empty lines unchanged', () => {
      const { translated, changed } = translateLine('', 'debian', 'rhel');
      expect(translated).toBe('');
      expect(changed).toBe(false);
    });

    it('preserves systemctl commands (universal across families)', () => {
      const { translated, changed } = translateLine(
        'sudo systemctl enable caddy', 'debian', 'rhel'
      );
      expect(translated).toContain('systemctl enable caddy');
      expect(changed).toBe(false);
    });

    it('preserves curl/wget commands unchanged', () => {
      const { translated, changed } = translateLine(
        "curl -fsSL https://example.com/setup.sh | sudo bash -", 'debian', 'rhel'
      );
      expect(translated).toContain('curl -fsSL');
      expect(changed).toBe(false);
    });
  });

  describe('translatePackageNames', () => {
    it('translates build-essential → gcc gcc-c++ make for rhel', () => {
      const result = translatePackageNames('build-essential curl', 'debian', 'rhel');
      expect(result).toContain('gcc gcc-c++ make');
      expect(result).toContain('curl');
    });

    it('translates build-essential → base-devel for arch', () => {
      const result = translatePackageNames('build-essential', 'debian', 'arch');
      expect(result).toBe('base-devel');
    });

    it('translates python3-pip → py3-pip for alpine', () => {
      const result = translatePackageNames('python3-pip', 'debian', 'alpine');
      expect(result).toBe('py3-pip');
    });

    it('passes through unknown packages unchanged', () => {
      const result = translatePackageNames('custom-package curl', 'debian', 'rhel');
      expect(result).toContain('custom-package');
      expect(result).toContain('curl');
    });

    it('returns same packages for same family', () => {
      const result = translatePackageNames('curl git vim', 'debian', 'debian');
      expect(result).toBe('curl git vim');
    });
  });

  describe('translateLobsterfile', () => {
    const sampleLobsterfile = `#!/bin/bash
# Lobsterfile for Ubuntu

# Third-party repos
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
sudo apt-get update

# Packages
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::="--force-confold" \\
  caddy \\
  build-essential \\
  curl

# Services
sudo systemctl enable caddy
sudo systemctl start caddy
`;

    it('returns unchanged content for same family', () => {
      const { translated, changes } = translateLobsterfile(sampleLobsterfile, 'debian', 'debian');
      expect(changes).toBe(0);
      expect(translated).toBe(sampleLobsterfile);
    });

    it('translates debian → rhel commands', () => {
      const { translated, changes } = translateLobsterfile(sampleLobsterfile, 'debian', 'rhel');
      expect(changes).toBeGreaterThan(0);
      expect(translated).toContain('dnf install -y');
      expect(translated).not.toContain('apt-get install');
      expect(translated).not.toContain('DEBIAN_FRONTEND');
    });

    it('preserves comments and structure', () => {
      const { translated } = translateLobsterfile(sampleLobsterfile, 'debian', 'rhel');
      expect(translated).toContain('#!/bin/bash');
      expect(translated).toContain('# Services');
      expect(translated).toContain('systemctl enable caddy');
    });

    it('preserves systemctl commands across families', () => {
      const { translated } = translateLobsterfile(sampleLobsterfile, 'debian', 'rhel');
      expect(translated).toContain('sudo systemctl enable caddy');
      expect(translated).toContain('sudo systemctl start caddy');
    });

    it('reports number of changes made', () => {
      const { changes } = translateLobsterfile(sampleLobsterfile, 'debian', 'rhel');
      expect(changes).toBeGreaterThanOrEqual(2); // at least update + install
    });

    it('translates package names (build-essential → gcc gcc-c++ make)', () => {
      const { translated } = translateLobsterfile(sampleLobsterfile, 'debian', 'rhel');
      expect(translated).toContain('gcc gcc-c++ make');
      expect(translated).not.toContain('build-essential');
    });

    it('handles empty Lobsterfile', () => {
      const { translated, changes } = translateLobsterfile('#!/bin/bash\n', 'debian', 'rhel');
      expect(changes).toBe(0);
      expect(translated).toContain('#!/bin/bash');
    });
  });
});
