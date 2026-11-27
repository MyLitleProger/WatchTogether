// HTTPS для локальной сети — ради голосового чата.
// Браузеры (и окна Electron) дают микрофон только «защищённым» страницам: https или
// localhost. По http://192.168.x.x голос не работает нигде, кроме самого хоста.
// Поэтому рядом с http-портом поднимаем https-порт с самоподписанным сертификатом:
// гость один раз подтверждает предупреждение браузера, и микрофон работает.
//
// Устройство: TLS-сервер расшифровывает соединение и прокидывает его как есть на
// http-порт этого же сервера (127.0.0.1). Чтобы сервер не принял такого гостя за
// «интернет-туннель» (тоже приходит с 127.0.0.1), запоминаем: локальный порт
// внутреннего соединения → настоящий адрес устройства.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';
import selfsigned from 'selfsigned';
import { getSetting, setSetting } from './db.js';
import { encryptSecret, decryptSecret } from './secretbox.js';

const realRemote = new Map<number, string>(); // локальный порт → адрес гостя

// Настоящий адрес для соединения, пришедшего через HTTPS-порт (или null).
export function lanHttpsRemote(remotePort: number | undefined): string | null {
  return remotePort ? realRemote.get(remotePort) ?? null : null;
}

let certFingerprint: string | null = null;
let activePort: number | null = null;

// Порт HTTPS, если он реально слушается (иначе null — например, порт занят).
export function lanHttpsPort(): number | null {
  return activePort;
}
export function lanCertFingerprint(): string | null {
  return certFingerprint;
}

function lanIps(): string[] {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

// Сертификат живёт в БД (ключ — зашифрованным, если есть ключ от Electron).
// Пересоздаётся, если у ПК появился новый адрес (другая сеть) или срок подходит к концу.
function loadOrCreateCert(): { key: string; cert: string } {
  const ips = lanIps().sort();
  const storedCert = getSetting('lan_tls_cert');
  const storedKey = getSetting('lan_tls_key');
  const storedIps = getSetting('lan_tls_ips') ?? '';
  if (storedCert && storedKey) {
    const key = decryptSecret(storedKey);
    let valid = false;
    try {
      const x = new crypto.X509Certificate(storedCert);
      valid = new Date(x.validTo).getTime() - Date.now() > 30 * 24 * 3600 * 1000;
    } catch { /* битый — пересоздадим */ }
    const covered = ips.every((ip) => storedIps.split(',').includes(ip));
    if (key && valid && covered) return { key, cert: storedCert };
  }
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'WatchTogether' }, { name: 'organizationName', value: 'WatchTogether LAN' }],
    {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 2, value: os.hostname() },
            { type: 7, ip: '127.0.0.1' },
            ...ips.map((ip) => ({ type: 7, ip })),
          ],
        },
      ],
    },
  );
  setSetting('lan_tls_cert', pems.cert);
  setSetting('lan_tls_key', encryptSecret(pems.private));
  setSetting('lan_tls_ips', ips.join(','));
  return { key: pems.private, cert: pems.cert };
}

export function startLanHttps(httpPort: number, httpsPort: number): number | null {
  let creds: { key: string; cert: string };
  try {
    creds = loadOrCreateCert();
    certFingerprint = new crypto.X509Certificate(creds.cert).fingerprint256;
  } catch (e) {
    console.warn('[https] не удалось подготовить сертификат:', e);
    return null;
  }
  const server = tls.createServer({ key: creds.key, cert: creds.cert }, (client) => {
    const upstream = net.connect({ host: '127.0.0.1', port: httpPort });
    let localPort: number | undefined;
    const cleanup = () => {
      if (localPort) realRemote.delete(localPort);
      client.destroy();
      upstream.destroy();
    };
    upstream.once('connect', () => {
      localPort = upstream.localPort;
      if (localPort) realRemote.set(localPort, client.remoteAddress ?? '');
      client.pipe(upstream).pipe(client);
    });
    client.on('error', cleanup);
    upstream.on('error', cleanup);
    client.on('close', cleanup);
    upstream.on('close', cleanup);
  });
  server.on('tlsClientError', () => { /* гость не принял сертификат — это нормально */ });
  server.on('error', (e) => {
    activePort = null;
    console.warn(`[https] порт ${httpsPort} недоступен:`, (e as Error).message);
  });
  server.listen(httpsPort, '0.0.0.0', () => { activePort = httpsPort; });
  return httpsPort;
}
