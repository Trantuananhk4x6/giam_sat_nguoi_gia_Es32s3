"use client";

/* Nhật ký nhiều ngày bằng lời thường. Bảng sự kiện thô của firmware vẫn ở
   Kỹ thuật > Giám sát thiết bị (và tải CSV được ở đây). */
import { useEffect, useState } from "react";
import { capFirst, dayVN } from "@/components/labels";
import type { FriendlyEvent } from "@/lib/health";

type Res = { call: string; days: number; items: FriendlyEvent[] };
const RANGES = [
  { d: 1, label: "Hôm nay" },
  { d: 7, label: "7 ngày" },
  { d: 30, label: "30 ngày" },
];

export default function NhatKyPage() {
  const [days, setDays] = useState(7);
  const [all, setAll] = useState(false);
  const [data, setData] = useState<Res | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/nhat-ky?days=${days}&all=${all ? 1 : 0}`, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as Res;
        if (alive) { setData(j); setErr(null); }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => { alive = false; clearInterval(t); };
  }, [days, all]);

  const call = data?.call ?? "người thân";
  const groups: { day: string; list: FriendlyEvent[] }[] = [];
  for (const e of data?.items ?? []) {
    const d = dayVN(e.at);
    if (groups[groups.length - 1]?.day !== d) groups.push({ day: d, list: [] });
    groups[groups.length - 1].list.push(e);
  }
  const countOf = (l: FriendlyEvent[], types: string[]) => l.filter((e) => types.includes(e.type)).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Nhật ký của {call}</h1>
          <p className="sub">Mọi diễn biến radar ghi nhận, viết bằng lời thường. Mới nhất ở trên.</p>
        </div>
        <div className="btns" style={{ alignItems: "center" }}>
          <div className="tabs" role="tablist" aria-label="Khoảng thời gian">
            {RANGES.map((r) => (
              <button key={r.d} role="tab" aria-selected={days === r.d} className={`tab${days === r.d ? " on" : ""}`} onClick={() => setDays(r.d)}>
                {r.label}
              </button>
            ))}
          </div>
          <label className="toggle">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Hiện cả sự kiện kỹ thuật
          </label>
          <button className="b-gray small" onClick={() => location.assign("/api/export?kind=events")}>Tải Excel</button>
        </div>
      </div>
      {err && <div className="badbox">{err}</div>}
      {data && groups.length === 0 && (
        <div className="card"><div className="empty"><span className="big" aria-hidden>🌤️</span>Chưa có diễn biến nào trong khoảng này.</div></div>
      )}
      {groups.map((g) => (
        <div className="card" key={g.day} style={{ marginBottom: 16 }}>
          <div className="card-head">
            <h2>{g.day}</h2>
            <div className="btns">
              {countOf(g.list, ["PRESENCE_IN"]) > 0 && <span className="st-pill navy">{countOf(g.list, ["PRESENCE_IN"])} lần vào phòng</span>}
              {countOf(g.list, ["FALL_SUSPECT"]) > 0 && <span className="st-pill warn">{countOf(g.list, ["FALL_SUSPECT"])} lần nghi ngã</span>}
              {countOf(g.list, ["EMERGENCY", "SOS", "SOS_REMOTE"]) > 0 && (
                <span className="st-pill bad">{countOf(g.list, ["EMERGENCY", "SOS", "SOS_REMOTE"])} cảnh báo / SOS</span>
              )}
              {countOf(g.list, ["MESSAGE"]) > 0 && <span className="st-pill ok">{countOf(g.list, ["MESSAGE"])} lời nhắn</span>}
            </div>
          </div>
          <ul className="timeline">
            {g.list.map((e) => (
              <li key={e.key} className={`tl tone-${e.tone}`}>
                <span className="tl-time">{e.time}</span>
                <span className="tl-ic" aria-hidden>{e.icon}</span>
                <span className="tl-text">{capFirst(e.text)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
