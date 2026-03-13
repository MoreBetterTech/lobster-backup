/**
 * Internal Manifest Tests
 * Tests for generating the file list from ~/.openclaw/.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateInternalManifest } from '../src/manifest.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node:fs');

describe('Manifest — Internal', () => {
  let mockHome;
  let ocDir;

  beforeEach(() => {
    mockHome = '/home/testuser';
    ocDir = path.join(mockHome, '.openclaw');
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Build a mock filesystem tree
  function mockOCTree(files) {
    fs.existsSync.mockImplementation((p) => files.some((f) => p === f || f.startsWith(p + '/')));
    fs.readdirSync.mockImplementation((dir, opts) => {
      const entries = files
        .filter((f) => f.startsWith(dir + '/'))
        .map((f) => {
          const rel = f.slice(dir.length + 1);
          const name = rel.split('/')[0];
          const isDir = rel.includes('/');
          return {
            name,
            isFile: () => !isDir,
            isDirectory: () => isDir,
            isSymbolicLink: () => false,
          };
        });
      // Deduplicate by name
      const seen = new Set();
      return entries.filter((e) => {
        if (seen.has(e.name)) return false;
        seen.add(e.name);
        return true;
      });
    });
    fs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => false });
  }

  it('generates correct file list from a mock ~/.openclaw/ tree', () => {
    const files = [
      `${ocDir}/workspace/MEMORY.md`,
      `${ocDir}/workspace/SOUL.md`,
      `${ocDir}/openclaw.json`,
      `${ocDir}/workspace/memory/2026-03-10.md`,
      `${ocDir}/skills/lobster-backup/SKILL.md`,
      `${ocDir}/cron/jobs.json`,
      `${ocDir}/identity/keypair.json`,
    ];
    mockOCTree(files);

    const manifest = generateInternalManifest(ocDir);
    expect(manifest.length).toBeGreaterThanOrEqual(files.length);
  });

  it('includes all specified paths (workspace files, skills, cron, identity)', () => {
    const files = [
      `${ocDir}/workspace/MEMORY.md`,
      `${ocDir}/workspace/SOUL.md`,
      `${ocDir}/workspace/USER.md`,
      `${ocDir}/workspace/IDENTITY.md`,
      `${ocDir}/workspace/AGENTS.md`,
      `${ocDir}/workspace/TOOLS.md`,
      `${ocDir}/workspace/HEARTBEAT.md`,
      `${ocDir}/workspace/memory/2026-03-10.md`,
      `${ocDir}/workspace/memory/heartbeat-state.json`,
      `${ocDir}/openclaw.json`,
      `${ocDir}/skills/custom-skill/SKILL.md`,
      `${ocDir}/cron/jobs.json`,
      `${ocDir}/identity/agent.json`,
    ];
    mockOCTree(files);

    const manifest = generateInternalManifest(ocDir);
    const paths = manifest.map((e) => e.path || e);

    expect(paths).toEqual(expect.arrayContaining([
      expect.stringContaining('MEMORY.md'),
      expect.stringContaining('SOUL.md'),
      expect.stringContaining('openclaw.json'),
      expect.stringContaining('skills/'),
      expect.stringContaining('cron/jobs.json'),
      expect.stringContaining('identity/'),
    ]));
  });

  it('skips files that do not exist (graceful on sparse installs)', () => {
    // Only openclaw.json exists
    const files = [`${ocDir}/openclaw.json`];
    mockOCTree(files);

    const manifest = generateInternalManifest(ocDir);
    // Should not throw, and should include only existing files
    expect(manifest.length).toBeGreaterThanOrEqual(1);
    const paths = manifest.map((e) => e.path || e);
    expect(paths.some((p) => p.includes('MEMORY.md'))).toBe(false);
  });

  it('applies default exclusions: .git/, node_modules/, *.log, tmp/, cache/', () => {
    const files = [
      `${ocDir}/workspace/SOUL.md`,
      `${ocDir}/.git/HEAD`,
      `${ocDir}/node_modules/vitest/index.js`,
      `${ocDir}/workspace/debug.log`,
      `${ocDir}/tmp/scratch.txt`,
      `${ocDir}/cache/data.bin`,
      `${ocDir}/.cache/stuff.bin`,
    ];
    mockOCTree(files);

    const manifest = generateInternalManifest(ocDir);
    const paths = manifest.map((e) => e.path || e);

    expect(paths.some((p) => p.includes('.git/'))).toBe(false);
    expect(paths.some((p) => p.includes('node_modules/'))).toBe(false);
    expect(paths.some((p) => p.endsWith('.log'))).toBe(false);
    expect(paths.some((p) => p.includes('tmp/'))).toBe(false);
    expect(paths.some((p) => p.includes('cache/'))).toBe(false);
  });

  it('custom exclusions from config are respected', () => {
    const files = [
      `${ocDir}/workspace/SOUL.md`,
      `${ocDir}/workspace/secret-notes.md`,
    ];
    mockOCTree(files);

    const manifest = generateInternalManifest(ocDir, {
      exclusions: ['secret-notes.md'],
    });
    const paths = manifest.map((e) => e.path || e);
    expect(paths.some((p) => p.includes('secret-notes.md'))).toBe(false);
  });

  it('includes workspace subdirectories (freshkit, docker, etc.) — not just top-level .md files', () => {
    const files = [
      `${ocDir}/workspace/SOUL.md`,
      `${ocDir}/workspace/MEMORY.md`,
      `${ocDir}/workspace/freshkit/server.js`,
      `${ocDir}/workspace/freshkit/.env`,
      `${ocDir}/workspace/freshkit/agents/index.js`,
      `${ocDir}/workspace/docker/docker-compose.yml`,
    ];
    mockOCTree(files);

    const manifest = generateInternalManifest(ocDir);
    const paths = manifest.map((e) => e.path || e);

    expect(paths).toEqual(expect.arrayContaining([
      expect.stringContaining('freshkit/server.js'),
      expect.stringContaining('freshkit/.env'),
      expect.stringContaining('docker/docker-compose.yml'),
    ]));
  });

  it('does not traverse excluded directories (performance)', () => {
    const files = [
      `${ocDir}/workspace/SOUL.md`,
      `${ocDir}/node_modules/vitest/index.js`,
    ];
    mockOCTree(files);

    generateInternalManifest(ocDir);

    // readdirSync should never be called with a node_modules path
    const readdirCalls = fs.readdirSync.mock.calls.map((c) => c[0]);
    expect(readdirCalls.some((p) => p.includes('node_modules'))).toBe(false);
  });
});
