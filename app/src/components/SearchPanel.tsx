// Панель поиска по провайдерам (YouTube, Rutube, LostFilm, LordSerial, RuTracker, свои сайты).
// Ошибки источников показываются отдельно: «нужно войти» — с кнопкой входа.
// RuTracker отдаёт торрент-раздачи: они уходят в торрент-клиент, а скачанные
// файлы появляются в медиатеке.
import { useEffect, useState } from 'react';
import { api, type ProviderInfo, type ProviderSearchError, type SearchResult } from '@/lib/api';
import { getDesktop } from '@/lib/desktop';
import { canLoginTo, loginToProvider } from '@/lib/providerLogin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface SearchPanelProps {
  onPick: (result: SearchResult) => void;
  // «В очередь» — добавить результат в очередь просмотра, не включая сразу.
  onQueue?: (result: SearchResult) => void;
}

export function SearchPanel({ onPick, onQueue }: SearchPanelProps) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [providerErrors, setProviderErrors] = useState<ProviderSearchError[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [torrentBusy, setTorrentBusy] = useState<string | null>(null);

  useEffect(() => {
    api.listProviders().then((list) => {
      const enabled = list.filter((p) => p.enabled);
      setProviders(enabled);
      setSelected(new Set(enabled.map((p) => p.id)));
    }).catch(() => setProviders([]));
  }, []);

  const providerById = (id: string) => providers.find((p) => p.id === id);
  const isTorrent = (r: SearchResult) => providerById(r.provider)?.type === 'rutracker';

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const doSearch = async () => {
    const q = query.trim();
    if (!q || selected.size === 0) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    setSearched(true);
    try {
      const { results, errors } = await api.search(q, [...selected]);
      setResults(results);
      setProviderErrors(errors ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка поиска');
      setResults([]);
      setProviderErrors([]);
    } finally {
      setLoading(false);
    }
  };

  const login = async (providerId: string) => {
    const p = providerById(providerId);
    if (!p) return;
    const res = await loginToProvider(p);
    setNotice(res.message);
    if (res.ok) void doSearch(); // сразу повторяем поиск уже со входом
  };

  // Раздача RuTracker → magnet → торрент-клиент (в десктопе — через приложение,
  // в браузере — обычной ссылкой magnet:, её откроет установленный клиент).
  const openTorrent = async (r: SearchResult) => {
    setTorrentBusy(r.url);
    setNotice(null);
    try {
      const { magnet, title } = await api.rutrackerTopic(r.url);
      const desktop = getDesktop();
      if (desktop?.openMagnet) {
        const res = await desktop.openMagnet(magnet, title || r.title);
        if (!res.ok) {
          setNotice(res.error === 'no-client'
            ? 'Не найден торрент-клиент. Установите, например, qBittorrent и повторите.'
            : 'Раздача не открыта');
          return;
        }
      } else {
        window.location.href = magnet;
      }
      setNotice('Раздача открыта в торрент-клиенте. Когда файлы скачаются в папку медиатеки, они появятся во вкладке «Медиатека».');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Не удалось получить раздачу');
    } finally {
      setTorrentBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
          placeholder="Название фильма или сериала…"
          aria-label="Поиск по источникам"
        />
        <Button onClick={doSearch} disabled={loading || selected.size === 0 || !query.trim()}>
          {loading ? 'Ищем…' : 'Найти'}
        </Button>
      </div>

      {providers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => toggle(p.id)}
              aria-pressed={selected.has(p.id)}
              className={`cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors ${
                selected.has(p.id)
                  ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      {/* ошибки отдельных источников: остальные результаты при этом показываются */}
      {providerErrors.map((pe) => {
        const p = providerById(pe.provider);
        return (
          <div key={pe.provider} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
            <p className="min-w-0 flex-1 text-xs text-zinc-400">
              <span className="font-medium text-zinc-200">{p?.name ?? pe.provider}:</span> {pe.message}
            </p>
            {pe.code === 'NEED_LOGIN' && p && canLoginTo(p) && (
              <Button size="sm" variant="outline" onClick={() => login(pe.provider)}>Войти</Button>
            )}
          </div>
        );
      })}

      {notice && <p className="text-sm text-amber-300">{notice}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {searched && !loading && !error && results.length === 0 && providerErrors.length === 0 && (
        <p className="text-sm text-zinc-500">Ничего не найдено. Попробуйте другой запрос или источник.</p>
      )}

      <ul className="flex flex-col gap-1">
        {results.map((r, i) => {
          const torrent = isTorrent(r);
          return (
            <li key={`${r.provider}-${i}`} className="flex items-stretch gap-1">
              <button
                type="button"
                onClick={() => (torrent ? openTorrent(r) : onPick(r))}
                disabled={torrentBusy === r.url}
                title={torrent ? 'Скачать через торрент-клиент' : undefined}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-zinc-800/70 focus-visible:outline-2 focus-visible:outline-amber-500 disabled:cursor-wait disabled:opacity-60"
              >
                {r.thumbnail ? (
                  <img src={r.thumbnail} alt="" className="h-12 w-20 shrink-0 rounded object-cover" loading="lazy" />
                ) : (
                  <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded bg-zinc-800 text-zinc-500">
                    {torrent ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" />
                      </svg>
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5.5v13l11-6.5-11-6.5z"/></svg>
                    )}
                  </div>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm text-zinc-100">{r.title}</span>
                  {r.subtitle && <span className="block truncate text-xs text-zinc-500">{r.subtitle}</span>}
                  <span className="text-xs text-amber-500/80">
                    {providerById(r.provider)?.name ?? r.provider}
                    {torrent && (torrentBusy === r.url ? ' · получаем раздачу…' : ' · скачать в торрент-клиенте')}
                  </span>
                </span>
              </button>
              {onQueue && !torrent && (
                <button
                  type="button"
                  onClick={() => onQueue(r)}
                  title="Добавить в очередь"
                  aria-label="Добавить в очередь"
                  className="cursor-pointer rounded-lg border border-zinc-700 px-2.5 text-lg text-zinc-300 transition-colors hover:border-amber-500/60 hover:text-amber-300"
                >
                  +
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
