// Идентичность участника: без регистрации — clientId в localStorage + ник.
const KEY_ID = 'wt.clientId';
const KEY_NICK = 'wt.nickname';

// crypto.randomUUID доступен только в secure context (HTTPS или localhost).
// Участники из LAN открывают http://<ip>:9345 — там его нет, делаем свой
// генератор UUID v4 на crypto.getRandomValues (он есть и по http), с
// последним запасным вариантом на Math.random.
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; // версия 4
  b[8] = (b[8] & 0x3f) | 0x80; // вариант RFC 4122
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function getClientId(): string {
  let id = localStorage.getItem(KEY_ID);
  if (!id) {
    id = uuid();
    localStorage.setItem(KEY_ID, id);
  }
  return id;
}

export function getNickname(): string {
  return localStorage.getItem(KEY_NICK) ?? '';
}

export function setNickname(nick: string) {
  localStorage.setItem(KEY_NICK, nick.trim().slice(0, 32));
}
