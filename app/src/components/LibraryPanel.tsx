// Медиатека: видеофайлы из папок компьютера-хоста. Папками управляет только сам
// хост (на этом ПК); остальные устройства видят список и смотрят потоком.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type LibraryFile, type LibraryInfo } from '@/lib/api';
import { getDesktop } from '@/lib/desktop';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

function fmtBytes(n: number): string {
  if (!n) return '';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

interface LibraryPanelProps {
  onPlay: (file: LibraryFile) => void;
  onQueue?: (file: LibraryFile) => void;
  playLabel?: string;
}

const SHOW_LIMIT = 200;

export function LibraryPanel({ onPlay, onQueue, playLabel = 'Смотреть' }: LibraryPanelProps) {
  const [info, setInfo] = useState<LibraryInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [manualPath, setManualPath] = useState('');
  const [showFolders, setShowFolders] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api.library()
      .then((i) => { setInfo(i); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Медиатека недоступна'));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  // Пока сервер сканирует папки — обновляем список, файлы появляются по ходу.
  useEffect(() => {
    if (!info?.scanning) return;
    const t = setTimeout(reload, 2000);
    return () => clearTimeout(t);
  }, [info, reload]);

  const addFolder = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.addLibraryFolder(path);
      setManualPath('');
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось добавить папку');
    } finally {
      setBusy(false);
    }
  };

  const pickFolder = async () => {
    const res = await getDesktop()?.pickFolder?.();
    if (res?.ok && res.path) await addFolder(res.path);
  };

  const removeFolder = async (id: number) => {
    await api.removeLibraryFolder(id).catch(() => {});
    reload();
  };

  const rescan = async () => {
    setBusy(true);
    try {
      await api.scanLibrary();
    } catch { /* без прав — просто перечитаем список */ }
    setBusy(false);
    reload();
  };

  const filtered = useMemo(() => {
    const files = info?.files ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return files;
    const words = q.split(/\s+/);
    return files.filter((f) => {
      const hay = `${f.title} ${f.dir} ${f.folder}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [info, query]);

  if (error && !info) {
    return <p className="text-sm text-zinc-500">{error}</p>;
  }
  if (!info) {
    return <p className="text-sm text-zinc-500">Загружаем медиатеку…</p>;
  }

  const canPick = info.canManage && !!getDesktop()?.pickFolder;
  const empty = info.files.length === 0;

  return (
    <div className="flex flex-col gap-3">
      {/* поиск по медиатеке + обновить */}
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={empty ? 'В медиатеке пока нет файлов' : `Поиск среди ${info.files.length} файлов…`}
          aria-label="Поиск в медиатеке"
          disabled={empty}
        />
        <Button variant="outline" onClick={rescan} disabled={busy || info.scanning} title="Пересканировать папки">
          {info.scanning ? 'Сканируем…' : 'Обновить'}
        </Button>
        {info.canManage && (
          <Button variant="outline" onClick={() => setShowFolders((s) => !s)} aria-expanded={showFolders}>
            Папки{info.folders.length ? ` (${info.folders.length})` : ''}
          </Button>
        )}
      </div>

      {/* управление папками — только на компьютере-хосте */}
      {info.canManage && (showFolders || info.folders.length === 0) && (
        <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
          {info.folders.length === 0 && (
            <p className="text-sm text-zinc-300">
              Добавьте папки с фильмами и сериалами — их увидят все устройства дома и гости ваших комнат.
              Папку загрузок торрент-клиента тоже можно: новые файлы подхватятся сами.
            </p>
          )}
          {info.folders.map((f) => (
            <div key={f.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300" title={f.path}>{f.path}</span>
              <span className="shrink-0 text-xs text-zinc-500">{f.files ?? 0} файл.</span>
              <Button size="sm" variant="ghost" onClick={() => removeFolder(f.id)} aria-label={`Убрать папку ${f.path}`}>
                Убрать
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {canPick && (
              <Button size="sm" onClick={pickFolder} disabled={busy}>Добавить папку…</Button>
            )}
            <div className="flex min-w-60 flex-1 gap-2">
              <Input
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && manualPath.trim() && addFolder(manualPath.trim())}
                placeholder={canPick ? 'или путь вручную: D:\\Фильмы' : 'Путь к папке, напр. D:\\Фильмы'}
                aria-label="Путь к папке"
                className="h-8 text-xs"
              />
              <Button size="sm" variant="outline" onClick={() => addFolder(manualPath.trim())} disabled={busy || !manualPath.trim()}>
                Добавить
              </Button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {empty && !info.canManage && (
        <p className="text-sm text-zinc-500">
          {info.folders.length === 0
            ? 'Хост ещё не добавил папки с видео. Это делается в WatchTogether на его компьютере.'
            : 'В папках медиатеки пока нет видеофайлов.'}
        </p>
      )}
      {empty && info.canManage && info.folders.length > 0 && !info.scanning && (
        <p className="text-sm text-zinc-500">В выбранных папках не нашлось видео (mp4, mkv, webm, avi…).</p>
      )}

      {!empty && filtered.length === 0 && (
        <p className="text-sm text-zinc-500">Ничего не найдено по запросу «{query}».</p>
      )}

      <ul className="flex flex-col gap-1">
        {filtered.slice(0, SHOW_LIMIT).map((f) => (
          <li key={f.id} className="flex items-stretch gap-1">
            <button
              type="button"
              onClick={() => f.playable && onPlay(f)}
              disabled={!f.playable}
              title={f.playable ? `${playLabel}: ${f.name}` : 'Этот формат не играет в браузере — нужен mp4, mkv или webm'}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-zinc-800/70 focus-visible:outline-2 focus-visible:outline-amber-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-zinc-400">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5.5v13l11-6.5-11-6.5z"/></svg>
              </div>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-zinc-100">{f.title}</span>
                <span className="block truncate text-xs text-zinc-500">
                  {[f.folder, f.dir].filter(Boolean).join(' / ')}
                  {' · '}{fmtBytes(f.size)}{' · '}{f.ext.toUpperCase()}
                  {!f.playable && ' · формат не поддерживается'}
                </span>
              </span>
            </button>
            {onQueue && f.playable && (
              <button
                type="button"
                onClick={() => onQueue(f)}
                title="Добавить в очередь"
                aria-label={`Добавить в очередь: ${f.title}`}
                className="cursor-pointer rounded-lg border border-zinc-700 px-2.5 text-lg text-zinc-300 transition-colors hover:border-amber-500/60 hover:text-amber-300"
              >
                +
              </button>
            )}
          </li>
        ))}
      </ul>
      {filtered.length > SHOW_LIMIT && (
        <p className="text-xs text-zinc-500">Показаны первые {SHOW_LIMIT} из {filtered.length} — уточните поиск.</p>
      )}
    </div>
  );
}
