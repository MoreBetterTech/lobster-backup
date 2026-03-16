/**
 * Apt Sources Tests
 * Tests for capturing and restoring third-party apt repository sources
 * and their associated keyrings during backup/restore.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureAptSources } from '../src/backup.js';
import { restoreAptSources } from '../src/restore.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('node:fs');
vi.mock('node:child_process');

describe('Apt Sources — Capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('discovers third-party .list files in /etc/apt/sources.list.d/', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['caddy-stable.list', 'ubuntu.sources']);
    fs.readFileSync.mockReturnValue(
      'deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main'
    );

    const result = captureAptSources();

    // Should include caddy but skip ubuntu (default OS source)
    expect(result.sourceFiles).toEqual(['/etc/apt/sources.list.d/caddy-stable.list']);
  });

  it('discovers third-party .sources files (DEB822 format)', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['nodesource.sources', 'ubuntu.sources']);
    fs.readFileSync.mockReturnValue(
      'Types: deb\nURIs: https://deb.nodesource.com/node_22.x\nSigned-By: /usr/share/keyrings/nodesource.gpg\n'
    );

    const result = captureAptSources();

    expect(result.sourceFiles).toEqual(['/etc/apt/sources.list.d/nodesource.sources']);
  });

  it('skips default OS source files (ubuntu.sources, debian.list)', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['ubuntu.sources', 'debian.list']);

    const result = captureAptSources();

    expect(result.sourceFiles).toEqual([]);
  });

  it('extracts signed-by keyring paths from .list format', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['caddy-stable.list']);
    fs.readFileSync.mockReturnValue(
      'deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main'
    );

    const result = captureAptSources();

    expect(result.keyringFiles).toContain('/usr/share/keyrings/caddy-stable-archive-keyring.gpg');
  });

  it('extracts Signed-By from DEB822 .sources format', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['nodesource.sources']);
    fs.readFileSync.mockReturnValue(
      'Types: deb\nURIs: https://deb.nodesource.com/node_22.x\nSigned-By: /usr/share/keyrings/nodesource.gpg\n'
    );

    const result = captureAptSources();

    expect(result.keyringFiles).toContain('/usr/share/keyrings/nodesource.gpg');
  });

  it('skips keyrings that do not exist on disk', () => {
    fs.existsSync.mockImplementation((p) => {
      if (p === '/etc/apt/sources.list.d') return true;
      if (p === '/usr/share/keyrings/missing.gpg') return false;
      return true;
    });
    fs.readdirSync.mockReturnValue(['custom.list']);
    fs.readFileSync.mockReturnValue(
      'deb [signed-by=/usr/share/keyrings/missing.gpg] https://example.com stable main'
    );

    const result = captureAptSources();

    expect(result.keyringFiles).toEqual([]);
  });

  it('deduplicates keyrings referenced by multiple source files', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['caddy-stable.list', 'caddy-testing.list']);
    fs.readFileSync.mockReturnValue(
      'deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://example.com stable main'
    );

    const result = captureAptSources();

    // Same keyring referenced twice, should appear only once
    const caddyKeyrings = result.keyringFiles.filter(k =>
      k.includes('caddy-stable-archive-keyring.gpg')
    );
    expect(caddyKeyrings.length).toBe(1);
  });

  it('returns empty arrays when /etc/apt/sources.list.d/ does not exist', () => {
    fs.existsSync.mockReturnValue(false);

    const result = captureAptSources();

    expect(result.sourceFiles).toEqual([]);
    expect(result.keyringFiles).toEqual([]);
  });

  it('skips .save and other non-source files', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['caddy-stable.list', 'caddy-stable.list.save', 'README']);
    fs.readFileSync.mockReturnValue('deb https://example.com stable main');

    const result = captureAptSources();

    expect(result.sourceFiles.length).toBe(1);
    expect(result.sourceFiles[0]).toContain('caddy-stable.list');
  });
});

describe('Apt Sources — Restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue([]);
    execFileSync.mockReturnValue('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores keyrings to /usr/share/keyrings/ via sudo', () => {
    fs.readdirSync.mockImplementation((dir) => {
      if (dir.includes('keyrings')) return ['caddy-stable-archive-keyring.gpg'];
      return [];
    });

    restoreAptSources('/tmp/apt-sources');

    const cpCall = execFileSync.mock.calls.find(
      (c) => c[0] === 'sudo' && c[1].includes('cp') &&
             c[1].some(a => a.includes('/usr/share/keyrings/'))
    );
    expect(cpCall).toBeDefined();
  });

  it('restores source files to /etc/apt/sources.list.d/ via sudo', () => {
    fs.readdirSync.mockImplementation((dir) => {
      if (dir.includes('sources.list.d')) return ['caddy-stable.list'];
      if (dir.includes('keyrings')) return [];
      return [];
    });

    restoreAptSources('/tmp/apt-sources');

    const cpCall = execFileSync.mock.calls.find(
      (c) => c[0] === 'sudo' && c[1].includes('cp') &&
             c[1].some(a => a.includes('/etc/apt/sources.list.d/'))
    );
    expect(cpCall).toBeDefined();
  });

  it('restores keyrings before source files (sources reference keyrings)', () => {
    fs.readdirSync.mockImplementation((dir) => {
      if (dir.includes('keyrings')) return ['caddy.gpg'];
      if (dir.includes('sources.list.d')) return ['caddy.list'];
      return [];
    });

    restoreAptSources('/tmp/apt-sources');

    // Find indices of keyring and source cp calls
    const calls = execFileSync.mock.calls;
    const keyringIdx = calls.findIndex(
      (c) => c[0] === 'sudo' && c[1].some(a => a.includes('/usr/share/keyrings/'))
    );
    const sourceIdx = calls.findIndex(
      (c) => c[0] === 'sudo' && c[1].some(a => a.includes('/etc/apt/sources.list.d/'))
    );

    expect(keyringIdx).toBeLessThan(sourceIdx);
  });

  it('sets keyring permissions to 644', () => {
    fs.readdirSync.mockImplementation((dir) => {
      if (dir.includes('keyrings')) return ['nodesource.gpg'];
      return [];
    });

    restoreAptSources('/tmp/apt-sources');

    const chmodCall = execFileSync.mock.calls.find(
      (c) => c[0] === 'sudo' && c[1].includes('chmod') && c[1].includes('644')
    );
    expect(chmodCall).toBeDefined();
  });

  it('handles missing keyrings directory gracefully', () => {
    fs.existsSync.mockImplementation((p) => {
      if (p.includes('keyrings')) return false;
      return true;
    });
    fs.readdirSync.mockReturnValue(['caddy.list']);

    expect(() => restoreAptSources('/tmp/apt-sources')).not.toThrow();
  });
});
