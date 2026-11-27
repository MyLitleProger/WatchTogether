// Шифрование секретов в БД (куки сайтов-провайдеров): AES-256-GCM.
// Ключ приходит от Electron в WT_SECRET_KEY (base64, 32 байта); сам ключ
// хранится на диске зашифрованным через safeStorage (DPAPI в Windows),
// так что копия watchtogether.db без профиля пользователя Windows бесполезна.
// Без ключа (npm start без Electron) значения хранятся как раньше — открытым текстом.
import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';

function loadKey(): Buffer | null {
  const raw = process.env.WT_SECRET_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    console.warn('[secretbox] WT_SECRET_KEY должен быть 32 байта в base64 — шифрование отключено');
    return null;
  }
  return key;
}

const KEY = loadKey();

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  if (!KEY || !plain || isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, data]).toString('base64');
}

// Возвращает null, если расшифровать нельзя (нет ключа, ключ сменился, данные битые).
export function decryptSecret(value: string): string | null {
  if (!isEncrypted(value)) return value; // старое значение открытым текстом
  if (!KEY) return null;
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const secretEncryptionEnabled = !!KEY;
