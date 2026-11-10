/** Strip a trailing "/api" (and slashes) from a Paperless URL. */
export function normalizePaperlessUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (/\/api$/i.test(u)) u = u.slice(0, -4);
  return u.replace(/\/+$/, '');
}
