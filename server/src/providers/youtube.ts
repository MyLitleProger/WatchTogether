// YouTube: поиск через yt-dlp (если бинарь доступен), иначе — ссылка на выдачу YouTube.
// Воспроизведение на клиенте — через IFrame Player API (kind: 'youtube'), наш оверлей сверху.
import { execFile } from 'node:child_process';
import type { SearchResult } from './index.js';

function runYtDlp(args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
}

export async function searchYouTube(query: string): Promise<SearchResult[]> {
  try {
    const out = await runYtDlp([`ytsearch10:${query}`, '--dump-json', '--flat-playlist', '--no-warnings']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const j = JSON.parse(line);
          return {
            provider: 'youtube',
            title: j.title ?? 'Без названия',
            url: j.url?.startsWith('http') ? j.url : `https://www.youtube.com/watch?v=${j.id}`,
            thumbnail: j.thumbnail,
            subtitle: j.channel ?? j.uploader ?? undefined,
          } as SearchResult;
        } catch {
          return null;
        }
      })
      .filter((r): r is SearchResult => !!r);
  } catch {
    // yt-dlp не установлен — возвращаем «мягкий» результат: открыть поиск на YouTube.
    return [{
      provider: 'youtube',
      title: `Искать «${query}» на YouTube`,
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      subtitle: 'yt-dlp не найден: установите его для поиска без браузера',
    }];
  }
}

// Извлечь ID видео из URL YouTube (watch, youtu.be, shorts, embed).
export function extractYouTubeId(url: string): string | null {
  const m =
    url.match(/[?&]v=([\w-]{11})/) ||
    url.match(/youtu\.be\/([\w-]{11})/) ||
    url.match(/(?:embed|shorts)\/([\w-]{11})/);
  return m ? m[1] : null;
}
