// Чат комнаты: история (50 последних) + отправка. Скролл прижат к низу.
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/lib/api';
import { getClientId } from '@/lib/identity';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ChatProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  connected: boolean;
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function Chat({ messages, onSend, connected }: ChatProps) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLUListElement>(null);
  const myId = getClientId();

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = () => {
    const t = text.trim();
    if (!t || !connected) return;
    onSend(t);
    setText('');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <ul
        ref={listRef}
        className="flex min-h-32 flex-1 flex-col gap-1.5 overflow-y-auto pr-1"
        aria-label="Сообщения чата"
      >
        {messages.length === 0 && (
          <li className="text-sm text-zinc-500">Сообщений пока нет — напишите первым.</li>
        )}
        {messages.map((m) => (
          <li key={m.id} className="text-sm">
            <span className="text-xs text-zinc-500">{fmtTime(m.ts)} </span>
            <span className={m.clientId === myId ? 'font-medium text-amber-300' : 'font-medium text-zinc-300'}>
              {m.nickname}
            </span>
            <span className="text-zinc-500">: </span>
            <span className="break-words text-zinc-200">{m.text}</span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={connected ? 'Сообщение…' : 'Нет связи с сервером…'}
          disabled={!connected}
          maxLength={500}
          aria-label="Сообщение в чат"
        />
        <Button size="sm" onClick={send} disabled={!connected || !text.trim()}>
          ➤
        </Button>
      </div>
    </div>
  );
}
