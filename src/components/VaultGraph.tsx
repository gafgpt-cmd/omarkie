import { t } from "../i18n";
export default function VaultGraph({ index, open }: { index: any; open(token: string): void }) {
  const notes = index.notes.slice(0, 200), positions = new Map<string, [number, number]>(notes.map((note: any, at: number) => [note.relative, [300 + 240 * Math.cos(2 * Math.PI * at / notes.length), 280 + 220 * Math.sin(2 * Math.PI * at / notes.length)]]));
  return <section><p>{t("图谱最多显示 200 篇笔记。选择节点即可打开。")}</p><svg viewBox="0 0 600 560" role="img" aria-label={t("知识库图谱")} style={{ width: "100%", maxHeight: "55vh" }}>
    {index.edges.filter((edge: any) => !edge.ref.image && edge.candidates.length === 1).map((edge: any, at: number) => {
      const from = positions.get(edge.source.relative), to = positions.get(edge.candidates[0].relative);
      return from && to ? <line key={at} x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} stroke="currentColor" opacity=".25" /> : null;
    })}
    {notes.map((note: any) => { const [x, y] = positions.get(note.relative)!; return <g key={note.token} role="button" tabIndex={0} aria-label={note.relative} onClick={() => open(note.token)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(note.token); } }}><title>{note.relative}</title><circle cx={x} cy={y} r={6} fill="currentColor" /><text x={x + 8} y={y} fill="currentColor" fontSize={10}>{note.relative.slice(-30)}</text></g>; })}
  </svg><ul>{notes.map((note: any) => <li key={note.token}><button onClick={() => open(note.token)}>{note.relative}</button></li>)}</ul></section>;
}
