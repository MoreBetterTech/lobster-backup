/**
 * package-recipes.js — Known-package setup recipes
 * 
 * Third-party packages that aren't in default apt repos need custom setup
 * (adding repos, keyrings, etc.) before `apt install` will work.
 * 
 * This is the convenience layer on top of the general apt source capture.
 * The apt source snapshot (backup.js) handles the general case mechanically.
 * These recipes handle the 80% case more readably and serve as a fallback
 * when apt sources weren't captured (e.g., migrating from an older backup).
 * 
 * Each recipe is idempotent — safe to run on a box where the package is
 * already installed or the repo is already configured.
 */

/**
 * Known package recipes indexed by package name.
 * Each recipe returns bash commands to set up the apt repo + install.
 * 
 * Recipe contract:
 *   - Must be idempotent (safe to re-run)
 *   - Must use sudo for privileged operations
 *   - Must add the repo AND install the package
 *   - Should check if already configured to avoid unnecessary downloads
 */
export const KNOWN_RECIPES = {
  caddy: {
    description: 'Caddy web server (from Cloudsmith repo)',
    detect: (pkg) => pkg === 'caddy',
    recipe: () => `# Caddy — requires third-party apt repo
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
sudo apt-get update
sudo apt-get install -y caddy
`,
  },

  nodejs: {
    description: 'Node.js (from NodeSource repo)',
    detect: (pkg) => pkg === 'nodejs',
    recipe: (version = '22') => `# Node.js ${version}.x — requires NodeSource apt repo
curl -fsSL https://deb.nodesource.com/setup_${version}.x | sudo -E bash -
sudo apt-get install -y nodejs
`,
  },

  gh: {
    description: 'GitHub CLI (from GitHub apt repo)',
    detect: (pkg) => pkg === 'gh',
    recipe: () => `# GitHub CLI — requires GitHub apt repo
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli-stable.list > /dev/null
sudo apt-get update
sudo apt-get install -y gh
`,
  },

  docker_ce: {
    description: 'Docker CE (from Docker apt repo)',
    detect: (pkg) => pkg === 'docker-ce' || pkg === 'docker-ce-cli',
    recipe: () => `# Docker CE — requires Docker apt repo
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io
`,
  },
};

/**
 * Check if a package name has a known recipe
 * @param {string} packageName - apt package name
 * @returns {object|null} Recipe object or null
 */
export function findRecipe(packageName) {
  for (const [key, recipe] of Object.entries(KNOWN_RECIPES)) {
    if (recipe.detect(packageName)) {
      return { key, ...recipe };
    }
  }
  return null;
}

/**
 * Given a list of apt packages, separate them into:
 *   - packages with known recipes (need special repo setup)
 *   - packages that can be installed with plain `apt install`
 * 
 * @param {string[]} packages - List of apt package names
 * @returns {object} { recipePackages: Array<{name, recipe}>, plainPackages: string[] }
 */
export function classifyPackages(packages) {
  const recipePackages = [];
  const plainPackages = [];
  
  for (const pkg of packages) {
    const recipe = findRecipe(pkg);
    if (recipe) {
      // Avoid duplicate recipes (e.g. docker-ce and docker-ce-cli both match docker_ce)
      if (!recipePackages.some(r => r.key === recipe.key)) {
        recipePackages.push({ name: pkg, key: recipe.key, recipe: recipe.recipe });
      }
    } else {
      plainPackages.push(pkg);
    }
  }
  
  return { recipePackages, plainPackages };
}

/**
 * Generate Lobsterfile content for a list of packages, using known recipes
 * where available and falling back to plain apt install for the rest.
 * 
 * @param {string[]} packages - List of apt package names
 * @returns {string} Bash script content for the Lobsterfile
 */
export function generatePackageInstallScript(packages) {
  const { recipePackages, plainPackages } = classifyPackages(packages);
  
  let script = '';
  
  // Add recipes first (they add repos that apt update needs)
  if (recipePackages.length > 0) {
    script += '# --- Third-party package repos ---\n';
    for (const { recipe } of recipePackages) {
      script += recipe() + '\n';
    }
  }
  
  // Add plain apt packages as a single install line
  if (plainPackages.length > 0) {
    script += '# --- Standard apt packages ---\n';
    script += 'sudo apt-get update\n';
    script += `sudo apt-get install -y ${plainPackages.join(' ')}\n`;
    script += '\n';
  }
  
  return script;
}
