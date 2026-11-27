#!/usr/bin/env node
// Меняет версию приложения во всех местах сразу:
//   desktop/package.json  — по ней electron-updater решает, есть ли обновление;
//   server/package.json   — версия встроенного сервера;
//   server/src/version.ts — версия в шапке приложения и в /api/server-info.
//
// Использование:  npm run set-version -- 0.9.3
// Проверка (для CI):  node scripts/set-version.mjs --check 0.9.3
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const version = args.find((a) => !a.startsWith('--'))?.replace(/^v/, '');

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Укажите версию вида 0.9.3:  npm run set-version -- 0.9.3');
  process.exit(1);
}

const files = [
  {
    file: 'desktop/package.json',
    read: (s) => JSON.parse(s).version,
    write: (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
  },
  {
    file: 'server/package.json',
    read: (s) => JSON.parse(s).version,
    write: (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
  },
  {
    file: 'server/src/version.ts',
    read: (s) => /APP_VERSION\s*=\s*'([^']+)'/.exec(s)?.[1],
    write: (s) => s.replace(/(APP_VERSION\s*=\s*')[^']+(')/, `$1${version}$2`),
  },
  // Лок-файлы хранят версию самого пакета — держим их в ногу, чтобы не расходились.
  ...['desktop/package-lock.json', 'server/package-lock.json'].map((file) => ({
    file,
    read: (s) => JSON.parse(s).version,
    write: (s) => {
      const lock = JSON.parse(s);
      lock.version = version;
      if (lock.packages?.['']) lock.packages[''].version = version;
      return JSON.stringify(lock, null, 2) + '\n';
    },
  })),
];

let mismatch = false;
for (const f of files) {
  const p = path.join(root, f.file);
  const text = fs.readFileSync(p, 'utf8');
  const current = f.read(text);
  if (check) {
    const ok = current === version;
    if (!ok) mismatch = true;
    console.log(`${ok ? '✓' : '✗'} ${f.file}: ${current}`);
  } else if (current === version) {
    console.log(`= ${f.file}: уже ${version}`);
  } else {
    fs.writeFileSync(p, f.write(text));
    console.log(`✓ ${f.file}: ${current} → ${version}`);
  }
}

if (check && mismatch) {
  console.error(`\nВерсия в файлах не совпадает с тегом v${version}. Выполните: npm run set-version -- ${version}`);
  process.exit(1);
}
if (!check) {
  console.log(`\nДальше:\n  git commit -am "v${version}"\n  git tag v${version}\n  git push && git push origin v${version}`);
}
