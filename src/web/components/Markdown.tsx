import { memo, useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { cn } from '../lib/format';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Answers contain text from documents and the model – no styles, forms or embedded content.
 * Table alignment uses the `align` attribute (styled in styles.css), so inline styles are not needed.
 */
const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'dialog', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style'],
};
/** Second pass after the citation chips were added – they are the only buttons left. */
const PURIFY_WITH_CITES = { ...PURIFY, FORBID_TAGS: PURIFY.FORBID_TAGS.filter((t) => t !== 'button') };

/** Replace "[n]" citation markers in text nodes with clickable chips (built with DOM APIs, text only). */
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
    // Sanitize first so the content itself cannot bring buttons, then sanitize the final markup once more.
    const clean = DOMPurify.sanitize(raw, PURIFY);
    return citations ? DOMPurify.sanitize(linkCitations(clean, citations), PURIFY_WITH_CITES) : clean;
  }, [text, citations]);
  return (
    <div
      className={cn('prose-chat break-words', streaming && 'typing-caret', className)}
      onClick={(e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-cite]');
        if (el && onCite) onCite(Number(el.dataset.cite));
        const a = (e.target as HTMLElement).closest('a');
        if (a) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
