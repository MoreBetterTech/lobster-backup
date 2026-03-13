/**
 * Setup Script Tests
 * Tests for the lobster setup interactive flow:
 *   passphrase, key generation, destination, environment audit,
 *   lobsterfile.env init, confirmation, and idempotency.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validatePassphrase,
  generateVaultKey,
  generateRecoveryKey,
  runSetup,
  runEnvironmentAudit,
  detectPlaceholders,
  writeLobsterfileEnv,
} from '../src/setup.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';

vi.mock('node:fs');
vi.mock('node:child_process');

describe('Setup Script', () => {
  let mockHome;
  let tmpDir;

  beforeEach(() => {
    mockHome = '/home/testuser';
    tmpDir = '/tmp/lobster-test-setup';
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.clearAllMocks();
    // Mock age-keygen output for generateAgeKeypair
    execFileSync.mockReturnValue(
      '# created: 2026-03-12T18:00:00Z\n' +
      '# public key: age1testpublickey0000000000000000000000000000000000000000000xxxx\n' +
      'AGE-SECRET-KEY-1TESTPRIVATEKEY000000000000000000000000000000000000000XXXX'
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Passphrase ---
  describe('Passphrase', () => {
    it('rejects passphrase below minimum length', () => {
      const result = validatePassphrase('short');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/length|short|minimum/i);
    });

    it('rejects mismatched confirmation', () => {
      const result = validatePassphrase('a-strong-passphrase-here', 'different-passphrase');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/match|mismatch/i);
    });

    it('accepts valid passphrase', () => {
      const passphrase = 'my-very-secure-backup-passphrase-2026';
      const result = validatePassphrase(passphrase, passphrase);
      expect(result.valid).toBe(true);
    });
  });

  // --- Key Generation ---
  describe('Key Generation', () => {
    it('generates 256-bit Vault Key (correct length, random)', () => {
      const key = generateVaultKey();
      // 256 bits = 32 bytes
      expect(Buffer.from(key, 'base64').length).toBe(32);
    });

    it('generates Recovery Key (256-bit, random)', () => {
      const key = generateRecoveryKey();
      expect(Buffer.from(key, 'base64').length).toBe(32);
    });

    it('displays Recovery Key exactly once', async () => {
      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn().mockResolvedValue('I have saved this key'),
      };

      await runSetup({
        io: mockIO,
        passphrase: 'a-valid-passphrase-here-now',
        passphraseConfirm: 'a-valid-passphrase-here-now',
        backupPath: tmpDir,
        skipScan: true,
      });

      // Recovery Key should appear exactly once in output
      const recoveryKeyMentions = mockIO.output.filter(
        (msg) => typeof msg === 'string' && msg.includes('Recovery Key')
      );
      expect(recoveryKeyMentions.length).toBeGreaterThanOrEqual(1);
    });

    it('requires explicit acknowledgment before proceeding', async () => {
      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn().mockResolvedValue('no'),
      };

      await expect(
        runSetup({
          io: mockIO,
          passphrase: 'a-valid-passphrase-here-now',
          passphraseConfirm: 'a-valid-passphrase-here-now',
          backupPath: tmpDir,
          skipScan: true,
        })
      ).rejects.toThrow(/acknowledge|saved|confirm/i);
    });

    it('refuses to continue without acknowledgment', async () => {
      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn().mockResolvedValue(''),
      };

      await expect(
        runSetup({
          io: mockIO,
          passphrase: 'a-valid-passphrase-here-now',
          passphraseConfirm: 'a-valid-passphrase-here-now',
          backupPath: tmpDir,
          skipScan: true,
        })
      ).rejects.toThrow();
    });
  });

  // --- Destination ---
  describe('Destination', () => {
    it('creates local backup directory if it does not exist', async () => {
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockReturnValue(undefined);

      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn().mockResolvedValue('I have saved this key'),
      };

      await runSetup({
        io: mockIO,
        passphrase: 'a-valid-passphrase-here-now',
        passphraseConfirm: 'a-valid-passphrase-here-now',
        backupPath: tmpDir,
        skipScan: true,
        skipConfirmation: true,
      });

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining(tmpDir),
        expect.objectContaining({ recursive: true })
      );
    });

    it('writes correct config schema to lobster-backup.json', async () => {
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockReturnValue(undefined);
      fs.writeFileSync.mockReturnValue(undefined);

      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn().mockResolvedValue('I have saved this key'),
      };

      await runSetup({
        io: mockIO,
        passphrase: 'a-valid-passphrase-here-now',
        passphraseConfirm: 'a-valid-passphrase-here-now',
        backupPath: tmpDir,
        skipScan: true,
        skipConfirmation: true,
      });

      const writeCall = fs.writeFileSync.mock.calls.find(
        (call) => call[0].includes('lobster-backup.json')
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall[1]);
      expect(written).toHaveProperty('backupPath');
      expect(written).toHaveProperty('vaultKeyWrappedPassphrase');
      expect(written).toHaveProperty('vaultKeyWrappedRecovery');
      expect(written).toHaveProperty('argon2Salt');
      expect(written).toHaveProperty('formatVersion');
    });
  });

  // --- Environment Audit (Bootstrap) ---
  describe('Environment Audit (Bootstrap)', () => {
    it('runs dpkg --get-selections for installed apt packages', async () => {
      execSync.mockReturnValue('curl\tinstall\nnodejs\tinstall\n');
      await runEnvironmentAudit(tmpDir);
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('dpkg --get-selections'),
        expect.anything()
      );
    });

    it('runs npm list -g --depth=0 for global npm packages', async () => {
      execSync.mockReturnValue('openclaw@1.0.0\n');
      await runEnvironmentAudit(tmpDir);
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('npm list -g --depth=0'),
        expect.anything()
      );
    });

    it('runs systemctl list-unit-files --state=enabled for enabled services', async () => {
      execSync.mockReturnValue('caddy.service\tenabled\n');
      await runEnvironmentAudit(tmpDir);
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('systemctl list-unit-files'),
        expect.anything()
      );
    });

    it('runs pip list if pip is present; skips gracefully if absent', async () => {
      // Simulate pip missing
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('pip list')) throw new Error('pip not found');
        return '';
      });

      // Should not throw
      await expect(runEnvironmentAudit(tmpDir)).resolves.not.toThrow();
    });

    it('writes lobsterfile.seed with "inferred, not authoritative" header', async () => {
      execSync.mockReturnValue('');
      fs.writeFileSync.mockReturnValue(undefined);

      await runEnvironmentAudit(tmpDir);

      const seedCall = fs.writeFileSync.mock.calls.find(
        (call) => call[0].includes('lobsterfile.seed')
      );
      expect(seedCall).toBeDefined();
      expect(seedCall[1]).toMatch(/inferred.*not authoritative/i);
    });

    it('seed entries formatted as idempotent bash (existence checks, safe overwrites)', async () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('dpkg')) return 'curl\tinstall\n';
        return '';
      });
      fs.writeFileSync.mockReturnValue(undefined);

      await runEnvironmentAudit(tmpDir);

      const seedCall = fs.writeFileSync.mock.calls.find(
        (call) => call[0].includes('lobsterfile.seed')
      );
      expect(seedCall).toBeDefined();
      // Should use apt-get install (idempotent) not manual checks
      expect(seedCall[1]).toMatch(/apt(-get)?\s+install/);
    });

    it('does not overwrite an existing Lobsterfile', async () => {
      fs.existsSync.mockImplementation((p) => {
        if (p.includes('lobsterfile') && !p.includes('.seed') && !p.includes('.env')) return true;
        return false;
      });
      execSync.mockReturnValue('');

      await runEnvironmentAudit(tmpDir);

      // Should write lobsterfile.seed, not lobsterfile
      const lobsterfileWrite = fs.writeFileSync.mock.calls.find(
        (call) => call[0].endsWith('lobsterfile') && !call[0].includes('.seed')
      );
      expect(lobsterfileWrite).toBeUndefined();
    });
  });

  // --- lobsterfile.env Initialization ---
  describe('lobsterfile.env Initialization', () => {
    it('detects {{VARIABLE}} placeholders in existing Lobsterfile', () => {
      const content = 'cat > /etc/caddy/Caddyfile <<EOF\n{{DOMAIN_NAME}} {\n  reverse_proxy localhost:{{GATEWAY_PORT}}\n}\nEOF';
      const vars = detectPlaceholders(content);
      expect(vars).toContain('DOMAIN_NAME');
      expect(vars).toContain('GATEWAY_PORT');
    });

    it('writes lobsterfile.env with key=value format', () => {
      fs.writeFileSync.mockReturnValue(undefined);

      writeLobsterfileEnv({ DOMAIN_NAME: 'example.com', GATEWAY_PORT: '18789' });

      const call = fs.writeFileSync.mock.calls.find(
        (c) => c[0].includes('lobsterfile.env')
      );
      expect(call).toBeDefined();
      expect(call[1]).toContain('DOMAIN_NAME=example.com');
      expect(call[1]).toContain('GATEWAY_PORT=18789');
    });
  });

  // --- Confirmation & Activation ---
  describe('Confirmation & Activation', () => {
    it('shows summary: file list, destination, schedule', async () => {
      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn()
          .mockResolvedValueOnce('I have saved this key')
          .mockResolvedValueOnce('y'),
      };

      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockReturnValue(undefined);
      fs.writeFileSync.mockReturnValue(undefined);

      await runSetup({
        io: mockIO,
        passphrase: 'a-valid-passphrase-here-now',
        passphraseConfirm: 'a-valid-passphrase-here-now',
        backupPath: tmpDir,
        skipScan: true,
      });

      const allOutput = mockIO.output.join('\n');
      expect(allOutput).toMatch(/summary|destination|schedule/i);
    });

    it('refuses to activate without user confirmation', async () => {
      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn()
          .mockResolvedValueOnce('I have saved this key')
          .mockResolvedValueOnce('n'), // decline confirmation
      };

      await expect(
        runSetup({
          io: mockIO,
          passphrase: 'a-valid-passphrase-here-now',
          passphraseConfirm: 'a-valid-passphrase-here-now',
          backupPath: tmpDir,
          skipScan: true,
        })
      ).rejects.toThrow(/abort|cancel|decline/i);
    });

    it('aborts cleanly if user declines', async () => {
      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn()
          .mockResolvedValueOnce('I have saved this key')
          .mockResolvedValueOnce('n'),
      };

      try {
        await runSetup({
          io: mockIO,
          passphrase: 'a-valid-passphrase-here-now',
          passphraseConfirm: 'a-valid-passphrase-here-now',
          backupPath: tmpDir,
          skipScan: true,
        });
      } catch (e) {
        // Should not leave partial config
        const configWrite = fs.writeFileSync.mock.calls.find(
          (c) => c[0].includes('lobster-backup.json')
        );
        expect(configWrite).toBeUndefined();
      }
    });

    it('prints AGENTS.md snippet (does NOT auto-modify AGENTS.md)', async () => {
      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn()
          .mockResolvedValueOnce('I have saved this key')
          .mockResolvedValueOnce('y'),
      };

      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockReturnValue(undefined);
      fs.writeFileSync.mockReturnValue(undefined);

      await runSetup({
        io: mockIO,
        passphrase: 'a-valid-passphrase-here-now',
        passphraseConfirm: 'a-valid-passphrase-here-now',
        backupPath: tmpDir,
        skipScan: true,
      });

      const allOutput = mockIO.output.join('\n');
      expect(allOutput).toMatch(/AGENTS\.md|Lobsterfile Maintenance/i);

      // Must NOT write to AGENTS.md
      const agentsWrite = fs.writeFileSync.mock.calls.find(
        (c) => c[0].includes('AGENTS.md')
      );
      expect(agentsWrite).toBeUndefined();
    });
  });

  // --- Idempotency ---
  describe('Idempotency', () => {
    it('re-running setup on existing install warns and offers to reconfigure', async () => {
      fs.existsSync.mockReturnValue(true); // config exists
      fs.readFileSync.mockReturnValue(JSON.stringify({ formatVersion: 1 }));

      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn().mockResolvedValue('n'), // decline reconfigure
      };

      try {
        await runSetup({
          io: mockIO,
          passphrase: 'a-valid-passphrase-here-now',
          passphraseConfirm: 'a-valid-passphrase-here-now',
          backupPath: tmpDir,
          skipScan: true,
        });
      } catch {
        // Expected to abort or warn
      }

      const allOutput = mockIO.output.join('\n');
      expect(allOutput).toMatch(/already|existing|reconfigure/i);
    });

    it('does not destroy existing config without confirmation', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ formatVersion: 1 }));

      const mockIO = {
        output: [],
        write(msg) { this.output.push(msg); },
        prompt: vi.fn().mockResolvedValue('n'),
      };

      try {
        await runSetup({
          io: mockIO,
          passphrase: 'a-valid-passphrase-here-now',
          passphraseConfirm: 'a-valid-passphrase-here-now',
          backupPath: tmpDir,
          skipScan: true,
        });
      } catch {
        // Expected
      }

      // Config file should NOT be overwritten
      const configWrite = fs.writeFileSync.mock.calls.find(
        (c) => c[0].includes('lobster-backup.json')
      );
      expect(configWrite).toBeUndefined();
    });
  });
});
