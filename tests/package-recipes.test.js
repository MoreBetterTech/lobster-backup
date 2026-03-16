/**
 * Package Recipes Tests
 * Tests for known-package setup recipes (Caddy, Node.js, gh, Docker).
 * These generate the correct repo setup commands for third-party packages
 * that aren't in default apt repos.
 */
import { describe, it, expect } from 'vitest';
import {
  KNOWN_RECIPES,
  findRecipe,
  classifyPackages,
  generatePackageInstallScript,
} from '../src/package-recipes.js';

describe('Package Recipes', () => {
  describe('findRecipe', () => {
    it('finds Caddy recipe for "caddy"', () => {
      const recipe = findRecipe('caddy');
      expect(recipe).not.toBeNull();
      expect(recipe.key).toBe('caddy');
    });

    it('finds Node.js recipe for "nodejs"', () => {
      const recipe = findRecipe('nodejs');
      expect(recipe).not.toBeNull();
      expect(recipe.key).toBe('nodejs');
    });

    it('finds gh CLI recipe for "gh"', () => {
      const recipe = findRecipe('gh');
      expect(recipe).not.toBeNull();
      expect(recipe.key).toBe('gh');
    });

    it('finds Docker recipe for "docker-ce"', () => {
      const recipe = findRecipe('docker-ce');
      expect(recipe).not.toBeNull();
      expect(recipe.key).toBe('docker_ce');
    });

    it('finds Docker recipe for "docker-ce-cli"', () => {
      const recipe = findRecipe('docker-ce-cli');
      expect(recipe).not.toBeNull();
      expect(recipe.key).toBe('docker_ce');
    });

    it('returns null for unknown packages', () => {
      const recipe = findRecipe('curl');
      expect(recipe).toBeNull();
    });

    it('returns null for standard apt packages', () => {
      expect(findRecipe('git')).toBeNull();
      expect(findRecipe('vim')).toBeNull();
      expect(findRecipe('build-essential')).toBeNull();
    });
  });

  describe('Recipe Content', () => {
    it('Caddy recipe adds Cloudsmith repo and keyring', () => {
      const script = KNOWN_RECIPES.caddy.recipe();
      expect(script).toContain('cloudsmith.io');
      expect(script).toContain('caddy-stable-archive-keyring.gpg');
      expect(script).toContain('apt-get install -y caddy');
    });

    it('Node.js recipe uses NodeSource setup', () => {
      const script = KNOWN_RECIPES.nodejs.recipe();
      expect(script).toContain('nodesource.com');
      expect(script).toContain('apt-get install -y nodejs');
    });

    it('gh CLI recipe adds GitHub apt repo', () => {
      const script = KNOWN_RECIPES.gh.recipe();
      expect(script).toContain('cli.github.com');
      expect(script).toContain('githubcli-archive-keyring.gpg');
      expect(script).toContain('apt-get install -y gh');
    });

    it('Docker recipe adds Docker apt repo', () => {
      const script = KNOWN_RECIPES.docker_ce.recipe();
      expect(script).toContain('download.docker.com');
      expect(script).toContain('apt-get install -y docker-ce');
    });

    it('all recipes use sudo for privileged operations', () => {
      for (const [key, recipe] of Object.entries(KNOWN_RECIPES)) {
        const script = recipe.recipe();
        // Every apt-get install should have sudo
        const aptLines = script.split('\n').filter(l => l.includes('apt-get install'));
        for (const line of aptLines) {
          expect(line).toContain('sudo');
        }
      }
    });

    it('all recipes are valid bash (no unclosed quotes)', () => {
      for (const [key, recipe] of Object.entries(KNOWN_RECIPES)) {
        const script = recipe.recipe();
        // Basic check: balanced single and double quotes
        const singleQuotes = (script.match(/'/g) || []).length;
        const doubleQuotes = (script.match(/"/g) || []).length;
        expect(singleQuotes % 2).toBe(0);
        expect(doubleQuotes % 2).toBe(0);
      }
    });
  });

  describe('classifyPackages', () => {
    it('separates recipe packages from plain packages', () => {
      const packages = ['curl', 'caddy', 'git', 'nodejs', 'vim'];
      const { recipePackages, plainPackages } = classifyPackages(packages);

      expect(recipePackages.length).toBe(2);
      expect(recipePackages.some(r => r.key === 'caddy')).toBe(true);
      expect(recipePackages.some(r => r.key === 'nodejs')).toBe(true);
      expect(plainPackages).toEqual(['curl', 'git', 'vim']);
    });

    it('deduplicates recipes (docker-ce and docker-ce-cli → one recipe)', () => {
      const packages = ['docker-ce', 'docker-ce-cli', 'curl'];
      const { recipePackages, plainPackages } = classifyPackages(packages);

      expect(recipePackages.length).toBe(1);
      expect(recipePackages[0].key).toBe('docker_ce');
      expect(plainPackages).toEqual(['curl']);
    });

    it('handles all-plain packages', () => {
      const packages = ['curl', 'git', 'vim'];
      const { recipePackages, plainPackages } = classifyPackages(packages);

      expect(recipePackages.length).toBe(0);
      expect(plainPackages).toEqual(['curl', 'git', 'vim']);
    });

    it('handles all-recipe packages', () => {
      const packages = ['caddy', 'nodejs', 'gh'];
      const { recipePackages, plainPackages } = classifyPackages(packages);

      expect(recipePackages.length).toBe(3);
      expect(plainPackages).toEqual([]);
    });

    it('handles empty package list', () => {
      const { recipePackages, plainPackages } = classifyPackages([]);
      expect(recipePackages).toEqual([]);
      expect(plainPackages).toEqual([]);
    });
  });

  describe('generatePackageInstallScript', () => {
    it('puts recipe setup before plain apt install', () => {
      const script = generatePackageInstallScript(['curl', 'caddy', 'git']);

      const caddyIdx = script.indexOf('cloudsmith.io');
      const aptIdx = script.lastIndexOf('sudo apt-get install -y curl git');

      expect(caddyIdx).toBeLessThan(aptIdx);
    });

    it('generates valid bash for mixed packages', () => {
      const script = generatePackageInstallScript(['curl', 'caddy', 'nodejs', 'vim']);

      expect(script).toContain('cloudsmith.io');  // caddy recipe
      expect(script).toContain('nodesource.com'); // nodejs recipe
      expect(script).toContain('sudo apt-get install -y curl vim'); // plain packages
    });

    it('handles only plain packages (no recipes section)', () => {
      const script = generatePackageInstallScript(['curl', 'git']);

      expect(script).not.toContain('Third-party');
      expect(script).toContain('sudo apt-get install -y curl git');
    });

    it('handles only recipe packages (no plain section)', () => {
      const script = generatePackageInstallScript(['caddy', 'gh']);

      expect(script).toContain('cloudsmith.io');
      expect(script).toContain('cli.github.com');
      expect(script).not.toContain('Standard apt packages');
    });

    it('handles empty list', () => {
      const script = generatePackageInstallScript([]);
      expect(script).toBe('');
    });
  });
});
