const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../../..');
const webDist = path.join(repoRoot, 'packages/web/dist');
const serverDistWeb = path.join(repoRoot, 'packages/server/dist/web');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function buildWeb() {
  const result = spawnSync(
    npmCommand,
    ['run', 'build', '--workspace=packages/web'],
    {
      cwd: repoRoot,
      stdio: 'inherit',
    }
  );

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function copyDirectory(sourceDir, targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

buildWeb();
copyDirectory(webDist, serverDistWeb);
console.log(`Copied web assets to ${path.relative(repoRoot, serverDistWeb)}`);
