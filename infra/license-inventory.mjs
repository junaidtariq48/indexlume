import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const virtualStore = path.join(root, 'node_modules', '.pnpm');
const output = path.resolve(
  process.env.LICENSE_REPORT_PATH ??
    path.join(root, 'artifacts', 'security', 'dependency-licenses.json'),
);

async function packageDirectories(nodeModulesDirectory) {
  const entries = await readdir(nodeModulesDirectory, { withFileTypes: true });
  const directories = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const entryPath = path.join(nodeModulesDirectory, entry.name);
    if (!entry.name.startsWith('@')) {
      directories.push(entryPath);
      continue;
    }

    const scopedEntries = await readdir(entryPath, { withFileTypes: true });
    for (const scopedEntry of scopedEntries) {
      if (scopedEntry.isDirectory()) {
        directories.push(path.join(entryPath, scopedEntry.name));
      }
    }
  }

  return directories;
}

function normalizeLicense(manifest) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (manifest.license && typeof manifest.license.type === 'string') {
    return manifest.license.type;
  }
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses
      .map((license) => (typeof license === 'string' ? license : license?.type))
      .filter(Boolean)
      .join(' OR ');
  }
  return null;
}

const storeEntries = await readdir(virtualStore, { withFileTypes: true });
const packages = new Map();

for (const storeEntry of storeEntries) {
  if (!storeEntry.isDirectory() || storeEntry.name === 'node_modules') continue;
  const nodeModulesDirectory = path.join(
    virtualStore,
    storeEntry.name,
    'node_modules',
  );

  let directories;
  try {
    directories = await packageDirectories(nodeModulesDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }

  for (const directory of directories) {
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(path.join(directory, 'package.json'), 'utf8'),
      );
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }

    if (!manifest.name || !manifest.version) continue;
    const key = `${manifest.name}@${manifest.version}`;
    packages.set(key, {
      name: manifest.name,
      version: manifest.version,
      license: normalizeLicense(manifest),
    });
  }
}

const inventory = [...packages.values()].sort(
  (left, right) =>
    left.name.localeCompare(right.name) ||
    left.version.localeCompare(right.version),
);
const unknown = inventory.filter((item) => !item.license);
const report = {
  generatedAt: new Date().toISOString(),
  source: 'installed packages resolved from pnpm-lock.yaml',
  packageCount: inventory.length,
  unknownLicenseCount: unknown.length,
  packages: inventory,
};

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `Dependency license inventory wrote ${inventory.length} packages (${unknown.length} without declared license metadata) to ${output}`,
);

if (unknown.length > 0) {
  console.error(
    `License inventory failed: ${unknown.map((item) => `${item.name}@${item.version}`).join(', ')}`,
  );
  process.exitCode = 1;
}
