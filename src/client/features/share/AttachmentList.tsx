import { Anchor, Stack, Text } from '@mantine/core';
import { Paperclip } from 'lucide-react';

interface Attachment { url: string; name: string }

/** The files a page links to, found in its content. */
export function attachmentsOf(content: unknown[]): Attachment[] {
  const found: Attachment[] = [];
  const walk = (blocks: unknown[]) => {
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const { type, props, children } = block as { type?: unknown; props?: { url?: unknown; name?: unknown }; children?: unknown };
      // Only the site's own file addresses: whatever else a block may carry is not offered as a link.
      if (type === 'file' && typeof props?.url === 'string' && props.url.startsWith('/api/')) found.push({ url: props.url, name: typeof props.name === 'string' && props.name ? props.name : '附件' });
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(content);
  return found;
}

/**
 * A page that cannot be edited shows a file block as a name only. This lists those files as ordinary download links
 * (the server sends everything but the four image types as a sandboxed attachment).
 */
export function AttachmentList({ content }: { content: unknown[] }) {
  const files = attachmentsOf(content);
  if (!files.length) return null;
  return <Stack gap={4} className="attachment-list" aria-label="附件">
    <Text size="xs" c="dimmed">附件</Text>
    {files.map((file, index) => <Anchor key={`${file.url}-${index}`} href={file.url} download={file.name} size="sm"><Paperclip size={13} /> {file.name}</Anchor>)}
  </Stack>;
}
