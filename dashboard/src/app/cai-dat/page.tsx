"use client";

import { useEffect, useState } from "react";
import type { Settings, TelegramBotInfo, ZaloBotInfo } from "@/lib/types";

type ZaloRes = ZaloBotInfo & { firmwareOnline: boolean; firmwareChats: number | null; firmwarePoller: string | null };
type SettingsRes = Settings & { bot: TelegramBotInfo; zalo?: ZaloRes; voices: Record<string, string> };

/** Thiết bị (firmware) có tự gửi cảnh báo qua Zalo không, nói bằng lời thường */
function firmwareZaloText(z: ZaloRes | undefined): string {
  if (!z || !z.firmwareOnline) return "chưa liên lạc được thiết bị";
  if (z.firmwarePoller === null) return "firmware chưa hỗ trợ Zalo — nạp firmware mới";
  if ((z.firmwareChats ?? 0) > 0) return `${z.firmwareChats} người`;
  if (z.firmwarePoller === "off") return "chưa khai ZALO_BOT_TOKEN trong secrets.h";
  return "chưa khai ZALO_CHAT_ID trong secrets.h";
}

const BOT_STATE: Record<string, string> = {
  "dang-doc": "Đang trả lời tin nhắn",
  "cho-thiet-bi": "Đang chờ ESP32 nhường quyền",
  "firmware-cu": "Firmware ESP32 chưa hỗ trợ",
  "xung-dot": "Xung đột: nơi khác cũng đọc tin",
  "loi-token": "Sai token",
  "loi-mang": "Lỗi mạng",
  off: "Đang tắt",
};

