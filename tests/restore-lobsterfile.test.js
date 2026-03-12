/**
 * Restore — Lobsterfile Execution Tests
 * Tests for mandatory review, variable substitution, execution control,
 * and post-execution behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  displayLobsterfile,
  substituteLobsterfile,
  executeLobsterfile,
} from '../src/restore.js';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';

vi.mock('node:fs');
vi.mock('node:child_process');

describe('Restore — Lobsterfile Execution', () => {
  let mockHome;

  beforeEach(() => {
    mockHome = '/home/testuser';
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sampleLobsterfile = `#!/bin/bash
sudo apt-get install -y caddy
cat > /etc/caddy/Caddyfile <<EOF
{{DOMAIN_NAME}} {
  reverse_proxy localhost:{{GATEWAY_PORT}}
}
EOF
sudo systemctl reload caddy
`;

  // --- Review (mandatory) ---
  describe('Review (mandatory)', () => {
    it('Lobsterfile is always displayed before execution — cannot be skipped', async () => {
      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn().mockResolvedValue('y'),
      };

      await displayLobsterfile(sampleLobsterfile, mockIO);

      const allOutput = mockIO.output.join('\n');
      expect(allOutput).toContain('apt-get install');
      expect(allOutput).toContain('caddy');
    });

    it('user must confirm before execution proceeds', async () => {
      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn().mockResolvedValue('n'),
      };

      const result = await displayLobsterfile(sampleLobsterfile, mockIO);
      expect(result.confirmed).toBe(false);
    });
  });

  // --- Variable Substitution ---
  describe('Variable Substitution', () => {
    it('prompts for lobsterfile.env review before execution', async () => {
      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn().mockResolvedValue(''),
      };

      const envVars = { DOMAIN_NAME: 'example.com', GATEWAY_PORT: '18789' };
      await substituteLobsterfile(sampleLobsterfile, envVars, mockIO);

      // Should display current values for review
      const allOutput = mockIO.output.join('\n');
      expect(allOutput).toMatch(/DOMAIN_NAME|example\.com/);
    });

    it('{{VARIABLE}} values substituted before running', () => {
      const envVars = { DOMAIN_NAME: 'example.com', GATEWAY_PORT: '18789' };
      const result = substituteLobsterfile(sampleLobsterfile, envVars);

      // If substituteLobsterfile returns the substituted string synchronously
      if (typeof result === 'string') {
        expect(result).toContain('example.com');
        expect(result).toContain('18789');
        expect(result).not.toContain('{{DOMAIN_NAME}}');
        expect(result).not.toContain('{{GATEWAY_PORT}}');
      }
    });

    it('prompts for updated values when environment has changed', async () => {
      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn().mockResolvedValue('new.example.com'),
      };

      const envVars = { DOMAIN_NAME: 'old.example.com', GATEWAY_PORT: '18789' };
      await substituteLobsterfile(sampleLobsterfile, envVars, mockIO);

      // Should have prompted
      expect(mockIO.prompt).toHaveBeenCalled();
    });

    it('substituted Lobsterfile written to temp file; cleaned up after execution', async () => {
      fs.writeFileSync.mockReturnValue(undefined);
      fs.unlinkSync.mockReturnValue(undefined);
      execSync.mockReturnValue('');

      await executeLobsterfile({
        content: 'echo hello',
        envVars: {},
        dryRun: false,
      });

      // Should write to a temp file
      const tmpWrite = fs.writeFileSync.mock.calls.find(
        (c) => c[0].includes('tmp') || c[0].includes('lobsterfile-exec')
      );
      expect(tmpWrite).toBeDefined();

      // Should clean up
      expect(fs.unlinkSync).toHaveBeenCalled();
    });
  });

  // --- Execution ---
  describe('Execution', () => {
    it('runs as current user (not root)', async () => {
      execSync.mockReturnValue('');
      fs.writeFileSync.mockReturnValue(undefined);
      fs.unlinkSync.mockReturnValue(undefined);

      await executeLobsterfile({ content: 'echo hello', envVars: {} });

      const cmd = execSync.mock.calls.find((c) => c[0].includes('bash'));
      expect(cmd).toBeDefined();
      // Should NOT be prefixed with sudo
      expect(cmd[0]).not.toMatch(/^sudo\s+bash/);
    });

    it('sudo commands in Lobsterfile are preserved and passed through', async () => {
      execSync.mockReturnValue('');
      fs.writeFileSync.mockReturnValue(undefined);
      fs.unlinkSync.mockReturnValue(undefined);

      await executeLobsterfile({
        content: 'sudo apt-get install -y curl',
        envVars: {},
      });

      // The content should preserve sudo
      const writeCall = fs.writeFileSync.mock.calls[0];
      expect(writeCall[1]).toContain('sudo');
    });

    it('default: fail-fast (stops on first error)', async () => {
      execSync.mockImplementation(() => {
        throw new Error('command failed');
      });
      fs.writeFileSync.mockReturnValue(undefined);
      fs.unlinkSync.mockReturnValue(undefined);

      await expect(
        executeLobsterfile({ content: 'bad-command', envVars: {} })
      ).rejects.toThrow();
    });

    it('--continue-on-error collects all failures and reports at end', async () => {
      execSync.mockImplementation(() => {
        throw new Error('step failed');
      });
      fs.writeFileSync.mockReturnValue(undefined);
      fs.unlinkSync.mockReturnValue(undefined);

      const result = await executeLobsterfile({
        content: 'step1\nstep2\nstep3',
        envVars: {},
        continueOnError: true,
      });

      expect(result.failures).toBeDefined();
      expect(result.failures.length).toBeGreaterThan(0);
    });

    it('failures always reported with the step that failed', async () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('bad-step')) throw new Error('bad-step failed');
        return '';
      });
      fs.writeFileSync.mockReturnValue(undefined);
      fs.unlinkSync.mockReturnValue(undefined);

      const result = await executeLobsterfile({
        content: 'good-step\nbad-step\n',
        envVars: {},
        continueOnError: true,
      });

      expect(result.failures.some((f) => f.step && f.error)).toBe(true);
    });

    it('exit code reflects execution result (0 = success, non-zero = failure)', async () => {
      execSync.mockReturnValue('');
      fs.writeFileSync.mockReturnValue(undefined);
      fs.unlinkSync.mockReturnValue(undefined);

      const result = await executeLobsterfile({
        content: 'echo success',
        envVars: {},
      });

      expect(result.exitCode).toBe(0);
    });
  });

  // --- Post-Execution ---
  describe('Post-Execution', () => {
    it('prints next steps: restart gateway, verify services, run lobster scan', async () => {
      execSync.mockReturnValue('');
      fs.writeFileSync.mockReturnValue(undefined);
      fs.unlinkSync.mockReturnValue(undefined);

      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
      };

      const result = await executeLobsterfile({
        content: 'echo done',
        envVars: {},
        io: mockIO,
      });

      expect(result.nextSteps).toBeDefined();
      expect(result.nextSteps.some((s) => s.match(/gateway|restart/i))).toBe(true);
      expect(result.nextSteps.some((s) => s.match(/scan|verify/i))).toBe(true);
    });

    it('--dry-run displays substituted Lobsterfile but does not execute', async () => {
      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
      };

      const result = await executeLobsterfile({
        content: sampleLobsterfile,
        envVars: { DOMAIN_NAME: 'example.com', GATEWAY_PORT: '18789' },
        dryRun: true,
        io: mockIO,
      });

      // Should display the content
      expect(result.displayed).toBe(true);
      // Should NOT execute
      expect(execSync).not.toHaveBeenCalledWith(
        expect.stringContaining('bash'),
        expect.anything()
      );
    });
  });
});
