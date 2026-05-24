// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { extractTextFromContent } from './projects.js';

describe('extractTextFromContent', () => {
  it('extracts text from plain string', () => {
    expect(extractTextFromContent('hello world')).toBe('hello world');
  });

  it('extracts text from text blocks', () => {
    const content = [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }];
    expect(extractTextFromContent(content)).toBe('hello world');
  });

  it('extracts text from tool_result string content', () => {
    const content = [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'result text' }];
    expect(extractTextFromContent(content)).toBe('result text');
  });

  it('extracts text from tool_result array content', () => {
    const content = [
      { type: 'tool_result', tool_use_id: 'tu-1', content: [{ type: 'text', text: 'inner result' }] },
    ];
    expect(extractTextFromContent(content)).toBe('inner result');
  });

  it('extracts tool name from tool_use block', () => {
    const content = [{ type: 'tool_use', id: 'tu-1', name: 'Grep', input: { pattern: 'hello' } }];
    const result = extractTextFromContent(content);
    expect(result).toContain('Grep');
  });

  it('extracts tool input values from tool_use block', () => {
    const content = [
      { type: 'tool_use', id: 'tu-2', name: 'Read', input: { file_path: '/foo/uniquefilename.ts' } },
    ];
    const result = extractTextFromContent(content);
    expect(result).toContain('uniquefilename');
  });

  it('combines tool_use and text blocks in same content array', () => {
    const content = [
      { type: 'text', text: 'I will search for it' },
      { type: 'tool_use', id: 'tu-3', name: 'Grep', input: { pattern: 'mypattern' } },
    ];
    const result = extractTextFromContent(content);
    expect(result).toContain('I will search for it');
    expect(result).toContain('mypattern');
  });

  it('returns empty string for empty array', () => {
    expect(extractTextFromContent([])).toBe('');
  });
});
