// Плагинная система провайдеров контента.
import { listProviders, type ProviderRow } from '../db.js';
import { searchYouTube } from './youtube.js';
import { searchLostFilm } from './lostfilm.js';
import { searchLordSerial } from './lordserial.js';
import { searchRutube } from './rutube.js';
import { searchCustom } from './custom.js';
import { searchRuTracker, ProviderError } from './rutracker.js';

export interface SearchResult {
  provider: string;
  title: string;
  url: string;             // страница/видео
  thumbnail?: string;
  subtitle?: string;       // «Сериал · 7 сезонов», длительность и т.п.
}

export interface WatchSource {
  kind: 'direct' | 'youtube' | 'embed';
  url: string;
  title?: string;
  provider?: string;
}

export interface Provider {
  id: string;
  search(query: string, config: Record<string, unknown>): Promise<SearchResult[]>;
}

const registry: Record<ProviderRow['type'], Provider['search']> = {
  youtube: searchYouTube,
  lostfilm: searchLostFilm,
  lordserial: searchLordSerial,
  rutube: searchRutube,
  rutracker: searchRuTracker,
  custom: searchCustom,
};

export interface ProviderSearchError {
  provider: string;
  code: 'NEED_LOGIN' | 'UNAVAILABLE' | 'ERROR';
  message: string;
}

// Поиск сразу по нескольким провайдерам; ошибка одного не роняет остальные,
// но возвращается отдельно — клиент покажет «войдите» или «источник недоступен».
export async function searchProviders(
  query: string,
  onlyIds?: string[],
): Promise<{ results: SearchResult[]; errors: ProviderSearchError[] }> {
  const rows = listProviders().filter(
    (p) => p.enabled && (!onlyIds || onlyIds.includes(p.id))
  );
  const settled = await Promise.allSettled(
    rows.map(async (p) => {
      const fn = registry[p.type];
      if (!fn) return [];
      const results = await fn(query, JSON.parse(p.config_json));
      return results.map((r) => ({ ...r, provider: r.provider || p.id }));
    })
  );
  const errors: ProviderSearchError[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') return;
    const e = s.reason;
    errors.push({
      provider: rows[i].id,
      code: e instanceof ProviderError ? e.code : 'ERROR',
      message: e instanceof Error ? e.message.slice(0, 300) : String(e),
    });
  });
  return { results: settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : [])), errors };
}
