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

const esmPackageJson = {
  ...packageJson,
  type: 'module',
};

const cjsPackageJson = {
  ...packageJson,
  type: 'commonjs',
};

fs.writeFileSync(distEsmPackageJsonPath, JSON.stringify(esmPackageJson, null, 2));
fs.writeFileSync(distCjsPackageJsonPath, JSON.stringify(cjsPackageJson, null, 2));
