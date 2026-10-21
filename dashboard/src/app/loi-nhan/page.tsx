"use client";

/* Gửi lời nhắn để loa ESP32 đọc cho người cao tuổi nghe (giống lệnh /hoitham
   trên Telegram), kèm nhật ký mọi lượt người nhà hỏi thăm qua Telegram và web. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CHANNEL_LABEL, SPEAK_LABEL, capFirst, dayVN, hm, withoutCommand } from "@/components/labels";
import type { Interaction, SpeakStatus, TelegramBotInfo } from "@/lib/types";

type ListRes = { items: Interaction[]; bot: TelegramBotInfo };
type SendRes = { reply?: string; error?: string; spoken?: { text: string; status: SpeakStatus; seconds: number | null } | null };
type Filter = "all" | "hoitham" | "hoi" | "tu-choi";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "hoitham", label: "Lời nhắn qua loa" },
  { id: "hoi", label: "Hỏi tình hình" },
  { id: "tu-choi", label: "Bị từ chối" },
];

const BOT_STATE: Record<string, { text: string; tone: string }> = {
  "dang-doc": { text: "Đang hoạt động", tone: "ok" },
  "cho-thiet-bi": { text: "Đang chờ thiết bị nhường quyền", tone: "warn" },
  "firmware-cu": { text: "Cần nạp firmware mới", tone: "warn" },
  "xung-dot": { text: "Xung đột (nơi khác cũng đọc tin)", tone: "warn" },
  "loi-token": { text: "Sai token", tone: "bad" },
  "loi-mang": { text: "Lỗi mạng", tone: "bad" },
  off: { text: "Đang tắt", tone: "" },
};

export default function LoiNhanPage() {
  const [call, setCall] = useState("người thân");
  const [from, setFrom] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);
  const [result, setResult] = useState<SendRes | null>(null);
  const [data, setData] = useState<ListRes | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    const r = await fetch("/api/loi-nhan", { cache: "no-store" }).catch(() => null);
    if (r?.ok) setData((await r.json()) as ListRes);
  }, []);

  useEffect(() => {
    setFrom(localStorage.getItem("oalpha-from") ?? "");
    void fetch("/api/tong-quan", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { call?: string }) => j.call && setCall(j.call))
      .catch(() => undefined);
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  async function post(previewOnly: boolean) {
    if (!text.trim()) return;
    setBusy(previewOnly ? "preview" : "send");
    if (!previewOnly) setResult(null);
    localStorage.setItem("oalpha-from", from.trim());
    try {
      const res = await fetch("/api/loi-nhan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: from.trim(), text: text.trim(), preview: previewOnly }),
      });
      const j = (await res.json()) as SendRes & { text?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (previewOnly) setPreview(j.text ?? null);
      else {
        setResult(j);
        setPreview(j.spoken?.text ?? null);
        if (j.spoken?.status === "da-gui") setText("");
        void load();
      }
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  const templates = useMemo(
    () => [
      `${capFirst(call)} ơi, 10h con gọi về nha`,
      `${capFirst(call)} nhớ uống thuốc buổi tối nhé`,
      `Chiều nay con ghé thăm ${call} nhé`,
    ],
    [call],
  );

  const items = (data?.items ?? []).filter((m) => filter === "all" || m.kind === filter || (filter === "hoi" && m.kind === "lenh"));
  const groups: { day: string; list: Interaction[] }[] = [];
  for (const m of items) {
    const d = dayVN(m.at);
    if (groups[groups.length - 1]?.day !== d) groups.push({ day: d, list: [] });
    groups[groups.length - 1].list.push(m);
  }
  const bot = data?.bot;
  const botState = bot ? (BOT_STATE[bot.state] ?? { text: bot.state, tone: "" }) : null;
  const sentOk = result?.spoken?.status === "da-gui";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Gửi lời nhắn qua loa</h1>
          <p className="sub">
            Loa trong phòng sẽ phát tiếng “ting tong” rồi đọc lời nhắn cho {call} nghe. Trợ lý AI chỉnh câu
            cho dễ nghe nhưng giữ nguyên nội dung, giờ giấc.
          </p>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Soạn lời nhắn</h2>
          <label className="field">
            <span>Tên người gửi (loa sẽ đọc tên này)</span>
            <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Ví dụ: Tuấn" maxLength={40} />
          </label>
          <label className="field">
            <span>Lời nhắn</span>
            <textarea
              className="compose"
              value={text}
              maxLength={500}
              onChange={(e) => { setText(e.target.value); setPreview(null); }}
              placeholder={`Ví dụ: ${call} ơi, 10h con gọi về nha`}
            />
          </label>
          <div className="suggest" style={{ padding: "0 0 12px", border: 0 }}>
            {templates.map((t) => (
              <button key={t} type="button" className="suggest-chip" onClick={() => { setText(t); setPreview(null); }}>
                {t}
              </button>
            ))}
          </div>
          <div className="btns">
            <button className="b-gray" onClick={() => void post(true)} disabled={!text.trim() || busy !== null}>
              {busy === "preview" ? "Đang soạn…" : "Xem trước câu loa đọc"}
            </button>
            <button className="b-main" onClick={() => void post(false)} disabled={!text.trim() || busy !== null}>
              {busy === "send" ? "Đang gửi xuống loa…" : "🔊 Gửi xuống loa"}
            </button>
          </div>
          {preview && (
            <div className="preview-box">
              <span className="lbl">Loa sẽ đọc</span>
              <p>“{preview}”</p>
              <button
                type="button"
                className="linkish"
                style={{ marginTop: 8 }}
                onClick={() => void new Audio(`/api/tts?text=${encodeURIComponent(preview)}`).play().catch(() => undefined)}
              >
                ▶ Nghe thử trên máy tính
              </button>
            </div>
          )}
          {result?.error && <div className="badbox" style={{ marginTop: 12 }}>{result.error}</div>}
          {result?.reply && (
            <div className={sentOk ? "okbox" : "warnbox"} style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
              {result.reply.split("\n")[0]}
              {result.spoken?.seconds ? ` (khoảng ${Math.round(result.spoken.seconds)} giây)` : ""}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Nhắn qua Telegram</h2>
            {botState && <span className={`st-pill ${botState.tone}`}>{botState.text}</span>}
          </div>
          <ol className="howto">
            <li>Mở chat với bot{bot?.botName ? <> <b>{bot.botName}</b></> : ""} trên Telegram.</li>
            <li>
              Gõ <code className="cmd">/hoitham {call} ơi, 10h con gọi về nha</code>
            </li>
            <li>Loa đọc xong, bot nhắn lại câu đã đọc để anh/chị yên tâm.</li>
          </ol>
          <div className="sub" style={{ marginTop: 10 }}>
            Hỏi tự nhiên “Hôm nay {call} thế nào?” thì bot trả lời bằng dữ liệu radar. Trong nhóm gia đình dùng{" "}
            <code className="cmd">/hoi &lt;câu hỏi&gt;</code>.
          </div>
          {bot?.detail && bot.state !== "dang-doc" && (
            <div className="warnbox" style={{ marginTop: 12, marginBottom: 0 }}>{bot.detail}</div>
          )}
          {bot && (
            <div className="sub" style={{ marginTop: 10 }}>
              Chat được phép: {bot.allowedChats.length ? bot.allowedChats.join(", ") : "chưa khai"} · đã xử lý{" "}
              {bot.handled} tin từ lúc bật máy chủ.
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>Nhật ký hỏi thăm</h2>
          <div className="tabs" role="tablist" aria-label="Lọc nhật ký">
            {FILTERS.map((f) => (
              <button key={f.id} role="tab" aria-selected={filter === f.id} className={`tab${filter === f.id ? " on" : ""}`} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {groups.length === 0 && <div className="empty">Chưa có lượt hỏi thăm nào.</div>}
        {groups.map((g) => (
          <div key={g.day}>
            <div className="day-head">{g.day}</div>
            {g.list.map((m) => (
              <div className="msg-item" key={m.id}>
                <div className="msg-meta">
                  <span className="st-pill navy">{CHANNEL_LABEL[m.channel]}</span>
                  <b>{m.from}</b> · {hm(m.at)}
                  {m.speak && <span className={`st-pill ${SPEAK_LABEL[m.speak].tone}`}>{SPEAK_LABEL[m.speak].text}</span>}
                  {m.kind === "hoitham" && <span className="st-pill navy">🔊 Lời nhắn qua loa</span>}
                  {m.kind === "tu-choi" && <span className="st-pill bad">Chat chưa được phép · {m.chatId}</span>}
                  {m.ai && <span className="st-pill">AI</span>}
                </div>
                <div className="msg-said">{m.kind === "hoitham" ? withoutCommand(m.text) : m.text}</div>
                {m.spokenText && <div className="msg-said spoken">🔊 {m.spokenText}</div>}
                {!m.spokenText && m.kind !== "tu-choi" && <div className="reply-text">↳ {m.reply}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
