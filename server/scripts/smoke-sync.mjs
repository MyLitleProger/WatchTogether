// Сквозная проверка v0.2: синхронизация, чат, пароли комнат.
// Запуск: WT_ROOM=<id> node server/scripts/smoke-sync.mjs  (node из любого места; скрипт сам найдёт зависимости)
import { io } from '../../app/node_modules/socket.io-client/build/esm/index.js';

const BASE = process.env.WT_BASE ?? 'http://localhost:9345';

const mk = () => io(BASE, { transports: ['websocket'] });
const join = (s, payload) =>
  new Promise((res) => s.emit('room:join', payload, res));
const once = (s, ev, timeout = 3000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${ev}`)), timeout);
    s.once(ev, (p) => { clearTimeout(t); res(p); });
  });

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`); if (!ok) failed++; };

// --- комната без пароля ---
const r1 = await fetch(`${BASE}/api/rooms`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Smoke v0.2', controlMode: 'all', hostClientId: 'a' }),
}).then((r) => r.json());

const a = mk(), b = mk();
await Promise.all([once(a, 'connect'), once(b, 'connect')]);
const ja = await join(a, { roomId: r1.id, clientId: 'a', nickname: 'Алиса' });
const jb = await join(b, { roomId: r1.id, clientId: 'b', nickname: 'Борис' });
check('join без пароля', ja.ok && jb.ok);

// чат: история пустая, затем сообщение от A доходит до B и сохраняется
check('история чата пуста при создании', Array.isArray(jb.chat) && jb.chat.length === 0);
const msgWait = once(b, 'chat:message');
a.emit('chat:message', { text: 'Привет из смоук-теста!' });
const msg = await msgWait;
check('chat:message дошло', msg.text === 'Привет из смоук-теста!' && msg.nickname === 'Алиса');

// переподключение → история в ack
const c = mk();
await once(c, 'connect');
const jc = await join(c, { roomId: r1.id, clientId: 'c', nickname: 'Вера' });
check('история чата в join', jc.ok && jc.chat.length >= 1);

// sync по-прежнему работает
const p = once(b, 'sync:state');
a.emit('sync:play', { positionSec: 10 });
const ps = await p;
// Позиция отдаётся «сырой» + возраст: точное значение + возраст в допустимых пределах.
check('sync:play', ps.state === 'playing' && ps.positionSec === 10
  && typeof ps.positionAgeMs === 'number' && ps.positionAgeMs >= 0 && ps.positionAgeMs < 5000);

// голосовая комната: список участников и адресный сигналинг
a.emit('voice:join');
const vp1 = await once(b, 'voice:peers');
check('voice:join первого виден', vp1.peers.length === 1 && vp1.peers[0].clientId === 'a');
b.emit('voice:join');
const vp2 = await once(a, 'voice:peers');
check('voice:peers оба участника', vp2.peers.length === 2);
const sigWait = once(b, 'voice:signal');
a.emit('voice:signal', { to: 'b', data: { description: { type: 'offer', sdp: 'x' } } });
const sig = await sigWait;
check('voice:signal дошёл адресно', sig.from === 'a' && sig.data.description.type === 'offer');
const vp3 = once(a, 'voice:peers');
b.emit('voice:leave');
const afterLeave = await vp3;
check('voice:leave убрал из списка', afterLeave.peers.length === 1 && afterLeave.peers[0].clientId === 'a');

// трансляция сайта: старт ведущего, ретрансляция сигналинга, гейтинг ввода
const st1 = once(b, 'stream:state');
const sv1 = once(b, 'sync:state');
a.emit('stream:start', { url: 'https://example.com/video', playerOnly: true });
const streamState = await st1;
const syncVideo = await sv1;
check('stream:start активна', streamState.active === true && streamState.hostClientId === 'a' && streamState.playerOnly === true);
check('stream: video в sync:state', syncVideo.video?.kind === 'stream' && syncVideo.video?.url === 'https://example.com/video');
const w1 = once(a, 'stream:watch');
b.emit('stream:watch');
check('stream:watch дошёл ведущему', (await w1).from === 'b');
const sg1 = once(a, 'stream:signal');
b.emit('stream:signal', { to: 'a', data: { candidate: { candidate: 'x' } } });
check('stream:signal зритель→ведущий', (await sg1).from === 'b');
let inputCame = false;
a.on('stream:input', () => { inputCame = true; });
b.emit('stream:input', { kind: 'click', x: 0.5, y: 0.5 });
await new Promise((r) => setTimeout(r, 300));
check('stream:input без разрешения отброшен', inputCame === false);
const sc1 = once(b, 'stream:state');
a.emit('stream:control', { allow: true });
check('stream:control включил управление', (await sc1).allowControl === true);
b.emit('stream:input', { kind: 'click', x: 0.5, y: 0.5 });
await new Promise((r) => setTimeout(r, 300));
check('stream:input с разрешением дошёл', inputCame === true);
const st2 = once(b, 'stream:state');
a.emit('stream:stop');
check('stream:stop', (await st2).active === false);

a.close(); b.close(); c.close();

// --- комната с паролем ---
const r2 = await fetch(`${BASE}/api/rooms`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Секретная', controlMode: 'host', hostClientId: 'h', password: '1234' }),
}).then((r) => r.json());

const d = mk();
await once(d, 'connect');
const noPw = await join(d, { roomId: r2.id, clientId: 'd', nickname: 'Дима' });
check('без пароля → NEED_PASSWORD', noPw.error === 'NEED_PASSWORD');
const badPw = await join(d, { roomId: r2.id, clientId: 'd', nickname: 'Дима', password: '0000' });
check('неверный пароль → WRONG_PASSWORD', badPw.error === 'WRONG_PASSWORD');
const okPw = await join(d, { roomId: r2.id, clientId: 'd', nickname: 'Дима', password: '1234' });
check('верный пароль → вход', !!okPw.ok);

// режим «только хост»: d не хост → его play игнорируется
const e = mk();
await once(e, 'connect');
await join(e, { roomId: r2.id, clientId: 'h', nickname: 'Хост' });
let gotState = false;
e.on('sync:state', () => { gotState = true; });
d.emit('sync:play', { positionSec: 5 });
await new Promise((r) => setTimeout(r, 600));
check('не-хост не управляет в режиме host', !gotState);

d.close(); e.close();

// уборка
await fetch(`${BASE}/api/rooms/${r1.id}`, { method: 'DELETE' });
await fetch(`${BASE}/api/rooms/${r2.id}`, { method: 'DELETE' });

console.log(failed === 0 ? '\nВСЕ ПРОВЕРКИ ПРОШЛИ' : `\nПРОВАЛЕНО: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
