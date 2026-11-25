// Пользовательский источник: JSON-конфиг с шаблоном URL и CSS-селекторами.
// Позволяет добавить свой сайт/зеркало из настроек без пересборки приложения.
import * as cheerio from 'cheerio';
import type { SearchResult } from './index.js';

interface CustomConfig {
  baseUrl: string;            // 'https://example.com'
  searchPath: string;         // '/search?q={q}'
  itemSelector: string;       // '.results .item'
  titleSelector?: string;     // '.title'
  linkSelector?: string;      // 'a'
  imageSelector?: string;     // 'img'
}

export async function searchCustom(query: string, raw: Record<string, unknown>): Promise<SearchResult[]> {
  const config = raw as unknown as CustomConfig;
  if (!config.baseUrl || !config.searchPath || !config.itemSelector) return [];
  const url = config.baseUrl.replace(/\/$/, '') + config.searchPath.replace('{q}', encodeURIComponent(query));
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WatchTogether/0.1' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const results: SearchResult[] = [];
  $(config.itemSelector).slice(0, 15).each((_, el) => {
    const $el = $(el);
    const title = (config.titleSelector ? $el.find(config.titleSelector).first().text() : $el.text()).trim();
    const href = $el.find(config.linkSelector ?? 'a').first().attr('href');
    if (!title || !href) return;
    let thumbnail = config.imageSelector ? $el.find(config.imageSelector).first().attr('src') : undefined;
    if (thumbnail) thumbnail = new URL(thumbnail, config.baseUrl).toString();
    results.push({ provider: 'custom', title, url: new URL(href, config.baseUrl).toString(), thumbnail });
  });
  return results;
}
