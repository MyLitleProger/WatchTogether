#!/usr/bin/env node
// Быстрая сборка WatchTogether: ставит зависимости (если нужно) и собирает клиент.
// Использование:  node build.mjs   или   npm run build
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(root, 'app');
const serverDir = path.join(root, 'server');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

let failed = false;

function run(label, cmd, args, cwd) {
  console.log(`\n▶ ${label}`);
  // shell нужен для запуска npm.cmd на Windows; аргументы у нас фиксированные, инъекций нет.
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    console.error(`✗ Шаг «${label}» завершился с кодом ${r.status}`);
    failed = true;
    process.exit(r.status ?? 1);
  }
}

function ensureDeps(dir, name) {
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    run(`Установка зависимостей (${name})`, npm, ['install'], dir);
  } else {
    console.log(`✓ Зависимости ${name} уже установлены`);
  }
}

console.log('═══ WatchTogether — сборка ═══');

ensureDeps(appDir, 'клиента');
ensureDeps(serverDir, 'сервера');

run('Сборка клиента (vite build → app/dist)', npm, ['run', 'build'], appDir);
run('Компиляция сервера (tsc → server/dist)', npm, ['run', 'build'], serverDir);

if (withInstaller()) {
  ensureDeps(path.join(root, 'desktop'), 'desktop');
  // electron-builder критично запускать настоящим Node.js: если node — шим
  // на Electron (ELECTRON_RUN_AS_NODE), asar-хук рантайма портит запись app.asar
  // («Invalid package»). Поэтому сначала ищем установленный Node.js.
  const realNode = 'C:\\Program Files\\nodejs\\node.exe';
  if (isWin && fs.existsSync(realNode)) {
    run('Упаковка NSIS-установщика (electron-builder → release/)', realNode, ['build-installer.cjs'], path.join(root, 'desktop'));
  } else {
    run('Упаковка NSIS-установщика (electron-builder → release/)', npm, ['run', 'dist'], path.join(root, 'desktop'));
  }
}

function withInstaller() {
  return process.argv.includes('--installer');
}

console.log(`
═══ Готово ═══
Запуск:        npm start          (сервер на :9345, раздаёт и клиент)
Разработка:    npm run dev:server  +  npm run dev:app  (два терминала)
Смоук-тест:    WT_ROOM=<id> npm run smoke
Установщик:    node build.mjs --installer   (результат в release/)
`);
