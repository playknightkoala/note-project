import type { Block } from './blocks.ts';

const MAX_TEXT = 200_000;

function inlineText(content: unknown, out: string[]): void {
  if (typeof content === 'string') { out.push(content); return; }
  if (Array.isArray(content)) { for (const item of content) inlineText(item, out); return; }
  if (!content || typeof content !== 'object') return;
  const node = content as Record<string, unknown>;
  if (typeof node.text === 'string') out.push(node.text);
  if (Array.isArray(node.content)) inlineText(node.content, out);
  if (node.type === 'tableContent' && Array.isArray(node.rows)) {
    for (const row of node.rows as { cells?: unknown[] }[]) {
      const cells: string[] = [];
      for (const cell of row.cells ?? []) { const parts: string[] = []; inlineText(cell, parts); cells.push(parts.join('')); }
      out.push(cells.join('\t'), '\n');
    }
  }
  if (node.type === 'pageLink' && node.props && typeof (node.props as { title?: unknown }).title === 'string') out.push((node.props as { title: string }).title);
}

/** Plain text for search indexing: block texts joined by newlines, media names/captions included, whitespace collapsed. */
export function extractPlainText(blocks: Block[]): string {
  const lines: string[] = [];
  const walk = (list: Block[]) => {
    for (const block of list) {
      const parts: string[] = [];
      inlineText(block.content, parts);
      for (const key of ['name', 'caption', 'url']) {
        const value = block.props[key];
        if (typeof value === 'string' && value && key !== 'url') parts.push(value);
      }
      const line = parts.join('').replace(/[ \t]+/g, ' ').trim();
      if (line) lines.push(line);
      if (block.children.length) walk(block.children);
    }
  };
  walk(blocks);
  return lines.join('\n').replace(/\n{2,}/g, '\n').slice(0, MAX_TEXT);
}
