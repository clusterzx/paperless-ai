import { describe, expect, it } from 'vitest';
import { extractJsonObject, findBalancedObject, JsonExtractionError, repairJson, stripReasoning } from '../../src/server/ai/json.js';

describe('stripReasoning', () => {
  it('removes <think> and <thinking> blocks', () => {
    expect(stripReasoning('<think>hmm {"a":1}</think>{"b":2}')).toBe('{"b":2}');
    expect(stripReasoning('<THINKING>x</THINKING>\n answer')).toBe('answer');
    expect(stripReasoning('<think>one</think> mid <think>two</think> end')).toBe('mid  end');
  });

  it('removes reasoning whose opening tag was cut off', () => {
    expect(stripReasoning('reasoning without opening tag</think>{"ok":true}')).toBe('{"ok":true}');
  });

  it('leaves normal text untouched', () => {
    expect(stripReasoning('  {"a": 1}  ')).toBe('{"a": 1}');
  });
});

describe('findBalancedObject', () => {
  it('finds the first balanced object and respects strings', () => {
    expect(findBalancedObject('prefix {"a":"}{","b":{"c":1}} suffix {"x":2}')).toBe('{"a":"}{","b":{"c":1}}');
    expect(findBalancedObject('{"q":"say \\"hi\\" {"}')).toBe('{"q":"say \\"hi\\" {"}');
  });

  it('returns the remainder for truncated output and null without braces', () => {
    expect(findBalancedObject('x {"a": [1, 2')).toBe('{"a": [1, 2');
    expect(findBalancedObject('no json here')).toBeNull();
  });
});

describe('repairJson', () => {
  it('removes trailing commas', () => {
    expect(JSON.parse(repairJson('{"a": [1, 2,], "b": 3,}'))).toEqual({ a: [1, 2], b: 3 });
  });

  it('closes truncated strings, arrays and objects', () => {
    expect(JSON.parse(repairJson('{"title": "Invoice", "tags": ["a", "b'))).toEqual({ title: 'Invoice', tags: ['a', 'b'] });
    expect(JSON.parse(repairJson('{"a": {"b": [1, 2,'))).toEqual({ a: { b: [1, 2] } });
  });

  it('replaces typographic quotes and strips comments', () => {
    expect(JSON.parse(repairJson('{“a”: 1, /* note */ "b": 2 // trailing\n}'))).toEqual({ a: 1, b: 2 });
  });
});

describe('extractJsonObject', () => {
  it('parses plain JSON', () => {
    expect(extractJsonObject('{"title":"x","tags":["a"]}')).toEqual({ title: 'x', tags: ['a'] });
  });

  it('extracts JSON from markdown fences', () => {
    const raw = 'Here you go:\n```json\n{"title": "Fenced"}\n```\nHope this helps';
    expect(extractJsonObject(raw)).toEqual({ title: 'Fenced' });
    expect(extractJsonObject('```\n{"title": "No lang"}\n```')).toEqual({ title: 'No lang' });
  });

  it('ignores think tags that contain braces', () => {
    const raw = '<think>The user wants {"title": "wrong"} maybe</think>\n{"title": "right"}';
    expect(extractJsonObject(raw)).toEqual({ title: 'right' });
  });

  it('finds JSON surrounded by prose', () => {
    expect(extractJsonObject('Sure! {"title": "In prose", "n": 1} – done.')).toEqual({ title: 'In prose', n: 1 });
  });

  it('repairs truncated output and trailing commas', () => {
    expect(extractJsonObject('{"title": "Cut", "tags": ["one", "two",')).toEqual({ title: 'Cut', tags: ['one', 'two'] });
    expect(extractJsonObject('```json\n{"title": "T", "tags": ["a",],}\n```')).toEqual({ title: 'T', tags: ['a'] });
  });

  it('prefers a valid fenced block over invalid ones', () => {
    const raw = '```json\nnot json\n```\n```json\n{"ok": true}\n```';
    expect(extractJsonObject(raw)).toEqual({ ok: true });
  });

  it('rejects arrays, empty and non-JSON output', () => {
    expect(() => extractJsonObject('')).toThrow(JsonExtractionError);
    expect(() => extractJsonObject('   ')).toThrow(JsonExtractionError);
    expect(() => extractJsonObject('[1,2,3]')).toThrow(JsonExtractionError);
    expect(() => extractJsonObject('I cannot help with that.')).toThrow(JsonExtractionError);
    try {
      extractJsonObject('nope');
    } catch (err) {
      expect((err as JsonExtractionError).raw).toBe('nope');
    }
  });
});
