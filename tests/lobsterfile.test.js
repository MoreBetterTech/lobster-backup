/**
 * Lobsterfile Parser Tests
 * Tests for reading, appending, validating, variable detection,
 * and lifecycle (init/creation) of the Lobsterfile.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  readLobsterfile,
  appendToLobsterfile,
  validateLobsterfile,
  detectPlaceholders,
  initLobsterfile,
} from '../src/lobsterfile.js';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

vi.mock('node:fs');
vi.mock('node:child_process');

describe('Lobsterfile Parser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads existing Lobsterfile (plain bash script)', () => {
    const content = '#!/bin/bash\napt-get install -y curl\n';
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(content);

    const result = readLobsterfile('/path/to/lobsterfile');
    expect(result).toBe(content);
  });

  it('appends a new step to the Lobsterfile', () => {
    const existing = '#!/bin/bash\napt-get install -y curl\n';
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(existing);
    fs.appendFileSync.mockReturnValue(undefined);

    const newStep = '\n# Install caddy\napt-get install -y caddy\n';
    appendToLobsterfile('/path/to/lobsterfile', newStep);

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/path/to/lobsterfile',
      expect.stringContaining('caddy')
    );
  });

  it('validates Lobsterfile is syntactically valid bash (bash -n check)', () => {
    execSync.mockReturnValue(''); // bash -n returns empty on success

    const result = validateLobsterfile('#!/bin/bash\necho hello\n');
    expect(result.valid).toBe(true);
  });

  it('detects {{VARIABLE}} placeholders in content', () => {
    const content = 'reverse_proxy localhost:{{GATEWAY_PORT}}\n{{DOMAIN_NAME}} {\n}';
    const vars = detectPlaceholders(content);
    expect(vars).toContain('GATEWAY_PORT');
    expect(vars).toContain('DOMAIN_NAME');
  });

  it('detects {{VAR_WITH_UNDERSCORES}} (underscores in names)', () => {
    const content = 'export DB_HOST={{DB_HOST_NAME}}\nexport API_KEY={{API_SECRET_KEY}}';
    const vars = detectPlaceholders(content);
    expect(vars).toContain('DB_HOST_NAME');
    expect(vars).toContain('API_SECRET_KEY');
  });

  it('reports malformed {{}} (empty placeholder) as error', () => {
    const content = 'some config with {{}} empty placeholder';
    expect(() => detectPlaceholders(content)).toThrow(/empty|malformed|invalid/i);
  });

  // --- Lobsterfile Lifecycle (initLobsterfile) ---
  describe('Lifecycle', () => {
    it('initLobsterfile creates file with shebang and header', () => {
      fs.existsSync.mockReturnValue(false);
      fs.writeFileSync.mockReturnValue(undefined);
      fs.mkdirSync.mockReturnValue(undefined);

      const result = initLobsterfile('/home/test/.openclaw/lobsterfile');
      
      expect(result.created).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/home/test/.openclaw/lobsterfile',
        expect.stringContaining('#!/bin/bash'),
        expect.any(Object)
      );
    });

    it('initLobsterfile does not overwrite existing Lobsterfile', () => {
      fs.existsSync.mockReturnValue(true); // file already exists

      const result = initLobsterfile('/home/test/.openclaw/lobsterfile');
      
      expect(result.created).toBe(false);
      expect(result.reason).toMatch(/already exists/i);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('initLobsterfile seeds from lobsterfile.seed if available', () => {
      fs.existsSync.mockImplementation((p) => {
        if (p.includes('lobsterfile.seed')) return true;
        if (p.endsWith('lobsterfile') && !p.includes('.seed')) return false;
        return true; // parent dir
      });
      fs.readFileSync.mockReturnValue(
        '#!/bin/bash\n# lobsterfile.seed — inferred\n\n# APT packages\napt-get install -y curl\napt-get install -y caddy\n'
      );
      fs.writeFileSync.mockReturnValue(undefined);
      fs.mkdirSync.mockReturnValue(undefined);

      const result = initLobsterfile('/home/test/.openclaw/lobsterfile', {
        seedPath: '/home/test/.openclaw/lobsterfile.seed',
      });
      
      expect(result.created).toBe(true);
      expect(result.seeded).toBe(true);
      const written = fs.writeFileSync.mock.calls[0][1];
      expect(written).toContain('#!/bin/bash');
      expect(written).toContain('apt-get install -y curl');
    });

    it('initLobsterfile creates valid bash', () => {
      fs.existsSync.mockReturnValue(false);
      fs.writeFileSync.mockReturnValue(undefined);
      fs.mkdirSync.mockReturnValue(undefined);

      initLobsterfile('/home/test/.openclaw/lobsterfile');
      
      const written = fs.writeFileSync.mock.calls[0][1];
      // Starts with shebang
      expect(written.startsWith('#!/bin/bash\n')).toBe(true);
    });
  });

  it('extracts complete list of all referenced variables', () => {
    const content = [
      '{{SERVER_IP}}',
      '{{DOMAIN_NAME}}',
      '{{GATEWAY_PORT}}',
      '{{STREAMLIT_PORT}}',
      '{{DB_HOST}}',
      '{{DOMAIN_NAME}}', // duplicate
    ].join('\n');

    const vars = detectPlaceholders(content);
    expect(vars).toEqual(['SERVER_IP', 'DOMAIN_NAME', 'GATEWAY_PORT', 'STREAMLIT_PORT', 'DB_HOST']);
    // Should deduplicate
    expect(vars.filter((v) => v === 'DOMAIN_NAME').length).toBe(1);
  });
});
