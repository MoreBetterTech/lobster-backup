/**
 * Lobsterfile Variables (lobsterfile.env) Tests
 * Tests for env file parsing, variable substitution, and file management.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseEnvFile,
  substituteVariables,
  writeEnvFile,
  detectNewVariables,
} from '../src/lobsterfile-env.js';
import fs from 'node:fs';

vi.mock('node:fs');

describe('Lobsterfile Variables', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Parsing ---
  describe('Parsing', () => {
    it('reads lobsterfile.env key=value pairs correctly', () => {
      const content = 'SERVER_IP=203.0.113.42\nDOMAIN_NAME=example.com\nGATEWAY_PORT=18789\n';
      const result = parseEnvFile(content);
      expect(result).toEqual({
        SERVER_IP: '203.0.113.42',
        DOMAIN_NAME: 'example.com',
        GATEWAY_PORT: '18789',
      });
    });

    it('ignores comments (lines starting with #)', () => {
      const content = '# This is a comment\nSERVER_IP=10.0.0.1\n# Another comment\n';
      const result = parseEnvFile(content);
      expect(result).toEqual({ SERVER_IP: '10.0.0.1' });
    });

    it('handles empty values', () => {
      const content = 'EMPTY_VAR=\n';
      const result = parseEnvFile(content);
      expect(result).toEqual({ EMPTY_VAR: '' });
    });

    it('handles values with spaces', () => {
      const content = 'DESCRIPTION=my cool server\n';
      const result = parseEnvFile(content);
      expect(result.DESCRIPTION).toBe('my cool server');
    });

    it('handles values with special characters (=, #, quotes)', () => {
      const content = 'CONNECTION_STRING=host=db;port=5432#comment_in_value\nQUOTED="hello world"\n';
      const result = parseEnvFile(content);
      expect(result.CONNECTION_STRING).toBe('host=db;port=5432#comment_in_value');
      expect(result.QUOTED).toBe('"hello world"');
    });

    it('rejects variable names with invalid characters', () => {
      const content = 'INVALID-NAME=value\n';
      expect(() => parseEnvFile(content)).toThrow(/invalid.*name|character/i);
    });
  });

  // --- Substitution ---
  describe('Substitution', () => {
    it('substitutes all {{VARIABLE}} occurrences in a string', () => {
      const template = 'Server at {{SERVER_IP}} on port {{GATEWAY_PORT}}';
      const vars = { SERVER_IP: '10.0.0.1', GATEWAY_PORT: '18789' };
      const result = substituteVariables(template, vars);
      expect(result).toBe('Server at 10.0.0.1 on port 18789');
    });

    it('handles multiple different variables in one string', () => {
      const template = '{{A}} and {{B}} and {{C}}';
      const vars = { A: '1', B: '2', C: '3' };
      const result = substituteVariables(template, vars);
      expect(result).toBe('1 and 2 and 3');
    });

    it('handles same variable appearing multiple times', () => {
      const template = '{{HOST}}:8080 and {{HOST}}:8443';
      const vars = { HOST: 'example.com' };
      const result = substituteVariables(template, vars);
      expect(result).toBe('example.com:8080 and example.com:8443');
    });

    it('missing variable → throws/prompts (not silent fail)', () => {
      const template = 'Server at {{SERVER_IP}} on port {{UNKNOWN_PORT}}';
      const vars = { SERVER_IP: '10.0.0.1' };
      expect(() => substituteVariables(template, vars)).toThrow(/missing|undefined|UNKNOWN_PORT/i);
    });

    it('preserves non-placeholder {{ content if not matching pattern', () => {
      const template = 'Use {{ curly braces }} for templates and {{REAL_VAR}} for vars';
      const vars = { REAL_VAR: 'hello' };
      const result = substituteVariables(template, vars);
      expect(result).toContain('{{ curly braces }}');
      expect(result).toContain('hello');
    });
  });

  // --- File Management ---
  describe('File Management', () => {
    it('writes new variables to lobsterfile.env', () => {
      fs.existsSync.mockReturnValue(false);
      fs.writeFileSync.mockReturnValue(undefined);

      writeEnvFile('/path/to/lobsterfile.env', { SERVER_IP: '10.0.0.1', PORT: '8080' });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/path/to/lobsterfile.env',
        expect.stringContaining('SERVER_IP=10.0.0.1'),
        expect.anything()
      );
    });

    it('preserves existing comments when writing', () => {
      const existing = '# lobsterfile.env — captured at backup time\nSERVER_IP=10.0.0.1\n';
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(existing);
      fs.writeFileSync.mockReturnValue(undefined);

      writeEnvFile('/path/to/lobsterfile.env', { SERVER_IP: '10.0.0.1', NEW_VAR: 'hello' });

      const writeCall = fs.writeFileSync.mock.calls[0];
      expect(writeCall[1]).toContain('# lobsterfile.env');
      expect(writeCall[1]).toContain('NEW_VAR=hello');
    });

    it('detects new placeholders not yet in env file (for refresh prompting)', () => {
      const lobsterfileContent = '{{SERVER_IP}} {{DOMAIN_NAME}} {{NEW_PORT}}';
      const existingEnv = { SERVER_IP: '10.0.0.1', DOMAIN_NAME: 'example.com' };

      const newVars = detectNewVariables(lobsterfileContent, existingEnv);
      expect(newVars).toEqual(['NEW_PORT']);
    });

    it('does not re-prompt for variables that already have values', () => {
      const lobsterfileContent = '{{SERVER_IP}} {{DOMAIN_NAME}}';
      const existingEnv = { SERVER_IP: '10.0.0.1', DOMAIN_NAME: 'example.com' };

      const newVars = detectNewVariables(lobsterfileContent, existingEnv);
      expect(newVars).toEqual([]);
    });
  });
});
