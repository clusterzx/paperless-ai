/** Profile picture: preview, upload and remove (Settings → Account and the user dialog of admins). */
import { useRef, useState } from 'react';
import { ImageUp, Trash2 } from 'lucide-react';
import { Avatar, Button, useToast } from './ui';
import { errorMessage } from '../lib/api';

const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 2 * 1024 * 1024;

export function AvatarPicker({
  name,
  url,
  upload,
  remove,
}: {
  name: string;
  url: string | null;
  upload: (file: File) => Promise<void>;
  remove: () => Promise<void>;
}) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const run = async (kind: 'upload' | 'remove', action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const picked = (file: File | undefined) => {
    if (input.current) input.current.value = '';
    if (!file) return;
    if (!TYPES.includes(file.type)) return toast.error('Choose a PNG, JPEG or WebP picture');
    if (file.size > MAX_BYTES) return toast.error('The picture is larger than 2 MB');
    void run('upload', () => upload(file));
  };
  return (
    <div className="flex items-center gap-4">
      <Avatar name={name || '?'} src={url} className="size-16 text-lg" />
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<ImageUp className="size-4" />} loading={busy === 'upload'} disabled={busy !== null} onClick={() => input.current?.click()}>
            {url ? 'Change picture' : 'Upload picture'}
          </Button>
          {url && (
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} loading={busy === 'remove'} disabled={busy !== null} onClick={() => void run('remove', remove)}>
              Remove
            </Button>
          )}
        </div>
        <p className="text-xs text-muted">PNG, JPEG or WebP, up to 2 MB. It is cut to a square.</p>
      </div>
      <input ref={input} type="file" accept={TYPES.join(',')} className="hidden" onChange={(e) => picked(e.target.files?.[0])} />
    </div>
  );
}
