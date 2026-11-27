// Настройки комнаты (для её создателя и компьютера-хоста): название, пароль,
// «скрыть из списка», удаление.
import { useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

export interface RoomSettingsValue {
  id: string;
  name: string;
  hasPassword: boolean;
  hidden: boolean;
}

interface RoomSettingsDialogProps {
  room: RoomSettingsValue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (room: RoomSettingsValue) => void;
  onDeleted: () => void;
}

export function RoomSettingsDialog({ room, open, onOpenChange, onSaved, onDeleted }: RoomSettingsDialogProps) {
  const [name, setName] = useState(room.name);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setName(room.name);
      setPassword('');
      setMessage(null);
      setConfirmDelete(false);
    }
    onOpenChange(next);
  };

  const save = async (patch: { name?: string; password?: string; hidden?: boolean }, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.updateRoom(room.id, patch);
      onSaved({ id: room.id, name: res.name, hasPassword: res.hasPassword, hidden: res.hidden });
      setMessage({ text: done });
      if (patch.password !== undefined) setPassword('');
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Не удалось сохранить', error: true });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteRoom(room.id);
      onOpenChange(false);
      onDeleted();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Не удалось удалить', error: true });
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Настройки комнаты</DialogTitle>
          <DialogDescription className="text-zinc-400">Меняет создатель комнаты — остальные видят изменения сразу.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-1.5">
            <label htmlFor="room-name" className="text-xs text-zinc-400">Название</label>
            <div className="flex gap-2">
              <Input
                id="room-name" value={name} maxLength={100}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && name.trim() && name.trim() !== room.name && save({ name: name.trim() }, 'Название сохранено')}
              />
              <Button onClick={() => save({ name: name.trim() }, 'Название сохранено')} disabled={busy || !name.trim() || name.trim() === room.name}>
                Сохранить
              </Button>
            </div>
          </section>

          <section className="flex flex-col gap-1.5">
            <span className="flex items-center gap-2 text-xs text-zinc-400">
              Пароль
              <span className={`rounded px-1.5 py-0.5 ${room.hasPassword ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-800 text-zinc-400'}`}>
                {room.hasPassword ? 'установлен' : 'нет'}
              </span>
            </span>
            <div className="flex gap-2">
              <Input
                type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={room.hasPassword ? 'Новый пароль' : 'Задать пароль'}
                aria-label="Новый пароль комнаты"
              />
              <Button onClick={() => save({ password }, room.hasPassword ? 'Пароль изменён' : 'Пароль установлен')} disabled={busy || !password}>
                {room.hasPassword ? 'Сменить' : 'Задать'}
              </Button>
            </div>
            {room.hasPassword && (
              <Button variant="ghost" size="sm" className="-ml-2 w-fit" disabled={busy} onClick={() => save({ password: '' }, 'Пароль убран')}>
                Убрать пароль
              </Button>
            )}
            <p className="text-xs text-zinc-500">Кто уже в комнате, останется в ней; пароль спросят при следующем входе.</p>
          </section>

          <section className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-zinc-100">Скрыть из списка комнат</p>
              <p className="text-xs text-zinc-500">
                Другие не увидят комнату на главной — войти можно только по ссылке-приглашению. В вашем списке она останется.
              </p>
            </div>
            <button
              type="button" role="switch" aria-checked={room.hidden} aria-label="Скрыть из списка комнат"
              disabled={busy}
              onClick={() => save({ hidden: !room.hidden }, room.hidden ? 'Комната снова видна всем' : 'Комната скрыта из списка')}
              className={`relative mt-0.5 h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${room.hidden ? 'bg-amber-500' : 'bg-zinc-700'}`}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${room.hidden ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </section>

          {message && (
            <p className={`text-sm ${message.error ? 'text-red-400' : 'text-emerald-300'}`} role="status">{message.text}</p>
          )}

          <section className="border-t border-zinc-800 pt-4">
            {!confirmDelete ? (
              <Button variant="ghost" className="-ml-2 text-red-400 hover:text-red-300" onClick={() => setConfirmDelete(true)}>
                Удалить комнату…
              </Button>
            ) : (
              <div className="flex flex-col gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                <p className="text-sm text-red-200">Удалить «{room.name}» вместе с чатом, очередью и историей? Это нельзя отменить.</p>
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" onClick={remove} disabled={busy}>Удалить навсегда</Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>Отмена</Button>
                </div>
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
