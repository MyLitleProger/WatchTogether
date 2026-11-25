// LAN-discovery: UDP-broadcast. Сервер отвечает на WATCHTOGETHER_DISCOVER,
// а клиенты (через /api/discover у своего сервера или напрямую из Electron) находят хостов.
// В браузере UDP недоступен, поэтому эндпоинт /api/discover делает broadcast с сервера,
// когда хостов несколько (например, «найти другие устройства» из UI хоста).
import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import { APP_VERSION } from './version.js';

export const DISCOVERY_PORT = 9346;
const MAGIC = 'WATCHTOGETHER_DISCOVER';
const REPLY = 'WATCHTOGETHER_HERE';

// Уникальный id этого запуска сервера — чтобы фильтровать «самого себя»
// в списке найденных устройств (раньше фильтр по адресу не срабатывал,
// когда ответ приходил с виртуального адаптера WSL/Hyper-V).
export const INSTANCE_ID = crypto.randomUUID();

// LAN-адреса этой машины (IPv4, без loopback) — для ссылок-приглашений и discovery.
// Сначала отбрасываем виртуальные адаптеры по имени интерфейса (WSL/Hyper-V/
// Docker/VMware/VirtualBox): они тоже имеют «домашние» адреса, но гостям
// недоступны. Оставшиеся сортируем: 192.168.x и 10.x впереди, 172.x в конце.
const VIRTUAL_IFACE = /vethernet|vmware|virtualbox|hyper-v|docker|wsl|loopback|pseudo|teredo|isatap/i;

export function localAddresses(): string[] {
  const rank = (ip: string) =>
    ip.startsWith('192.168.') ? 0
      : ip.startsWith('10.') || ip.startsWith('25.') ? 1 // 25.x — Hamachi
        : ip.startsWith('172.') ? 3
          : 2;
  const entries = Object.entries(os.networkInterfaces())
    .filter(([name]) => !VIRTUAL_IFACE.test(name));
  const real = entries
    .flatMap(([, list]) => list ?? [])
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  const fallback = Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  return (real.length > 0 ? real : fallback).sort((x, y) => rank(x) - rank(y));
}

// Имя устройства в сети — чтобы в списке было видно, чей это хост.
export function deviceName(): string {
  return os.hostname();
}

export interface DiscoveryReply {
  id: string;
  name: string;
  version: string;
  httpPort: number;
  addresses: string[];
}

// Пассивная часть: отвечаем на запросы в локальной сети.
export function startDiscoveryResponder(httpPort: number, addresses: string[]) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', () => sock.close());
  sock.bind(DISCOVERY_PORT, () => {
    sock.on('message', (msg, rinfo) => {
      if (msg.toString() !== MAGIC) return;
      const reply: DiscoveryReply = { id: INSTANCE_ID, name: deviceName(), version: APP_VERSION, httpPort, addresses };
      sock.send(JSON.stringify(reply), rinfo.port, rinfo.address);
    });
  });
  return sock;
}

// Активная часть: шлём broadcast и собираем ответы ~1.5 с.
// 255.255.255.255 после установки VPN-клиентов часто уходит только в
// туннельный адаптер, и соседи по LAN его не видят. Поэтому шлём ещё и
// directed broadcast каждого интерфейса (192.168.0.255 и т.п.) — 2 раунда.
function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (!a || a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = (a.netmask ?? '').split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      out.add(ip.map((o, i) => (o | (~mask[i] & 255))).join('.'));
    }
  }
  return [...out];
}

export function discoverPeers(timeoutMs = 1500): Promise<(DiscoveryReply & { from: string })[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveryReply & { from: string }>();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => { sock.close(); resolve([]); });
    sock.bind(() => {
      sock.setBroadcast(true);
      const targets = broadcastAddresses();
      const burst = () => { for (const t of targets) sock.send(MAGIC, DISCOVERY_PORT, t, () => {}); };
      sock.send(MAGIC, DISCOVERY_PORT, '255.255.255.255');
      setTimeout(burst, 50);
      setTimeout(burst, 600);
    });
    sock.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString()) as DiscoveryReply;
        // Старые серверы без id — не фильтруем, просто показываем.
        found.set(`${data.id ?? rinfo.address}:${data.httpPort}`, { ...data, from: rinfo.address });
      } catch { /* не наш пакет */ }
    });
    setTimeout(() => {
      try { sock.close(); } catch { /* уже закрыт */ }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}
