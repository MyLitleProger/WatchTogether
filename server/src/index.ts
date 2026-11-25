// Точка входа: Fastify (REST + статика клиента) + Socket.IO + LAN-discovery.
// Слушает 0.0.0.0 — доступен всем устройствам в сети (LAN или туннель Hamachi/ZeroTier).
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seedProviders } from './db.js';
import { registerRoutes } from './rooms.js';
import { setupSync } from './sync.js';
import { startDiscoveryResponder, discoverPeers, localAddresses } from './discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WT_PORT ?? 9345);
const HOST = '0.0.0.0';
// Собранный фронтенд раздаём как статику: друзья открывают http://<ip>:9345 в браузере.
const CLIENT_DIST = process.env.WT_CLIENT_DIST ?? path.resolve(__dirname, '..', '..', 'app', 'dist');

async function main() {
  seedProviders();

  const app = Fastify({ logger: false });

  // Клиент может ходить на чужой сервер со своего origin (предпроверка
  // «Подключиться» на главной) — разрешаем CORS на чтение API. Сервер и так
  // открыт в LAN, дополнительной поверхности атаки это не создаёт.
  app.addHook('onSend', (_req, reply, _payload, done) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    done();
  });
  app.options('/*', async (_req, reply) => reply.code(204).send());

  await registerRoutes(app);

  // Активный поиск других хостов в LAN (из UI «найти устройства»).
  app.get('/api/discover', async () => ({ peers: await discoverPeers() }));

  if (fs.existsSync(CLIENT_DIST)) {
    await app.register(fastifyStatic, { root: CLIENT_DIST });
    // SPA-fallback: все не-API пути → index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/') || req.raw.url?.startsWith('/socket.io/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({
      hint: 'Клиент ещё не собран: cd app && npm run build — или запустите dev-сервер Vite.',
    }));
  }

  await app.listen({ port: PORT, host: HOST });
  setupSync(app.server);
  startDiscoveryResponder(PORT, localAddresses());

  const addrs = localAddresses();
  console.log(`\n  WatchTogether v0.1 запущен`);
  console.log(`  Локально:  http://localhost:${PORT}`);
  for (const a of addrs) console.log(`  В сети:    http://${a}:${PORT}`);
  console.log(`\n  Друзья в LAN или туннеле (Hamachi/ZeroTier) открывают адрес «В сети».\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
