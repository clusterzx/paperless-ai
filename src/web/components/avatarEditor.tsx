/** Profile picture: preview, upload (PNG, JPEG, WebP up to 2 MB – the server makes a 256×256 WebP of it) and remove. */
import { useRef, useState } from 'react';
import { ImageUp, Trash2 } from 'lucide-react';
import { Avatar, Button, useToast } from './ui';
import { del, errorMessage, postForm } from '../lib/api';

const MAX_BYTES = 2 * 1024 * 1024;

export function AvatarEditor({ name, url, endpoint, onChange }: { name: string; url: string | null; endpoint: string; onChange: (url: string | null) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    if (file.size > MAX_BYTES) return toast.error('The picture is larger than 2 MB');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await postForm<{ avatarUrl: string }>(endpoint, form, 'PUT');
      onChange(res.avatarUrl);
      toast.success('Profile picture saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await del(endpoint);
      onChange(null);
      toast.success('Profile picture removed');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-4">
      <Avatar name={name} src={url} className="size-16 text-lg" />
      <div className="flex flex-wrap gap-2">
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          aria-label="Choose a profile picture"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <Button size="sm" icon={<ImageUp className="size-3.5" />} loading={busy} onClick={() => input.current?.click()}>
          {url ? 'Change picture' : 'Upload picture'}
        </Button>
        {url && (
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={busy} onClick={() => void remove()}>
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
