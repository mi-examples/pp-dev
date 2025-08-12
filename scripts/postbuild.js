import path from 'path';
import fs from 'fs';

const appDirectory = fs.realpathSync(process.cwd());
const packageJsonPath = path.resolve(appDirectory, 'package.json');

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const distPath = path.resolve(appDirectory, 'dist');

const distEsmPath = path.resolve(distPath, 'esm');
const distCjsPath = path.resolve(distPath, 'cjs');

const distEsmPackageJsonPath = path.resolve(distEsmPath, 'package.json');
const distCjsPackageJsonPath = path.resolve(distCjsPath, 'package.json');

// Create package.json files for each format
const esmPackageJson = {
  ...packageJson,
  type: 'module',
  // Remove unnecessary fields for distribution
  scripts: undefined,
  devDependencies: undefined,
  private: false,
};

const cjsPackageJson = {
  ...packageJson,
  type: 'commonjs',
  // Remove unnecessary fields for distribution
  scripts: undefined,
  devDependencies: undefined,
  private: false,
};

// Ensure directories exist
if (!fs.existsSync(distEsmPath)) {
  fs.mkdirSync(distEsmPath, { recursive: true });
}
if (!fs.existsSync(distCjsPath)) {
  fs.mkdirSync(distCjsPath, { recursive: true });
}

fs.writeFileSync(distEsmPackageJsonPath, JSON.stringify(esmPackageJson, null, 2));
fs.writeFileSync(distCjsPackageJsonPath, JSON.stringify(cjsPackageJson, null, 2));

// Copy README and LICENSE to dist for better package distribution
const filesToCopy = ['README.md', 'LICENSE.md', 'CHANGELOG.md'];
filesToCopy.forEach(file => {
  const sourcePath = path.resolve(appDirectory, file);
  const targetPath = path.resolve(distPath, file);
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, targetPath);
  }
});

console.log('✅ Post-build processing completed successfully');
console.log(`📦 ESM build: ${distEsmPath}`);
console.log(`📦 CJS build: ${distCjsPath}`);
console.log(`📦 Types: ${path.resolve(distPath, 'types')}`);
console.log(`📦 Client: ${path.resolve(distPath, 'client')}`);
