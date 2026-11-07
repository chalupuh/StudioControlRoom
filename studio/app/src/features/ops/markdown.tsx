// Tiny Markdown-ish renderer. Builds React elements (never innerHTML), so all text is escaped by React.
import type { ReactNode } from 'react';

export function inline(text: string, keyBase = ''): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0, i = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = keyBase + '-' + i++;
    out.push(tok.startsWith('`') ? <code key={k}>{tok.slice(1, -1)}</code> : <strong key={k}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const splitRow = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = 'b' + k++;
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(<pre key={key}><code>{buf.join('\n')}</code></pre>);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = Math.min(6, line.match(/^#+/)![0].length);
      const Tag = (`h${level + 1 > 6 ? 6 : level + 1}`) as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      out.push(<Tag key={key}>{inline(line.replace(/^#+\s*/, ''), key)}</Tag>);
      i++;
    } else if (line.includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      out.push(
        <div className="md-table" key={key}>
          <table>
            <thead><tr>{head.map((h, c) => <th key={c} scope="col">{inline(h, key + 'h' + c)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c, key + ri + '-' + ci)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const lis = items.map((t, n) => <li key={n}>{inline(t, key + n)}</li>);
      out.push(ordered ? <ol key={key}>{lis}</ol> : <ul key={key}>{lis}</ul>);
    } else if (!line.trim()) {
      i++;
    } else {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*]|\d+\.)\s+)/.test(lines[i]) && !(lines[i].includes('|') && lines[i + 1] && isSep(lines[i + 1]))) buf.push(lines[i++]);
      if (!buf.length) { buf.push(lines[i++]); }
      out.push(<p key={key}>{inline(buf.join(' '), key)}</p>);
    }
  }
  return out;
}
