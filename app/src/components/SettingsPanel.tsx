// Настройки источников: редактирование зеркал LostFilm и добавление своих сайтов.
import { useEffect, useState } from 'react';
import { api, type ProviderInfo } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function SettingsPanel() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({ name: '', baseUrl: '', searchPath: '', itemSelector: '', titleSelector: '' });

  const reload = () => api.listProviders().then(setProviders).catch(() => setProviders([]));
  useEffect(() => { reload(); }, []);

  const saveMirrors = async (p: ProviderInfo, mirrorsText: string) => {
    const mirrors = mirrorsText.split('\n').map((s) => s.trim()).filter(Boolean);
    await api.saveProvider({ ...p, config: { ...p.config, mirrors } });
    setStatus(`Зеркала «${p.name}» сохранены`);
    reload();
  };

  const toggleEnabled = async (p: ProviderInfo) => {
    await api.saveProvider({ ...p, enabled: !p.enabled });
    reload();
  };

  const addCustom = async () => {
    if (!draft.name || !draft.baseUrl || !draft.searchPath || !draft.itemSelector) {
      setStatus('Заполните название, адрес сайта, путь поиска и селектор элемента');
      return;
    }
    const id = `custom-${Date.now().toString(36)}`;
    await api.saveProvider({
      id,
      type: 'custom',
      name: draft.name,
      enabled: true,
      config: {
        baseUrl: draft.baseUrl,
        searchPath: draft.searchPath,
        itemSelector: draft.itemSelector,
        titleSelector: draft.titleSelector || undefined,
      },
    });
    setDraft({ name: '', baseUrl: '', searchPath: '', itemSelector: '', titleSelector: '' });
    setShowAdd(false);
    setStatus(`Источник «${draft.name}» добавлен`);
    reload();
  };

  return (
    <div className="flex flex-col gap-4">
      {providers.map((p) => (
        <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="font-medium text-zinc-100">{p.name}</p>
              <p className="text-xs text-zinc-500">{p.type}{p.enabled ? '' : ' · отключён'}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => toggleEnabled(p)}>
                {p.enabled ? 'Отключить' : 'Включить'}
              </Button>
              {p.type === 'custom' && (
                <Button
                  variant="outline" size="sm"
                  onClick={() => api.deleteProvider(p.id).then(reload)}
                >
                  Удалить
                </Button>
              )}
            </div>
          </div>

          {(p.type === 'lostfilm' || p.type === 'lordserial') && (
            <div className="mt-3">
              <label className="mb-1 block text-xs text-zinc-400" htmlFor={`mirrors-${p.id}`}>
                Зеркала (по одному на строку, перебираются по очереди)
              </label>
              <textarea
                id={`mirrors-${p.id}`}
                defaultValue={((p.config.mirrors as string[]) ?? []).join('\n')}
                rows={3}
                className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 focus-visible:outline-2 focus-visible:outline-amber-500"
              />
              <Button
                size="sm" className="mt-2"
                onClick={(e) => {
                  const ta = (e.currentTarget.parentElement?.querySelector('textarea')) as HTMLTextAreaElement;
                  saveMirrors(p, ta.value);
                }}
              >
                Сохранить зеркала
              </Button>
            </div>
          )}

          {p.type === 'custom' && (
            <p className="mt-2 font-mono text-xs text-zinc-500">
              {(p.config.baseUrl as string) ?? ''}{(p.config.searchPath as string) ?? ''}
            </p>
          )}
        </div>
      ))}

      {!showAdd ? (
        <Button variant="outline" onClick={() => setShowAdd(true)}>+ Добавить свой источник</Button>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-sm font-medium text-zinc-200">Новый источник</p>
          <Input placeholder="Название (напр. «Моё зеркало»)" value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Input placeholder="Адрес сайта, напр. https://example.com" value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
          <Input placeholder="Путь поиска, напр. /search?q={q}" value={draft.searchPath}
            onChange={(e) => setDraft({ ...draft, searchPath: e.target.value })} />
          <Input placeholder="CSS-селектор элемента выдачи, напр. .results .item" value={draft.itemSelector}
            onChange={(e) => setDraft({ ...draft, itemSelector: e.target.value })} />
          <Input placeholder="CSS-селектор заголовка (необязательно)" value={draft.titleSelector}
            onChange={(e) => setDraft({ ...draft, titleSelector: e.target.value })} />
          <div className="flex gap-2">
            <Button onClick={addCustom}>Добавить</Button>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Отмена</Button>
          </div>
        </div>
      )}

      {status && <p className="text-sm text-amber-300">{status}</p>}
    </div>
  );
}
