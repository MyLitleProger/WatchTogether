// Сборка установщика через API electron-builder (обходим CLI-шимы окружения).
//
// Два правила, выстраданные на этом окружении:
// 1) Запускать настоящим Node.js (C:\Program Files\nodejs\node.exe): если node —
//    шим на Electron (ELECTRON_RUN_AS_NODE), asar-хук рантайма портит app.asar
//    («Invalid package»). build.mjs делает это автоматически.
// 2) Серверные node_modules собираются заново (только production-зависимости)
//    во временный каталог ВНЕ OneDrive: OneDrive держит файлы во время синхронизации
//    (EBUSY на copyfile), а dev-зависимости (typescript и т.п.) в установщике не нужны.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.ELECTRON_NO_ASAR = '1';

const desktopDir = __dirname;
const serverDir = path.join(desktopDir, '..', 'server');
const stage = path.join(os.tmpdir(), 'wt-server-stage');
const realNode = 'C:\\Program Files\\nodejs\\node.exe';
const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

function run(label, cmd, args, cwd) {
  console.log(`▶ ${label}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`✗ Шаг «${label}» завершился с кодом ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

// 1. Стаднг сервера: package.json + prod-зависимости + собранный dist.
console.log('▶ Подготовка сервера (production-зависимости во временном каталоге)');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(path.join(serverDir, 'package.json'), path.join(stage, 'package.json'));
// Лок-файл — чтобы в установщик (и в сборку на GitHub) попали ровно те версии
// зависимостей, что проверены локально, а не свежие из диапазонов package.json.
const serverLock = path.join(serverDir, 'package-lock.json');
if (fs.existsSync(serverLock)) fs.copyFileSync(serverLock, path.join(stage, 'package-lock.json'));
fs.cpSync(path.join(serverDir, 'dist'), path.join(stage, 'dist'), { recursive: true });
run('npm install --omit=dev (сервер, staging)',
  fs.existsSync(npmCli) ? realNode : 'npm',
  fs.existsSync(npmCli) ? [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund'] : ['install', '--omit=dev', '--no-audit', '--no-fund'],
  stage);

// 2. electron-builder.
const builder = require('electron-builder');
const pkg = require('./package.json');

// Выходной каталог можно переопределить (WT_OUT) — полезно, когда OneDrive
// держит файлы release/ во время синхронизации.
const outDir = process.env.WT_OUT || pkg.build.directories.output;

builder.build({
  targets: builder.Platform.WINDOWS.createTarget(['nsis']),
  // С GH_TOKEN в окружении релиз сразу публикуется в GitHub Releases
  // (latest.yml + exe + blockmap) — оттуда работают автообновления.
  // Провайдер публикации задаём здесь, а не в package.json: electron-builder
  // склеивает конфиг из package.json с программным и ломает массив publish.
  publish: process.env.GH_TOKEN ? 'always' : 'never',
  config: {
    ...pkg.build,
    publish: [{ provider: 'github', owner: 'MyLitleProger', repo: 'WatchTogether', releaseType: 'release' }],
    directories: { ...pkg.build.directories, output: outDir },
    extraResources: [
      { from: stage, to: 'server' },
      { from: '../app/dist', to: 'client' },
    ],
  },
  projectDir: desktopDir,
})
  .then((files) => {
    console.log('Собрано:');
    for (const f of files) console.log('  ' + f);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
