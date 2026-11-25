// Панель поиска по провайдерам (YouTube, LostFilm-зеркала, пользовательские).
import { useEffect, useState } from 'react';
import { api, type ProviderInfo, type SearchResult } from '@/lib/api';
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
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listProviders().then((list) => {
      const enabled = list.filter((p) => p.enabled);
      setProviders(enabled);
      setSelected(new Set(enabled.map((p) => p.id)));
    }).catch(() => setProviders([]));
  }, []);

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
    setSearched(true);
    try {
      const { results } = await api.search(q, [...selected]);
      setResults(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка поиска');
      setResults([]);
    } finally {
      setLoading(false);
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

      {error && <p className="text-sm text-red-400">{error}</p>}
      {searched && !loading && !error && results.length === 0 && (
        <p className="text-sm text-zinc-500">Ничего не найдено. Попробуйте другой запрос или источник.</p>
      )}

      <ul className="flex flex-col gap-1">
        {results.map((r, i) => (
          <li key={`${r.provider}-${i}`} className="flex items-stretch gap-1">
            <button
              type="button"
              onClick={() => onPick(r)}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-zinc-800/70 focus-visible:outline-2 focus-visible:outline-amber-500"
            >
              {r.thumbnail ? (
                <img src={r.thumbnail} alt="" className="h-12 w-20 shrink-0 rounded object-cover" loading="lazy" />
              ) : (
                <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded bg-zinc-800 text-zinc-600">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5.5v13l11-6.5-11-6.5z"/></svg>
                </div>
              )}
              <span className="min-w-0">
                <span className="block truncate text-sm text-zinc-100">{r.title}</span>
                {r.subtitle && <span className="block truncate text-xs text-zinc-500">{r.subtitle}</span>}
                <span className="text-xs text-amber-500/80">{r.provider}</span>
              </span>
            </button>
            {onQueue && (
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
        ))}
      </ul>
    </div>
  );
}
