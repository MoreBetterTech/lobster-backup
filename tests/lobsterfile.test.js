/**
 * Lobsterfile Parser Tests
 * Tests for reading, appending, validating, and variable detection in the Lobsterfile.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  readLobsterfile,
  appendToLobsterfile,
  validateLobsterfile,
  detectPlaceholders,
} from '../src/lobsterfile.js';
import fs from 'node:fs';
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
