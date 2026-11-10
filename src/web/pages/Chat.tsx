import { useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { ExternalLink, FileSearch, FileText, MessageSquareText, PanelLeft } from 'lucide-react';
import type { DocumentDetail } from '@shared/api';
import { ChatScroll, Composer, MessageView, useChatStream } from '../components/chat';
import { DocumentPicker } from '../components/DocumentPicker';
import { Alert, Badge, Button, EmptyState, LinkButton, Modal, Skeleton } from '../components/ui';
import { get } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { formatDate } from '../lib/format';
import { useMetadata } from '../lib/metadata';

function DocumentChat({ documentId }: { documentId: number }) {
  const meta = useMetadata();
  const doc = useAsync((signal) => get<DocumentDetail>(`/api/documents/${documentId}`, signal), [documentId]);
  const chat = useChatStream(`/api/chat/document/${documentId}`);
  const [, navigate] = useLocation();
  const suggestions = ['Summarize this document.', 'What are the key dates and deadlines?', 'Which amounts are mentioned?', 'Is there anything I need to do?'];
  // The server accepts up to 50 turns – the recent ones are enough context.
  const send = (text: string) => chat.send(text, (history, message) => ({ message, history: history.slice(-12) }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface/70 px-4 py-3 sm:px-6">
        {doc.data ? (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FileText className="size-4 shrink-0 text-accent" />
              <h2 className="truncate font-semibold">{doc.data.title}</h2>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
              <span>#{doc.data.id}</span>
              <span>{formatDate(doc.data.created)}</span>
              {doc.data.correspondent && <span>{meta.correspondentName(doc.data.correspondent)}</span>}
              {doc.data.document_type && <span>{meta.documentTypeName(doc.data.document_type)}</span>}
            </div>
          </div>
        ) : (
          <Skeleton className="h-9 w-64" />
        )}
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="ghost" icon={<FileSearch className="size-4" />} onClick={() => navigate(`/review?doc=${documentId}`)} aria-label="Review">
            <span className="hidden sm:inline">Review</span>
          </Button>
          {doc.data && (
            <LinkButton href={doc.data.url} size="sm" variant="ghost" icon={<ExternalLink className="size-4" />} aria-label="Open in Paperless">
              <span className="hidden sm:inline">Paperless</span>
            </LinkButton>
          )}
        </div>
      </div>
      {doc.error && <Alert tone="danger" className="m-4">{doc.error}</Alert>}
      <ChatScroll deps={[chat.messages]}>
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
          {!chat.messages.length && (
            <div className="py-8 text-center">
              <MessageSquareText className="mx-auto mb-3 size-8 text-accent" />
              <p className="text-sm text-muted">Ask anything about this document.</p>
              {doc.data && !doc.data.content && <Alert tone="warn" className="mx-auto mt-4 max-w-md text-left">This document has no text content (OCR missing).</Alert>}
              <div className="mx-auto mt-6 flex max-w-xl flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button key={s} onClick={() => send(s)} className="rounded-full border border-border bg-surface px-3 py-1.5 text-sm text-muted transition hover:border-accent hover:text-fg">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {chat.messages.map((m) => (
            <MessageView key={m.id} message={m} />
          ))}
        </div>
      </ChatScroll>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6">
        <Composer onSend={send} onStop={chat.stop} busy={chat.busy} placeholder="Ask about this document…" />
      </div>
    </div>
  );
}

export default function ChatPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const fromUrl = Number(params.get('doc') ?? params.get('open')) || null;
  const [selected, setSelected] = useState<number | null>(fromUrl);
  const [pickerOpen, setPickerOpen] = useState(false);
  const meta = useMetadata();
  useEffect(() => setSelected(fromUrl), [fromUrl]);
  const select = (id: number) => {
    setPickerOpen(false);
    navigate(`/chat?doc=${id}`);
  };
  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-80 shrink-0 flex-col border-r border-border bg-surface p-4 lg:flex">
        <h1 className="mb-3 font-semibold">Document chat</h1>
        <DocumentPicker selected={selected} onSelect={select} meta={meta} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-border px-4 py-2 lg:hidden">
          <Button size="sm" icon={<PanelLeft className="size-4" />} onClick={() => setPickerOpen(true)}>
            Choose document
          </Button>
        </div>
        {selected ? (
          <DocumentChat key={selected} documentId={selected} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon={<MessageSquareText className="size-5" />} title="Select a document" action={<Badge>Tip: open a document from the history or review page</Badge>}>
              Choose a document on the left to start chatting about its content.
            </EmptyState>
          </div>
        )}
      </div>
      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title="Choose a document" size="lg">
        <div className="h-[65vh]">
          <DocumentPicker selected={selected} onSelect={select} meta={meta} />
        </div>
      </Modal>
    </div>
  );
}
