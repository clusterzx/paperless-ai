import { memo, useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { cn } from '../lib/format';

marked.setOptions({ gfm: true, breaks: true });

/** Replace "[n]" citation markers in text nodes with clickable chips. */
function linkCitations(html: string, maxCitation: number): string {
  if (!maxCitation) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest('code, pre, a')) continue;
    if (/\[\d{1,2}\]/.test(node.data)) nodes.push(node);
  }
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of node.data.matchAll(/\[(\d{1,2})\]/g)) {
      const n = Number(m[1]);
      if (n < 1 || n > maxCitation) continue;
      frag.append(node.data.slice(last, m.index));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cite';
      btn.dataset.cite = String(n);
      btn.textContent = String(n);
      frag.append(btn);
      last = (m.index ?? 0) + m[0].length;
    }
    frag.append(node.data.slice(last));
    node.replaceWith(frag);
  }
  return tpl.innerHTML;
}

export const Markdown = memo(function Markdown({
  text,
  citations = 0,
  onCite,
  className,
  streaming,
}: {
  text: string;
  citations?: number;
  onCite?: (n: number) => void;
  className?: string;
  streaming?: boolean;
}) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string;
    const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
    return linkCitations(clean, citations);
  }, [text, citations]);
  return (
    <div
      className={cn('prose-chat break-words', streaming && 'typing-caret', className)}
      onClick={(e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-cite]');
        if (el && onCite) onCite(Number(el.dataset.cite));
        const a = (e.target as HTMLElement).closest('a');
        if (a) a.setAttribute('target', '_blank');
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
