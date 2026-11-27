// Меню профиля (клик по имени в правом верхнем углу): смена имени, версия
// и проверка обновлений. Обновления ставит только приложение WatchTogether;
// браузерные гости всегда получают версию с компьютера-хоста.
import { useEffect, useState } from 'react';
import { getDesktop, type UpdateState } from '@/lib/desktop';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ProfileMenuProps {
  nick: string;
  onNickChange: (nick: string) => void;
  serverVersion?: string | null;
}

function fmtChecked(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? `сегодня в ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function ProfileMenu({ nick, onNickChange, serverVersion }: ProfileMenuProps) {
  const desktop = getDesktop();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(nick);
  const [saved, setSaved] = useState(false);
  const [update, setUpdate] = useState<UpdateState | null>(null);

  useEffect(() => {
    if (!desktop?.onUpdate) return;
    desktop.updateStatus?.().then(setUpdate).catch(() => {});
    return desktop.onUpdate((s) => setUpdate((prev) => ({ ...prev, ...s })));
  }, [desktop]);

  // При открытии меню — свежее имя в поле.
  const onOpenChange = (next: boolean) => {
    if (next) { setDraft(nick); setSaved(false); }
    setOpen(next);
  };

  const saveName = () => {
    const v = draft.trim();
    if (!v || v === nick) return;
    onNickChange(v);
    setSaved(true);
  };

  const check = async () => {
    setUpdate((u) => ({ ...(u ?? { version: null }), status: 'checking' }));
    const res = await desktop?.updateCheck().catch(() => ({ ok: false, error: 'Ошибка проверки' }));
    if (res && !res.ok && res.error !== 'dev') {
      setUpdate((u) => ({ ...(u ?? { version: null }), status: 'error', error: res.error }));
    }
    desktop?.updateStatus?.().then(setUpdate).catch(() => {});
  };

  const currentVersion = update?.current ?? serverVersion ?? '';
  const status = update?.status ?? 'idle';

  let updateLine: string;
  if (!desktop) updateLine = 'Обновления ставятся в приложении на компьютере-хосте — эта страница всегда той же версии.';
  else if (update && update.packaged === false) updateLine = 'Режим разработки: автообновления выключены.';
  else if (status === 'checking') updateLine = 'Проверяем…';
  else if (status === 'latest') updateLine = `Установлена последняя версия. Проверено ${fmtChecked(update?.checkedAt)}.`;
  else if (status === 'downloading') updateLine = `Скачиваем версию ${update?.version ?? ''}${update?.percent ? ` — ${update.percent}%` : '…'}`;
  else if (status === 'ready') updateLine = `Версия ${update?.version} скачана и готова к установке.`;
  else if (status === 'error') updateLine = `Не удалось проверить: ${update?.error ?? 'нет связи с GitHub'}`;
  else updateLine = 'Приложение само проверяет обновления при запуске и раз в 4 часа.';

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex cursor-pointer items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 py-1 pl-1 pr-3 text-sm text-zinc-200 transition-colors hover:border-zinc-600 focus-visible:outline-2 focus-visible:outline-amber-500"
          aria-label={`Профиль: ${nick}`}
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-500/20 text-xs font-semibold uppercase text-amber-300">
            {nick.trim().slice(0, 1)}
          </span>
          {nick}
          {status === 'ready' && <span className="h-2 w-2 rounded-full bg-emerald-400" aria-label="Есть обновление" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 border-zinc-800 bg-zinc-900 p-0 text-zinc-200">
        <div className="flex flex-col gap-2 border-b border-zinc-800 p-4">
          <label htmlFor="profile-name" className="text-xs text-zinc-400">Ваше имя в комнатах и чате</label>
          <div className="flex gap-2">
            <Input
              id="profile-name" value={draft} maxLength={32}
              onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
              onKeyDown={(e) => e.key === 'Enter' && saveName()}
              className="h-8"
            />
            <Button size="sm" onClick={saveName} disabled={!draft.trim() || draft.trim() === nick}>Сохранить</Button>
          </div>
          {saved && <p className="text-xs text-emerald-300">Имя сохранено — в открытых комнатах обновится при следующем входе.</p>}
        </div>

        <div className="flex flex-col gap-2 p-4">
          <p className="flex items-center justify-between text-xs text-zinc-400">
            <span>Обновления</span>
            {currentVersion && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">v{currentVersion}</span>}
          </p>
          <p className={`text-sm ${status === 'error' ? 'text-red-300' : status === 'ready' || status === 'latest' ? 'text-emerald-300' : 'text-zinc-300'}`}>
            {updateLine}
          </p>
          {desktop && update?.packaged !== false && (
            status === 'ready' ? (
              <Button size="sm" onClick={() => { void desktop.updateInstall(); }}>Обновить и перезапустить</Button>
            ) : (
              <Button size="sm" variant="outline" onClick={check} disabled={status === 'checking' || status === 'downloading'}>
                {status === 'checking' ? 'Проверяем…' : 'Проверить обновления'}
              </Button>
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
