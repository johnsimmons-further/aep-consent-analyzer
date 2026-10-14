import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// Core extension files to copy into dist/
const EXTENSION_FILES = [
  'manifest.json',
  'background.js',
  'index.html',
  'src/core/consent-engine.js',
  'src/extension/content-script.js',
  'src/extension/page-hook.js',
  'src/simulator/alloy-simulator.js',
  'src/ui/app.js',
  'src/ui/styles.css'
];

/**
 * Recursively collects any additional files inside a directory if accessible,
 * merging with the known EXTENSION_FILES list.
 */
function discoverFiles(relDir, collectedSet) {
  const absDir = path.join(ROOT_DIR, relDir);
  try {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = path.posix.join(relDir, entry.name);
      if (entry.isDirectory()) {
        discoverFiles(relPath, collectedSet);
      } else if (entry.isFile()) {
        collectedSet.add(relPath);
      }
    }
  } catch {
    // Fallback to explicit EXTENSION_FILES list if directory listing is restricted
  }
}

function buildExtension() {
  console.log('Building AEP Consent Analyzer Chrome Extension into dist/...');

  // 1. Validate manifest.json
  const manifestPath = path.join(ROOT_DIR, 'manifest.json');
  const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);

  if (manifest.manifest_version !== 3) {
    throw new Error(`Expected manifest_version 3, found ${manifest.manifest_version}`);
  }

  // 2. Clean and recreate dist/
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 3. Collect all files to copy
  const filesToCopy = new Set(EXTENSION_FILES);
  discoverFiles('src', filesToCopy);

  let copiedCount = 0;
  for (const relPath of filesToCopy) {
    const srcFile = path.join(ROOT_DIR, relPath);
    const destFile = path.join(DIST_DIR, relPath);

    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(srcFile, destFile);
    copiedCount++;
    console.log(`  ✓ ${relPath}`);
  }

  console.log(`\nBuild complete! (${copiedCount} files copied)`);
  console.log(`Unpacked extension directory ready at:\n  ${DIST_DIR}`);
}

buildExtension();
