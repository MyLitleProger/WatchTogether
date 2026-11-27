// Вход на сайт источника (RuTracker, LostFilm, LordSerial) во встроенном окне
// десктоп-приложения: после закрытия окна куки сессии сохраняются на этом ПК
// (зашифрованно) и дальше поиск/серии идут уже от вашего аккаунта.
import type { ProviderInfo } from '@/lib/api';
import { getDesktop } from '@/lib/desktop';

export function providerLoginUrl(p: ProviderInfo): string | null {
  const mirror = ((p.config.mirrors as string[] | undefined) ?? [])[0];
  const loginPath = p.config.loginPath as string | undefined;
  if (!mirror || !loginPath) return null;
  try {
    return new URL(loginPath, mirror).toString();
  } catch {
    return null;
  }
}

export function canLoginTo(p: ProviderInfo): boolean {
  return !!providerLoginUrl(p);
}

export async function loginToProvider(p: ProviderInfo): Promise<{ ok: boolean; message: string }> {
  const url = providerLoginUrl(p);
  if (!url) return { ok: false, message: 'У этого источника нет страницы входа' };
  const desktop = getDesktop();
  if (!desktop) {
    return {
      ok: false,
      message: 'Вход на сайт работает в приложении WatchTogether на компьютере-хосте: откройте там «Источники» → «Войти».',
    };
  }
  const res = await desktop.openAuth(p.id, url);
  if (!res.opened) {
    return { ok: false, message: res.reason === 'already-open' ? 'Окно входа уже открыто' : 'Окно входа не открылось' };
  }
  return (res.cookiesSaved ?? 0) > 0
    ? { ok: true, message: `Вход в «${p.name}» сохранён` }
    : { ok: false, message: 'Вход не сохранён: в окне не было авторизации на сайте' };
}