export default function CaiDatPage() {
  const [s, setS] = useState<SettingsRes | null>(null);
  const [host, setHost] = useState("");
  const [pollMs, setPollMs] = useState("1500");
  const [elderCall, setElderCall] = useState("");
  const [voice, setVoice] = useState("vi-VN-HoaiMyNeural");
  const [tgOn, setTgOn] = useState(true);
  const [zlOn, setZlOn] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch("/api/settings", { cache: "no-store" });
    const j = (await res.json()) as SettingsRes;
    setS(j);
    return j;
  }

  useEffect(() => {
    void load().then((j) => {
      setHost(j.esp32Host);
      setPollMs(String(j.pollMs));
      setElderCall(j.elderCall ?? "");
      setVoice(j.ttsVoice ?? "vi-VN-HoaiMyNeural");
      setTgOn(j.telegramEnabled !== false);
      setZlOn(j.zaloEnabled !== false);
    });
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);

  async function save(patch: Partial<Settings>) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const j = (await res.json()) as { ok?: boolean; message?: string; error?: string };
    setMsg({ ok: Boolean(j.ok), text: j.message ?? j.error ?? "Đã lưu." });
    setBusy(false);
    void load();
  }

  const bot = s?.bot;
  const zalo = s?.zalo;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Cài đặt</h1>
          <p className="sub">Kết nối thiết bị, cách xưng hô, giọng đọc và bot Telegram / Zalo hai chiều.</p>
        </div>
      </div>
      {msg && <div className={msg.ok ? "okbox" : "badbox"}>{msg.text}</div>}

      <div className="grid-2col">
        <div className="card">
          <h2>Kết nối tới ESP32</h2>
          <label className="field">
            <span>Địa chỉ IP hoặc tên máy</span>
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50 hoặc canhbao-tenga.local" />
          </label>
          <label className="field">
            <span>Chu kỳ hỏi dữ liệu (ms, 500 – 10000)</span>
            <input type="number" min={500} max={10000} step={100} value={pollMs} onChange={(e) => setPollMs(e.target.value)} />
          </label>
          <button className="b-main" onClick={() => void save({ esp32Host: host, pollMs: Number(pollMs) })} disabled={busy}>
            {busy ? "Đang thử kết nối…" : "Lưu và thử kết nối"}
          </button>
          <div className="sub" style={{ marginTop: 10 }}>
            Địa chỉ IP được in ra cổng serial của ESP32 lúc khởi động. Nếu tên <code>.local</code> không chạy trên
            Windows thì dùng hẳn địa chỉ IP.
          </div>
        </div>

        <div className="card">
          <h2>Người được chăm sóc</h2>
          <label className="field">
            <span>Gia đình gọi người cao tuổi là</span>
            <input value={elderCall} onChange={(e) => setElderCall(e.target.value)} placeholder="mẹ, bà, ông… (trống = tự đoán)" maxLength={20} />
          </label>
          <label className="field">
            <span>Giọng đọc của loa và trang web</span>
            <select value={voice} onChange={(e) => setVoice(e.target.value)}>
              {Object.entries(s?.voices ?? { "vi-VN-HoaiMyNeural": "Hoài My (nữ)" }).map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          </label>
          <div className="btns">
            <button className="b-main" onClick={() => void save({ elderCall, ttsVoice: voice })} disabled={busy}>Lưu</button>
            <button
              className="b-gray"
              onClick={() => void new Audio(`/api/tts?voice=${voice}&text=${encodeURIComponent(`${elderCall || "Bà"} ơi, con chào ${elderCall || "bà"}. Hôm nay ${elderCall || "bà"} thấy trong người thế nào ạ?`)}`).play().catch(() => undefined)}
            >
              ▶ Nghe thử giọng
            </button>
          </div>
        </div>

        <div className="card full">
          <div className="card-head">
            <h2>Bot Telegram hai chiều</h2>
            {bot && <span className={`st-pill ${bot.state === "dang-doc" ? "ok" : bot.state === "off" ? "" : "warn"}`}>{BOT_STATE[bot.state] ?? bot.state}</span>}
          </div>
          <label className="toggle" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={tgOn} onChange={(e) => { setTgOn(e.target.checked); void save({ telegramEnabled: e.target.checked }); }} />
            Cho dashboard trả lời tin nhắn Telegram (AI + đọc lời nhắn ra loa)
          </label>
          <div className="row"><span>Bot</span><b>{bot?.botName ?? (bot?.configured ? "đang kết nối…" : "chưa khai token")}</b></div>
          <div className="row"><span>Chat được phép</span><b>{bot?.allowedChats.length ? bot.allowedChats.join(", ") : "chưa khai"}</b></div>
          <div className="row"><span>Tin đã xử lý (từ lúc bật máy chủ)</span><b>{bot?.handled ?? 0}</b></div>
          {bot?.detail && <div className="sub" style={{ marginTop: 8 }}>{bot.detail}</div>}
          <div className="sub" style={{ marginTop: 12 }}>
            Khai trong <code>dashboard/.env.local</code>: <code>TELEGRAM_BOT_TOKEN</code> (cùng bot với firmware),{" "}
            <code>TELEGRAM_CHAT_ID</code> và nếu cần thêm người nhà thì <code>TELEGRAM_ALLOWED_CHAT_IDS=111,222</code>.
            Người lạ nhắn bot sẽ bị từ chối và được báo mã chat để anh/chị thêm vào nếu đúng là người nhà.
            Khi máy tính tắt, ESP32 tự trả lời Telegram như cũ (không có AI, lời nhắn phát bằng giọng thu sẵn).
          </div>
        </div>

        <div className="card full">
          <div className="card-head">
            <h2>Bot Zalo hai chiều</h2>
            {zalo && (
              <span className={`st-pill ${!zalo.configured || zalo.state === "off" ? "" : zalo.state === "dang-doc" ? "ok" : "warn"}`}>
                {zalo.configured ? (BOT_STATE[zalo.state] ?? zalo.state) : "Chưa cài"}
              </span>
            )}
          </div>
          <label className="toggle" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={zlOn} onChange={(e) => { setZlOn(e.target.checked); void save({ zaloEnabled: e.target.checked }); }} />
            Cho dashboard trả lời tin nhắn Zalo (AI + đọc lời nhắn ra loa)
          </label>
          <div className="row"><span>Bot</span><b>{zalo?.botName ?? (zalo?.configured ? "đang kết nối…" : "chưa khai token")}</b></div>
          <div className="row"><span>Chat được phép</span><b>{zalo?.allowedChats.length ? zalo.allowedChats.join(", ") : "chưa khai"}</b></div>
          <div className="row"><span>Thiết bị gửi cảnh báo Zalo tới</span><b>{firmwareZaloText(zalo)}</b></div>
          <div className="row"><span>Tin đã xử lý (từ lúc bật máy chủ)</span><b>{zalo?.handled ?? 0}</b></div>
          {zalo?.configured && zalo.detail && <div className="sub" style={{ marginTop: 8 }}>{zalo.detail}</div>}
          <ol className="howto" style={{ marginTop: 12 }}>
            <li>
              Trên điện thoại, mở Zalo, tìm <b>Zalo Bot Manager</b> rồi bấm <b>Tạo bot</b> (tên bot phải bắt đầu bằng
              “Bot”, ví dụ “Bot OALPHA”). Zalo nhắn <b>Bot Token</b> về chính tài khoản của anh/chị.
            </li>
            <li>
              Khai <code>ZALO_BOT_TOKEN</code> trong <code>dashboard/.env.local</code>, và trong <code>include/secrets.h</code>{" "}
              để thiết bị tự gửi cảnh báo qua Zalo. Khởi động lại dashboard, nạp lại firmware.
            </li>
            <li>
              Mỗi người nhà mở bot trên Zalo, nhắn một câu bất kỳ: bot trả lời kèm <b>mã chat</b>. Ghi các mã đó vào{" "}
              <code>ZALO_CHAT_ID</code> ở cả hai nơi (nhiều người cách nhau dấu phẩy).
            </li>
          </ol>
          <div className="sub" style={{ marginTop: 8 }}>
            Đây là Zalo Bot chính thức của Zalo, tạo bằng tài khoản Zalo cá nhân, miễn phí, không cần Zalo OA doanh
            nghiệp. Khi máy tính tắt, ESP32 tự trả lời Zalo như cũ (không có AI).
          </div>
        </div>

        <div className="card full">
          <h2>Lưu ý quan trọng khi bảo vệ</h2>
          <p className="sub" style={{ margin: 0 }}>
            Dashboard <b>không nằm trong đường đi của cảnh báo</b>. Khi phát hiện té ngã, chính ESP32 phát loa hỏi
            thăm và gửi Telegram / Zalo cho người thân — tắt laptop thì hệ thống an toàn vẫn chạy nguyên vẹn. Dashboard lo
            phần lưu lịch sử dài hạn, số liệu thực nghiệm và trợ lý AI cho người nhà. Dữ liệu lưu ở{" "}
            <code>dashboard/data/</code> (sao lưu bằng cách copy cả thư mục).
          </p>
        </div>
      </div>
    </>
  );
}
