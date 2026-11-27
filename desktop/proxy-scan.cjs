// Поиск прокси в системе — без зависимостей от Electron (проверяется обычным Node).
// 1) Настройки Windows (их же использует браузер): ProxyServer и PAC-скрипт.
// 2) Программы, слушающие порты на 127.0.0.1: каждый порт проверяем — отвечает
//    ли он как SOCKS5 (приветствие 05 01 00) или как HTTP-прокси (CONNECT → 200).
const net = require('node:net');
const { execFile: execFileCb } = require('node:child_process');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFileCb(cmd, args, { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024, encoding: 'latin1' },
      (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

async function windowsProxySettings() {
  const out = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']);
  const val = (name) => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'mi').exec(out)?.[1]?.trim() ?? '';
  const enabled = /^0x1$/i.test(val('ProxyEnable'));
  const server = val('ProxyServer');
  const pac = val('AutoConfigURL');
  return { enabled: enabled && !!server, server: server || null, pac: pac || null };
}

// «127.0.0.1:8080» или «http=127.0.0.1:8080;https=…;socks=…» → правило Chromium.
function windowsServerToRule(server) {
  if (!server) return null;
  if (!server.includes('=')) return /^[\w.\-[\]:]+:\d+$/.test(server) ? `http://${server}` : null;
  const parts = Object.fromEntries(server.split(';').map((p) => p.split('=').map((s) => s.trim())));
  if (parts.https) return `http://${parts.https}`;
  if (parts.http) return `http://${parts.http}`;
  if (parts.socks) return `socks5://${parts.socks}`;
  return null;
}

// Системные службы и наш собственный процесс не трогаем.
const SKIP_PROCESSES = /^(system|idle|svchost|lsass|wininit|services|spoolsv|vmms|smss|csrss|winlogon|memory compression)$/i;

async function listLocalListeners({ ownPids = new Set(), skipPort = 0 } = {}) {
  const [netstat, tasks] = await Promise.all([run('netstat.exe', ['-ano', '-p', 'TCP']), run('tasklist.exe', ['/FO', 'CSV', '/NH'])]);
  const names = new Map();
  for (const line of tasks.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (m) names.set(Number(m[2]), m[1].replace(/\.exe$/i, ''));
  }
  const seen = new Set();
  const out = [];
  for (const line of netstat.split(/\r?\n/)) {
    // Слушающий сокет: удалённый адрес 0.0.0.0:0 (название состояния бывает локализовано).
    const m = /^\s*TCP\s+(127\.0\.0\.1|0\.0\.0\.0):(\d+)\s+0\.0\.0\.0:0\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const port = Number(m[2]);
    const pid = Number(m[3]);
    const name = names.get(pid) ?? '';
    if (pid <= 4 || ownPids.has(pid) || port === skipPort || SKIP_PROCESSES.test(name) || seen.has(port)) continue;
    seen.add(port);
    out.push({ port, pid, process: name });
  }
  return out.slice(0, 150);
}

function probePort(port, payload, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    const done = (result) => { clearTimeout(timer); sock.destroy(); resolve(result); };
    const timer = setTimeout(() => done(buf), timeoutMs);
    sock.once('connect', () => sock.write(payload));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 2 && buf[0] === 5) return done(buf);          // ответ SOCKS5
      if (buf.includes(0x0a)) return done(buf);                        // первая строка HTTP
    });
    sock.once('error', () => done(Buffer.alloc(0)));
    sock.once('close', () => done(buf));
  });
}

async function detectProxy(l) {
  const socks = await probePort(l.port, Buffer.from([0x05, 0x01, 0x00]));
  if (socks.length >= 2 && socks[0] === 0x05) {
    return { ...l, type: 'socks5', auth: socks[1] !== 0x00, rules: `socks5://127.0.0.1:${l.port}` };
  }
  const http = (await probePort(l.port, Buffer.from('CONNECT www.youtube.com:443 HTTP/1.1\r\nHost: www.youtube.com:443\r\n\r\n', 'latin1'), 3000))
    .toString('latin1');
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(http)?.[1];
  if (status === '200' || status === '407') {
    return { ...l, type: 'http', auth: status === '407', rules: `http://127.0.0.1:${l.port}` };
  }
  return null;
}

// Подсказка, что за программа (по имени процесса).
const KNOWN_PROXY_APPS = [
  [/v2rayn|xray|v2ray/i, 'V2Ray / Xray'], [/clash|mihomo/i, 'Clash'], [/sing-?box|hiddify/i, 'Hiddify / sing-box'],
  [/nekoray|nekobox|throne/i, 'NekoRay'], [/^gost$/i, 'GOST'], [/^tor$/i, 'Tor'], [/outline/i, 'Outline'],
  [/amnezia/i, 'AmneziaVPN'], [/happ/i, 'Happ'], [/privoxy/i, 'Privoxy'], [/^ssh$/i, 'SSH-туннель'],
  [/tgwsproxy|telegram/i, 'Прокси Telegram (часто пускает только к Telegram)'], [/psiphon/i, 'Psiphon'],
];


async function scanProxies(opts = {}) {
  const [system, listeners] = await Promise.all([windowsProxySettings(), listLocalListeners(opts)]);
  const results = [];
  for (let i = 0; i < listeners.length; i += 16) {
    const batch = await Promise.all(listeners.slice(i, i + 16).map((l) => detectProxy(l).catch(() => null)));
    results.push(...batch.filter(Boolean));
  }
  const systemRule = system.enabled ? windowsServerToRule(system.server) : null;
  const systemPort = /:(d+)$/.exec(systemRule ?? '')?.[1];
  return {
    ok: true,
    system: { ...system, rules: systemRule },
    found: results.map((r) => ({
      ...r,
      label: KNOWN_PROXY_APPS.find(([re]) => re.test(r.process))?.[1] ?? null,
      isSystem: !!systemPort && String(r.port) === systemPort,
    })),
  };
}

module.exports = { scanProxies, windowsServerToRule };
