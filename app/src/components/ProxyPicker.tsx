// Выбор, как окно трансляции выходит в интернет: как Windows/браузер (по умолчанию),
// напрямую, через найденный в системе прокси или свой адрес. Найденные варианты
// сразу проверяются: открывается ли через них YouTube и за сколько.
import { useCallback, useEffect, useState } from 'react';
import { getDesktop, type ProxyScanResult } from '@/lib/desktop';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ProxyPickerProps {
  value: string; // 'system' | 'direct' | 'socks5://…'
  onChange: (value: string) => void;
}

type TestResult = { state: 'testing' } | { state: 'ok'; ms: number } | { state: 'fail'; error: string };

const PROXY_RE = /^(socks5|socks4|socks|http|https):\/\/[a-z0-9.\-[\]:]+:\d{1,5}$/i;

export function ProxyPicker({ value, onChange }: ProxyPickerProps) {
  const desktop = getDesktop();
  const [scan, setScan] = useState<ProxyScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [custom, setCustom] = useState(() => (PROXY_RE.test(value) ? value : ''));

  const runTest = useCallback(async (rules: string) => {
    if (!desktop?.proxyTest) return;
    setTests((t) => ({ ...t, [rules]: { state: 'testing' } }));
    const res = await desktop.proxyTest(rules).catch(() => ({ ok: false, error: 'Ошибка проверки' } as const));
    setTests((t) => ({
      ...t,
      [rules]: res.ok ? { state: 'ok', ms: res.ms ?? 0 } : { state: 'fail', error: res.error ?? 'Не работает' },
    }));
  }, [desktop]);

  const doScan = useCallback(async () => {
    if (!desktop?.proxyScan) return;
    setScanning(true);
    try {
      const res = await desktop.proxyScan();
      setScan(res);
      if (res.ok) {
        // Сразу проверяем все варианты параллельно — пользователь видит, какой работает.
        const all = ['system', 'direct', ...res.found.filter((f) => !f.auth).map((f) => f.rules)];
        await Promise.all(all.map((r) => runTest(r)));
      }
    } finally {
      setScanning(false);
    }
  }, [desktop, runTest]);

  useEffect(() => { void doScan(); }, [doScan]);

  if (!desktop) return null;

  const forbidden = scan && !scan.ok;
  const system = scan?.system;
  const systemDetail = !system
    ? 'проверяем настройки Windows…'
    : system.enabled && system.server
      ? `сейчас через ${system.server}`
      : system.pac
        ? 'по PAC-скрипту Windows'
        : 'в Windows прокси не задан — значит напрямую';

  const select = (v: string) => {
    onChange(v);
    void desktop.setProxy(v); // сразу — и для уже идущей трансляции
  };

  const testChip = (rules: string) => {
    const t = tests[rules];
    if (!t) return null;
    if (t.state === 'testing') return <span className="shrink-0 text-xs text-zinc-500">проверяем…</span>;
    if (t.state === 'ok') return <span className="shrink-0 text-xs text-emerald-300">✓ YouTube · {t.ms} мс</span>;
    return <span className="shrink-0 truncate text-xs text-red-400" title={t.error}>✗ {t.error}</span>;
  };

  const option = ({ id, title, detail, badge, disabled }: {
    id: string; title: string; detail?: string; badge?: string; disabled?: boolean;
  }) => {
    const checked = value === id || (id === 'system' && !value);
    return (
      <label
        key={id}
        className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
          checked ? 'border-amber-500/60 bg-amber-500/10' : 'border-zinc-800 hover:border-zinc-600'
        } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      >
        <input
          type="radio" name="stream-proxy" className="accent-amber-500"
          checked={checked} disabled={disabled}
          onChange={() => select(id)}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-sm text-zinc-100">
            {title}
            {badge && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{badge}</span>}
          </span>
          {detail && <span className="block truncate text-xs text-zinc-500">{detail}</span>}
        </span>
        {testChip(id)}
      </label>
    );
  };

  const customActive = PROXY_RE.test(value) && !scan?.found.some((f) => f.rules === value);

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 flex w-full items-center gap-2 text-sm text-zinc-300">
        Как трансляция выходит в интернет
        <Button size="sm" variant="ghost" className="ml-auto" onClick={doScan} disabled={scanning || !desktop.proxyScan}>
          {scanning ? 'Ищем прокси…' : 'Найти прокси заново'}
        </Button>
      </legend>

      {option({ id: 'system', title: 'Как в Windows и браузере', detail: systemDetail, badge: 'по умолчанию' })}
      {option({ id: 'direct', title: 'Напрямую, без прокси' })}

      {scan?.found.map((f) => option({
        id: f.rules,
        title: `${f.label ?? f.process} — ${f.type === 'socks5' ? 'SOCKS5' : 'HTTP'} 127.0.0.1:${f.port}`,
        detail: f.auth ? 'Требует логин и пароль — так не подключить' : `программа: ${f.process}`,
        badge: f.isSystem ? 'указан в Windows' : undefined,
        disabled: f.auth,
      }))}

      <div className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2 ${customActive ? 'border-amber-500/60 bg-amber-500/10' : 'border-zinc-800'}`}>
        <span className="text-sm text-zinc-100">Свой адрес прокси</span>
        <div className="flex gap-2">
          <Input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="socks5://127.0.0.1:10808"
            aria-label="Свой адрес прокси"
            className="h-8 text-xs"
          />
          <Button
            size="sm" variant="outline" className="shrink-0"
            disabled={!PROXY_RE.test(custom.trim())}
            onClick={() => { select(custom.trim()); void runTest(custom.trim()); }}
          >
            Использовать
          </Button>
        </div>
        {customActive && testChip(value)}
      </div>

      {forbidden && (
        <p className="text-xs text-zinc-500">Поиск прокси работает, когда приложение открыто на своём сервере.</p>
      )}
      {scan?.ok && scan.found.length === 0 && (
        <p className="text-xs text-zinc-500">
          Локальных прокси не найдено. Если VPN работает только в браузере как расширение — у него нет прокси на этом ПК:
          включите в VPN-клиенте (v2rayN, Hiddify, NekoRay…) «системный прокси» или режим TUN, либо укажите его порт вручную.
        </p>
      )}
      <p className="text-xs text-zinc-500">
        Комната и устройства в локальной сети всегда идут мимо прокси. «✓ YouTube» значит, что сайт отвечает через этот вариант;
        если видео всё равно не грузится — попробуйте другой.
      </p>
    </fieldset>
  );
}
