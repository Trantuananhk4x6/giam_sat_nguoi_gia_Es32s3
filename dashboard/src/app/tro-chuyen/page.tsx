"use client";

/* ==========================================================================
   "Trò chuyện với trợ lý" — người nhà hỏi tình hình, trợ lý trả lời DỰA TRÊN
   DỮ LIỆU RADAR (cùng bộ não với bot Telegram, xem lib/family-bot.ts).
   - Gõ hoặc nói (Web Speech API, vi-VN) -> POST /api/assistant-chat.
   - Gõ "/hoitham <lời nhắn>" ngay trong khung chat thì loa trong phòng đọc lên.
   - Đọc to câu trả lời bằng giọng neural qua /api/tts (tắt sẵn, bật khi cần).
   ========================================================================== */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SPEAK_LABEL, capFirst } from "@/components/labels";
import { Ic } from "@/components/Icon";
import type { SpeakStatus } from "@/lib/types";

type Msg = {
  role: "user" | "assistant";
  content: string;
  ai?: boolean;
  speak?: SpeakStatus | null;
};
type ChatRes = { reply?: string; error?: string; ai?: boolean; spoken?: { status: SpeakStatus } | null };

const STORE_KEY = "oalpha-chat";

export default function TroChuyenPage() {
  const [call, setCall] = useState("người thân");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [sttOk, setSttOk] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Lấy cách xưng hô + khôi phục cuộc trò chuyện của phiên này
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORE_KEY);
      if (saved) setMessages(JSON.parse(saved) as Msg[]);
    } catch {
      /* bỏ qua */
    }
    void fetch("/api/tong-quan", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { call?: string }) => j.call && setCall(j.call))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-40)));
    } catch {
      /* bỏ qua */
    }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  const speak = useCallback((text: string) => {
    const el = audioRef.current;
    if (!el || !text.trim()) return;
    el.pause();
    el.src = "/api/tts?text=" + encodeURIComponent(text.slice(0, 900));
    void el.play().catch(() => undefined);
  }, []);

  const stopSpeaking = useCallback(() => {
    const el = audioRef.current;
    if (el) { el.pause(); el.currentTime = 0; }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || sending) return;
      setErr(null);
      stopSpeaking();
      const next: Msg[] = [...messages, { role: "user", content }];
      setMessages(next);
      setInput("");
      setSending(true);
      try {
        const res = await fetch("/api/assistant-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: next.slice(-20).map(({ role, content: c }) => ({ role, content: c })),
            // Tên đã nhập ở trang Gửi lời nhắn: loa đọc "con Tuấn nhắn" thay vì "người nhà nhắn"
            from: localStorage.getItem("oalpha-from") ?? "",
          }),
        });
        const data = (await res.json().catch(() => ({}))) as ChatRes;
        if (!res.ok || typeof data.reply !== "string") throw new Error(data.error ?? `HTTP ${res.status}`);
        setMessages((p) => [...p, { role: "assistant", content: data.reply!, ai: data.ai, speak: data.spoken?.status ?? null }]);
        if (autoSpeak) speak(data.reply);
      } catch (e) {
        setErr(`Không gửi được: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSending(false);
      }
    },
    [messages, sending, autoSpeak, speak, stopSpeaking],
  );

  // Nhận dạng giọng nói tiếng Việt của trình duyệt (Chrome/Edge)
  useEffect(() => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return;
    setSttOk(true);
    const rec = new Ctor();
    rec.lang = "vi-VN";
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (ev: SpeechRecognitionEvent) => {
      let t = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) t += ev.results[i][0].transcript;
      setInput(t);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recRef.current = rec;
    return () => {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      rec.abort();
    };
  }, []);

  function toggleMic() {
    const rec = recRef.current;
    if (!rec) return;
    if (listening) { rec.stop(); setListening(false); return; }
    setInput("");
    stopSpeaking();
    try { rec.start(); setListening(true); } catch { setListening(false); }
  }

  const suggestions = useMemo(
    () => [
      `Hôm nay ${call} thế nào?`,
      `${capFirst(call)} có đi lại nhiều không?`,
      "Hôm nay có lần nào nghi ngã không?",
      "/tinhhinh",
    ],
    [call],
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Trò chuyện với trợ lý</h1>
          <p className="sub">
            Hỏi về tình hình của {call}: trợ lý đọc dữ liệu radar trong phòng rồi trả lời. Gõ{" "}
            <b>/hoitham &lt;lời nhắn&gt;</b> để loa trong phòng đọc lời nhắn cho {call} nghe.
          </p>
        </div>
        <div className="btns">
          <button className="b-gray small" onClick={() => setMessages([])} disabled={sending || messages.length === 0}>
            Xóa cuộc trò chuyện
          </button>
        </div>
      </div>

      {err && <div className="badbox">{err}</div>}

      <div className="card chat-card">
        <div className="chat-list" ref={listRef} aria-live="polite">
          {messages.length === 0 && (
            <div className="chat-hello">
              <div className="chat-hello-ic" aria-hidden><Ic name="sparkle" size={26} strokeWidth={2.25} /></div>
              <b>Xin chào, em là trợ lý OALPHA.</b>
              <p>Anh/chị muốn biết gì về {call} hôm nay? Chọn một câu gợi ý bên dưới hoặc tự gõ câu hỏi.</p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`bubble-row ${m.role}`}>
              {m.role === "assistant" && <span className="bubble-ava" aria-hidden><Ic name="sparkle" size={16} strokeWidth={2.25} /></span>}
              <div className={`bubble ${m.role}`}>
                {m.content}
                {m.role === "assistant" && (
                  <div className="bubble-meta">
                    {m.speak && <span className={`st-pill ${SPEAK_LABEL[m.speak].tone}`}>{SPEAK_LABEL[m.speak].text}</span>}
                    <span>{m.ai ? "AI · dữ liệu radar" : "Tự động"}</span>
                    <button type="button" className="linkish" onClick={() => speak(m.content)}><Ic name="speaker" size={14} /> Nghe</button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {sending && (
            <div className="bubble-row assistant">
              <span className="bubble-ava" aria-hidden><Ic name="sparkle" size={16} strokeWidth={2.25} /></span>
              <div className="bubble assistant typing"><span /><span /><span /></div>
            </div>
          )}
        </div>

        <div className="suggest">
          {suggestions.map((s) => (
            <button key={s} type="button" className="suggest-chip" onClick={() => void send(s)} disabled={sending}>
              {s}
            </button>
          ))}
          <button type="button" className="suggest-chip gold" onClick={() => setInput(`/hoitham ${call} ơi, `)} disabled={sending}>
            <Ic name="speaker" size={15} /> Nhắn qua loa…
          </button>
        </div>

        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          {sttOk && (
            <button
              type="button"
              className={`mic${listening ? " on" : ""}`}
              onClick={toggleMic}
              aria-pressed={listening}
              aria-label={listening ? "Dừng nghe" : "Nói bằng giọng"}
              title={listening ? "Dừng nghe" : "Nói bằng giọng"}
            >
              {listening ? <Ic name="stop" size={18} /> : <Ic name="mic" size={18} />}
            </button>
          )}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={listening ? "Đang nghe… hãy nói" : `Ví dụ: Hôm nay ${call} thế nào?`}
            aria-label="Câu hỏi cho trợ lý"
            disabled={sending}
          />
          <button type="submit" className="b-main" disabled={!input.trim() || sending}>
            Gửi
          </button>
        </form>
        <div className="chat-foot">
          <label className="toggle">
            <input type="checkbox" checked={autoSpeak} onChange={(e) => setAutoSpeak(e.target.checked)} />
            Tự đọc to câu trả lời
          </label>
          <button type="button" className="linkish" onClick={stopSpeaking}><Ic name="pause" size={14} /> Dừng đọc</button>
          <span className="sub">
            Trợ lý không chẩn đoán bệnh. Cảnh báo té ngã vẫn do thiết bị tự gửi. Lịch sử:{" "}
            <Link href="/loi-nhan">Nhật ký hỏi thăm</Link>
          </span>
        </div>
        <audio ref={audioRef} hidden preload="none" />
      </div>
    </>
  );
}
