const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index.js');
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'path-navigator-integration-'));
  const shortTemporaryRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const profileRoot = path.join(shortTemporaryRoot, `pathnav-vscode-${process.pid}`);
  const userDataDir = path.join(profileRoot, 'user');
  const extensionsDir = path.join(profileRoot, 'ext');
  const workspaceFile = path.join(fixtureRoot, 'path-navigator.code-workspace');
  await fs.mkdir(path.join(fixtureRoot, 'src', 'nested'), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, 'src', 'local-main.ts'), 'export {}\n');
  await fs.writeFile(path.join(fixtureRoot, 'src', 'nested', 'local-deep.ts'), 'export {}\n');
  await fs.writeFile(workspaceFile, JSON.stringify({
    folders: [
      { path: fixtureRoot, name: 'local-fixture' },
    ],
  }));

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspaceFile,
        '--disable-extensions',
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
      ],
      extensionTestsEnv: {
        PATH_NAVIGATOR_LOCAL_FIXTURE: fixtureRoot,
      },
    });
  } finally {
    await Promise.all([
      fs.rm(fixtureRoot, { recursive: true, force: true }),
      fs.rm(profileRoot, { recursive: true, force: true }),
    ]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
