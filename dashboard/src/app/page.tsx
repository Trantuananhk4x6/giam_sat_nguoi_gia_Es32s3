"use client";

/* Trang Tổng quan cho NGƯỜI NHÀ: tình hình bằng lời thường, AI nhận xét,
   diễn biến trong ngày. Số liệu kỹ thuật nằm ở menu Kỹ thuật > Giám sát thiết bị. */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { LEVEL_LABEL, SPEAK_LABEL, ago, capFirst, hm, withoutCommand } from "@/components/labels";
import { sendAction } from "@/components/useLive";
import { Ic, IcKey, type IconName } from "@/components/Icon";
import type { Overview } from "@/lib/health";

type OverviewRes = Overview & { series: { t: number; range: number; present: number }[] };
type Comment = { text: string; ai: boolean; at: number; level: string };

const HERO_ICON: Record<string, IconName> = {
  "binh-thuong": "home",
  "chu-y": "warning",
  "khan-cap": "emergency",
  "khong-ro": "radar",
};

function activityWord(v: number | null): string {
  if (v === null) return "chưa có số liệu";
  if (v < 8) return "rất ít";
  if (v < 25) return "ít";
  if (v < 50) return "vừa phải";
  return "nhiều";
}

export default function TongQuanPage() {
  const [o, setO] = useState<OverviewRes | null>(null);
  const [netErr, setNetErr] = useState<string | null>(null);
  const [comment, setComment] = useState<Comment | null>(null);
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastLevel = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tong-quan", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setO((await res.json()) as OverviewRes);
      setNetErr(null);
    } catch (e) {
      setNetErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadComment = useCallback(async (force: boolean) => {
    setCBusy(true);
    setCErr(null);
    try {
      const res = await fetch("/api/tong-quan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const j = (await res.json()) as Comment & { error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setComment(j);
    } catch (e) {
      setCErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCBusy(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load();
      if (alive) t = setTimeout(tick, 3000);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [load]);

  // Lấy nhận xét lần đầu và mỗi khi mức độ thay đổi (vd chuyển sang nghi ngã)
  useEffect(() => {
    if (!o) return;
    if (lastLevel.current !== o.level) {
      lastLevel.current = o.level;
      void loadComment(false);
    }
  }, [o, loadComment]);

  async function markSafe() {
    if (!confirm("Xác nhận đã kiểm tra và người thân AN TOÀN? Hệ thống sẽ tắt báo động.")) return;
    setBusy(true);
    const err = await sendAction("iamok");
    if (err) alert(err);
    setBusy(false);
    await load();
  }

  const level = o?.level ?? "khong-ro";
  const call = o?.call ?? "người thân";
  const C = capFirst(call);
  const alerting = o?.state === "KHAN_CAP" || o?.state === "NGHI_NGO_TE_NGA";
  const series = (o?.series ?? []).map((p) => ({ t: hm(p.t), v: p.range }));

  return (
    <>
      {netErr && <div className="badbox">Không gọi được máy chủ dashboard: {netErr}</div>}

      <section className={`hero2 lv-${level}`} aria-live="polite">
        <div className="hero2-main">
          <div className="avatar" aria-hidden><Ic name={HERO_ICON[level] ?? "radar"} size={30} /></div>
          <div>
            <div className="eyebrow">
              {o ? `${o.name}${o.place ? ` · ${o.place}` : ""}` : "Đang tải…"}
            </div>
            <h1 className="hero2-title">{o?.headline ?? "Đang kết nối với thiết bị…"}</h1>
            <p className="hero2-detail">{o?.detail ?? ""}</p>
            <div className="chips">
              <span className="chip gold">{LEVEL_LABEL[level]}</span>
              {o && <span className="chip">Cập nhật {ago(o.online ? o.updatedAt : null)}</span>}
              {o?.lastSeenAt && o.activity === "vang-mat" && (
                <span className="chip">Lần cuối thấy {call}: {hm(o.lastSeenAt)}</span>
              )}
              {o?.simulate && <span className="chip">Chế độ mô phỏng</span>}
            </div>
          </div>
        </div>
        <div className="hero2-side">
          {o?.state === "NGHI_NGO_TE_NGA" && (
            <div className="hero2-count">
              {o.countdown}
              <small>giây chờ {call} trả lời</small>
            </div>
          )}
          {alerting ? (
            <button className="b-white big" onClick={() => void markSafe()} disabled={busy}>
              Đã kiểm tra, {call} an toàn
            </button>
          ) : (
            <div className="btns">
              <Link className="btn-link solid" href="/loi-nhan"><Ic name="speaker" size={16} /> Gửi lời nhắn qua loa</Link>
              <Link className="btn-link" href="/tro-chuyen"><Ic name="chat" size={16} /> Hỏi trợ lý</Link>
            </div>
          )}
        </div>
      </section>

      <div className="tiles">
        <div className="tile">
          <span className="ic" aria-hidden><Ic name="door" size={22} /></span>
          <b>{o?.today.roomVisits ?? "—"}</b>
          <em>Lần vào phòng hôm nay</em>
        </div>
        <div className={`tile${(o?.today.suspects ?? 0) > 0 ? " warn" : ""}`}>
          <span className="ic" aria-hidden><Ic name="warning" size={22} /></span>
          <b>{o ? (o.today.suspects || "Không") : "—"}</b>
          <em>Lần nghi ngã</em>
        </div>
        <div className={`tile${(o?.today.emergencies ?? 0) + (o?.today.sos ?? 0) > 0 ? " bad" : ""}`}>
          <span className="ic" aria-hidden><Ic name="sos" size={22} /></span>
          <b>{o ? (o.today.emergencies + o.today.sos || "Không") : "—"}</b>
          <em>Cảnh báo / bấm SOS</em>
        </div>
        <div className="tile">
          <span className="ic" aria-hidden><Ic name="speaker" size={22} /></span>
          <b>{o?.today.messages ?? "—"}</b>
          <em>Lời nhắn đã gửi qua loa</em>
        </div>
      </div>

      <div className="grid2">
        <div className="stack">
          <div className="card ai-card">
            <div className="card-head">
              <span className="ai-badge"><Ic name="sparkle" size={15} /> Trợ lý AI nhận xét</span>
              <button className="b-gray small" onClick={() => void loadComment(true)} disabled={cBusy}>
                {cBusy ? "Đang viết…" : "Làm mới"}
              </button>
            </div>
            {cErr && <div className="badbox">{cErr}</div>}
            {comment ? (
              <p className="ai-text">{comment.text}</p>
            ) : (
              <>
                <div className="skeleton" style={{ width: "92%" }} />
                <div className="skeleton" style={{ width: "78%" }} />
                <div className="skeleton" style={{ width: "60%" }} />
              </>
            )}
            {comment && (
              <div className="sub">
                {comment.ai ? "Viết bởi AI (Groq) dựa trên dữ liệu radar" : "Tóm tắt tự động (chưa bật AI)"} · lúc{" "}
                {hm(comment.at)} · AI không thay thế bác sĩ.
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Mức vận động vài phút qua</h2>
              <span className="st-pill navy">Vận động {activityWord(o?.activityLevel ?? null)}</span>
            </div>
            <div style={{ width: "100%", height: 170 }}>
              <ResponsiveContainer>
                <AreaChart data={series} margin={{ top: 6, right: 6, bottom: 0, left: -22 }}>
                  <defs>
                    <linearGradient id="actFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="#2a4ba0" stopOpacity={0.35} />
                      <stop offset="1" stopColor="#2a4ba0" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" tick={{ fill: "#95a0b8", fontSize: 11 }} minTickGap={50} />
                  <YAxis domain={[0, 100]} tick={{ fill: "#95a0b8", fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ borderRadius: 10, border: "1px solid #e2e7f1" }}
                    formatter={(v: unknown): [string, string] => [String(v), "Mức vận động"]}
                  />
                  <Area type="monotone" dataKey="v" stroke="#1f3f87" strokeWidth={2} fill="url(#actFill)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="sub">
              0 là nằm/ngồi yên hoặc vắng phòng, càng cao là đi lại càng nhiều. Radar không ghi hình nên
              không xâm phạm riêng tư của {call}.
            </div>
          </div>

          {o?.vitals && (
            <div className="card">
              <h2>Khi {call} ngủ (ước lượng)</h2>
              <div className="vitals">
                <div className="vital"><b>{o.vitals.heartRate || "—"}</b><small>nhịp tim / phút</small></div>
                <div className="vital"><b>{o.vitals.breatheValue || "—"}</b><small>nhịp thở / phút</small></div>
              </div>
              <div className="sub" style={{ marginTop: 10 }}>
                {capFirst(o.vitals.sleepState)} · {o.vitals.inBed ? "đang trên giường" : "ngoài giường"}. Số liệu
                đo bằng sóng radar, không phải thiết bị y tế.
              </div>
            </div>
          )}
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Hôm nay của {call}</h2>
              <Link href="/nhat-ky" className="sub">Xem tất cả <Ic name="arrow-right" size={14} /></Link>
            </div>
            {o && o.timeline.length === 0 ? (
              <div className="empty">
                <span className="big" aria-hidden><Ic name="calm" size={30} /></span>
                Chưa có diễn biến nào hôm nay.
              </div>
            ) : (
              <ul className="timeline">
                {(o?.timeline ?? []).slice(0, 12).map((e) => (
                  <li key={e.key} className={`tl tone-${e.tone}`}>
                    <span className="tl-time">{e.time}</span>
                    <span className="tl-ic" aria-hidden><IcKey name={e.icon} size={18} /></span>
                    <span className="tl-text">{e.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Lời nhắn gần đây</h2>
              <Link href="/loi-nhan" className="sub">Gửi lời nhắn <Ic name="arrow-right" size={14} /></Link>
            </div>
            {o && o.recentMessages.length === 0 ? (
              <div className="empty">
                Chưa có lời nhắn nào. Nhắn <b>/hoitham</b> cho bot Telegram hoặc dùng trang Gửi lời nhắn.
              </div>
            ) : (
              (o?.recentMessages ?? []).slice(0, 3).map((m) => (
                <div className="msg-item" key={m.id}>
                  <div className="msg-meta">
                    <b>{m.from}</b> · {hm(m.at)}
                    {m.speak && <span className={`st-pill ${SPEAK_LABEL[m.speak].tone}`}>{SPEAK_LABEL[m.speak].text}</span>}
                  </div>
                  <div className="msg-said spoken">{m.spokenText ?? withoutCommand(m.text)}</div>
                </div>
              ))
            )}
          </div>

          <div className="card">
            <h2>Thiết bị trong phòng</h2>
            <div className="status-list">
              <div className={`status-item ${o?.online ? "ok" : "bad"}`}>
                <span className="dot" /> <span>{o?.online ? "Thiết bị đang hoạt động" : "Mất liên lạc với thiết bị"}</span>
              </div>
              <div className={`status-item ${o?.device.radarOk ? "ok" : "bad"}`}>
                <span className="dot" /> <span>{o?.device.radarOk ? "Radar đang theo dõi" : "Radar chưa sẵn sàng"}</span>
              </div>
              <div className={`status-item ${o?.device.telegramPoller ? "ok" : "warn"}`}>
                <span className="dot" />{" "}
                <span>
                  {o?.device.telegramPoller === "dashboard"
                    ? "Trợ lý AI đang trả lời Telegram"
                    : o?.device.telegramPoller === "device"
                      ? "Thiết bị tự trả lời Telegram"
                      : "Chat Telegram hai chiều chưa bật"}
                </span>
              </div>
            </div>
            <div className="sub" style={{ marginTop: 10 }}>
              {C} ngã hay bấm SOS thì thiết bị tự báo Telegram cho người nhà, kể cả khi máy tính này tắt.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
