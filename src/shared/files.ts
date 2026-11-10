// File type rules shared by the server (what it stores and how it serves it) and the client (how a file that is
// still waiting on this device is previewed). Pure functions: no Node or DOM API.

/** MIME → extension for everything the server will store under its own name; anything else becomes an octet-stream attachment. */
const ALLOWED: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json', 'application/zip': 'zip',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'video/mp4': 'mp4', 'video/webm': 'webm',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** How many leading bytes `sniffMime` looks at. */
export const SNIFF_BYTES = 16;

/** Magic-byte sniffing for the types browsers render inline; the declared type is only trusted when allow-listed. */
export function sniffMime(bytes: Uint8Array, declared: string | undefined): string {
  const starts = (...sig: number[]) => sig.every((byte, i) => bytes[i] === byte);
  const ascii = (offset: number, text: string) => text.length <= bytes.length - offset && [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio/wav';
  if (ascii(0, '%PDF')) return 'application/pdf';
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm';
  if (ascii(4, 'ftyp')) return declared === 'audio/mp4' ? 'audio/mp4' : 'video/mp4';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (starts(0x49, 0x44, 0x33) || starts(0xff, 0xfb) || starts(0xff, 0xf3)) return 'audio/mpeg';
  if (starts(0x50, 0x4b, 0x03, 0x04)) {
    if (declared && declared.startsWith('application/vnd.openxmlformats')) return ALLOWED[declared] ? declared : 'application/zip';
    return 'application/zip';
  }
  const type = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'image/svg+xml' || type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/') || type === 'application/pdf') {
    // Declared as media but the bytes do not match: never serve it inline.
    return type === 'image/svg+xml' ? 'image/svg+xml' : 'application/octet-stream';
  }
  return ALLOWED[type] ? type : 'application/octet-stream';
}

export const servesInline = (mime: string): boolean => INLINE.has(mime);
export const extensionFor = (mime: string): string => ALLOWED[mime] ?? 'bin';

export function sanitizeName(name: string, ext: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.normalize('NFC').replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '').trim().slice(0, 200);
  const base = cleaned || `file.${ext}`;
  return base.includes('.') ? base : `${base}.${ext}`;
}

/** The address a file is served at. The name part is only cosmetic: the server looks the file up by id. */
export const fileUrlFor = (id: string, name: string): string => `/api/files/${id}/${encodeURIComponent(name)}`;

/** Headers a stored file is served with. Only the four sniffed image types render inline; the rest download sandboxed. */
export function fileHeaders(mime: string, name: string): Record<string, string> {
  const inline = servesInline(mime);
  const headers: Record<string, string> = {
    'Content-Type': mime, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer',
  };
  if (!inline) headers['Content-Security-Policy'] = 'sandbox';
  return headers;
}
