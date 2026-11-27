import { describe, expect, it } from 'vitest';
import { safeNext } from '../../src/server/oidc.js';

describe('safeNext', () => {
  it('keeps paths on this origin', () => {
    expect(safeNext('/documents?q=a&b=c#x')).toBe('/documents?q=a&b=c#x');
    expect(safeNext('/')).toBe('/');
  });

  it('refuses everything that could lead to another site', () => {
    for (const bad of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', '/\r\n/evil.example', '/\\\t\\evil.example', 'https://evil.example', 'evil', '', 42, null]) {
      expect(safeNext(bad), JSON.stringify(bad)).toBe('/');
    }
  });
});
