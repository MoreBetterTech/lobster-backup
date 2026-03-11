/**
 * Lobster Scan Tests
 * Tests for the heuristic-based system file scanner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  readScanInputs,
  scanForFindings,
  presentFindings,
  registerFindings,
} from '../src/scan.js';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';

vi.mock('node:fs');
vi.mock('node:child_process');

describe('Lobster Scan', () => {
  let mockHome;

  beforeEach(() => {
    mockHome = '/home/testuser';
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Inputs ---
  describe('Inputs', () => {
    it('reads gateway port from ~/.openclaw/openclaw.json', () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({ port: 18789, workspace: '/home/testuser/.openclaw/workspace' }));
      fs.existsSync.mockReturnValue(true);

      const inputs = readScanInputs();
      expect(inputs.gatewayPort).toBe(18789);
    });

    it('reads workspace path from openclaw.json', () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({ port: 18789, workspace: '/home/testuser/.openclaw/workspace' }));
      fs.existsSync.mockReturnValue(true);

      const inputs = readScanInputs();
      expect(inputs.workspacePath).toBe('/home/testuser/.openclaw/workspace');
    });

    it('uses port and workspace path as primary grep targets', () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({ port: 18789, workspace: '/home/testuser/.openclaw/workspace' }));
      fs.existsSync.mockReturnValue(true);

      const inputs = readScanInputs();
      expect(inputs.grepTargets).toContain('18789');
      expect(inputs.grepTargets).toContain('/home/testuser/.openclaw/workspace');
    });

    it('includes common OC-adjacent ports', () => {
      fs.readFileSync.mockReturnValue(JSON.stringify({ port: 18789 }));
      fs.existsSync.mockReturnValue(true);

      const inputs = readScanInputs();
      // Should include known OC-adjacent ports
      expect(inputs.grepTargets).toEqual(
        expect.arrayContaining([expect.stringMatching(/8501|18889/)])
      );
    });
  });

  // --- Heuristics ---
  describe('Heuristics', () => {
    const mockInputs = {
      gatewayPort: 18789,
      workspacePath: '/home/testuser/.openclaw/workspace',
      grepTargets: ['18789', '8501', '/home/testuser/.openclaw/workspace'],
      existingManifest: [],
    };

    it('finds /etc/ config files containing the gateway port string', () => {
      fs.readdirSync.mockReturnValue(['Caddyfile']);
      fs.readFileSync.mockReturnValue('reverse_proxy localhost:18789');
      fs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => false });

      const findings = scanForFindings(mockInputs, ['/etc/caddy']);
      expect(findings.some((f) => f.path.includes('Caddyfile'))).toBe(true);
    });

    it('finds systemd unit files that exec node/openclaw processes', () => {
      fs.readdirSync.mockReturnValue(['openclaw-gateway.service']);
      fs.readFileSync.mockReturnValue('ExecStart=/usr/bin/node /home/testuser/.openclaw/gateway.js');
      fs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => false });

      const findings = scanForFindings(mockInputs, ['/etc/systemd/system']);
      expect(findings.some((f) => f.path.includes('openclaw-gateway.service'))).toBe(true);
    });

    it('finds Caddy/nginx vhosts proxying to known localhost ports', () => {
      fs.readdirSync.mockReturnValue(['site.conf']);
      fs.readFileSync.mockReturnValue('proxy_pass http://localhost:8501;');
      fs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => false });

      const findings = scanForFindings(mockInputs, ['/etc/nginx/sites-enabled']);
      expect(findings.some((f) => f.reason.match(/proxy|8501/i))).toBe(true);
    });

    it('finds ~/.config/ files belonging to tools referenced in TOOLS.md', () => {
      fs.readdirSync.mockReturnValue(['elevenlabs']);
      fs.readFileSync.mockImplementation((p) => {
        if (p.includes('TOOLS.md')) return 'Preferred voice: ElevenLabs';
        return 'api_key=abc123';
      });
      fs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => true });
      fs.existsSync.mockReturnValue(true);

      const findings = scanForFindings(
        { ...mockInputs, toolsContent: 'Preferred voice: ElevenLabs' },
        [`${mockHome}/.config`]
      );
      expect(findings.some((f) => f.path.includes('elevenlabs'))).toBe(true);
    });

    it('skips files already in the external manifest', () => {
      const inputs = {
        ...mockInputs,
        existingManifest: ['/etc/caddy/Caddyfile'],
      };

      fs.readdirSync.mockReturnValue(['Caddyfile']);
      fs.readFileSync.mockReturnValue('reverse_proxy localhost:18789');
      fs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => false });

      const findings = scanForFindings(inputs, ['/etc/caddy']);
      expect(findings.some((f) => f.path === '/etc/caddy/Caddyfile')).toBe(false);
    });
  });

  // --- Interactive Flow ---
  describe('Interactive Flow', () => {
    it('presents each finding with: path, reason, matched snippet', () => {
      const findings = [
        { path: '/etc/caddy/Caddyfile', reason: 'Contains port 18789', snippet: 'reverse_proxy localhost:18789' },
      ];

      const presented = presentFindings(findings);
      expect(presented[0]).toHaveProperty('path');
      expect(presented[0]).toHaveProperty('reason');
      expect(presented[0]).toHaveProperty('snippet');
    });

    it('--register writes confirmed findings to external manifest', () => {
      fs.writeFileSync.mockReturnValue(undefined);
      fs.readFileSync.mockReturnValue('[]');
      fs.existsSync.mockReturnValue(true);

      const confirmedPaths = ['/etc/caddy/Caddyfile', '/etc/systemd/system/openclaw.service'];
      registerFindings(confirmedPaths);

      const writeCall = fs.writeFileSync.mock.calls.find(
        (c) => c[0].includes('lobster-external-manifest.json')
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall[1]);
      expect(written).toContain('/etc/caddy/Caddyfile');
    });

    it('dry run (no --register) prints findings without modifying manifest', () => {
      const findings = [
        { path: '/etc/caddy/Caddyfile', reason: 'port match', snippet: '18789' },
      ];

      // presentFindings should not write anything
      const presented = presentFindings(findings);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(presented).toHaveLength(1);
    });
  });

  // --- Error Handling ---
  describe('Error Handling', () => {
    it('permission denied on a file → skips with warning, continues scanning', () => {
      fs.readdirSync.mockReturnValue(['secret.conf', 'Caddyfile']);
      fs.readFileSync.mockImplementation((p) => {
        if (p.includes('secret.conf')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return 'reverse_proxy localhost:18789';
      });
      fs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => false });

      const mockInputs = {
        gatewayPort: 18789,
        grepTargets: ['18789'],
        existingManifest: [],
      };

      // Should not throw, should still find the non-restricted file
      const findings = scanForFindings(mockInputs, ['/etc/caddy']);
      expect(findings.some((f) => f.path.includes('Caddyfile'))).toBe(true);
    });

    it('missing scan directory → skips gracefully', () => {
      fs.readdirSync.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const mockInputs = {
        gatewayPort: 18789,
        grepTargets: ['18789'],
        existingManifest: [],
      };

      const findings = scanForFindings(mockInputs, ['/var/www/nonexistent']);
      expect(findings).toEqual([]);
    });

    it('no openclaw.json found → warns, falls back to default port patterns', () => {
      fs.existsSync.mockReturnValue(false);

      const inputs = readScanInputs();
      // Should have fallback patterns even without openclaw.json
      expect(inputs.grepTargets).toBeDefined();
      expect(inputs.grepTargets.length).toBeGreaterThan(0);
      expect(inputs.warning).toMatch(/openclaw\.json|not found|default/i);
    });
  });
});
