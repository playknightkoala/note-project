import { Fragment } from 'react';

/** Treat every part as text, including literal HTML and the query itself. */
export function Snippet({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return <>{text.split(new RegExp(`(${escaped})`, 'gi')).map((part, index) => index % 2
    ? <mark key={index}>{part}</mark> : <Fragment key={index}>{part}</Fragment>)}</>;
}
