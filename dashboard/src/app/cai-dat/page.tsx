"use client";

import { useCallback, useEffect, useState } from "react";
import type { Contact, Delivery, RelayInfo, Settings, TelegramBotInfo, ZaloBotInfo } from "@/lib/types";
import type { RelayPlan } from "@/lib/relay";

type ZaloRes = ZaloBotInfo & { firmwareOnline: boolean; firmwareChats: number | null; firmwarePoller: string | null };
type ChannelsInfo = { telegram: boolean; zalo: boolean; email: boolean; emailFrom: string };
type SettingsRes = Settings & {
  bot: TelegramBotInfo;
  zalo?: ZaloRes;
  channels?: ChannelsInfo;
  voices: Record<string, string>;
};
type ContactsRes = {
  contacts: Contact[];
  channels: ChannelsInfo;
  relayLabel: string;
};

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

const RELAY_STATUS_LABEL: Record<string, { text: string; tone: string }> = {
  "da-gui": { text: "Đã gửi thành công", tone: "ok" },
  "gui-mot-phan": { text: "Gửi một phần (có kênh lỗi)", tone: "warn" },
  loi: { text: "Gửi thất bại", tone: "bad" },
  "khong-co-ten": { text: "Chưa có tên trong danh bạ", tone: "warn" },
  "trung-ten": { text: "Trùng tên nhiều người", tone: "warn" },
  "thieu-loi-nhan": { text: "Thiếu nội dung lời nhắn", tone: "warn" },
  "chua-co-kenh": { text: "Người nhận chưa có kênh liên lạc", tone: "warn" },
  "qua-nhieu": { text: "Tạm chặn chống gửi dồn dập", tone: "warn" },
};

export default function CaiDatPage() {
  const [s, setS] = useState<SettingsRes | null>(null);
  const [host, setHost] = useState("");
  const [pollMs, setPollMs] = useState("1500");
  const [elderCall, setElderCall] = useState("");
  const [relayLabel, setRelayLabel] = useState("Người thân");
  const [voice, setVoice] = useState("vi-VN-HoaiMyNeural");
  const [tgOn, setTgOn] = useState(true);
  const [zlOn, setZlOn] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Danh bạ người nhà & Voice Relay
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [channels, setChannels] = useState<ChannelsInfo | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [cName, setCName] = useState("");
  const [cAliases, setCAliases] = useState("");
  const [cTg, setCTg] = useState("");
  const [cZalo, setCZalo] = useState("");
  const [cEmail, setCEmail] = useState("");
  const [cBusy, setCBusy] = useState(false);
  const [cMsg, setCMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testResult, setTestResult] = useState<{ contactName: string; delivery: Delivery[] } | null>(null);

  // Gửi thử câu lệnh giọng nói của người cao tuổi
  const [voiceCmd, setVoiceCmd] = useState("");
  const [voiceBusy, setVoiceBusy] = useState<"plan" | "relay" | null>(null);
  const [planOut, setPlanOut] = useState<{ isRelayCommand: boolean; plan: RelayPlan | null } | null>(null);
  const [relayOut, setRelayOut] = useState<{
    ok: boolean;
    isRelayCommand: boolean;
    reply?: string;
    relay?: RelayInfo;
    ai?: boolean;
    error?: string;
  } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings", { cache: "no-store" });
    const j = (await res.json()) as SettingsRes;
    setS(j);
    if (j.channels) setChannels(j.channels);
    return j;
  }, []);

  const loadContacts = useCallback(async () => {
    const res = await fetch("/api/contacts", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const j = (await res.json()) as ContactsRes;
    setContacts(j.contacts ?? []);
    setChannels(j.channels);
  }, []);

  useEffect(() => {
    void load().then((j) => {
      setHost(j.esp32Host);
      setPollMs(String(j.pollMs));
      setElderCall(j.elderCall ?? "");
      setRelayLabel(j.relayLabel ?? "Người thân");
      setVoice(j.ttsVoice ?? "vi-VN-HoaiMyNeural");
      setTgOn(j.telegramEnabled !== false);
      setZlOn(j.zaloEnabled !== false);
    });
    void loadContacts();
    const t = setInterval(() => {
      void load();
    }, 5000);
    return () => clearInterval(t);
  }, [load, loadContacts]);

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

  function resetContactForm() {
    setEditingId(null);
    setCName("");
    setCAliases("");
    setCTg("");
    setCZalo("");
    setCEmail("");
  }

  function startEditContact(c: Contact) {
    setEditingId(c.id);
    setCName(c.name);
    setCAliases(c.aliases.join(", "));
    setCTg(c.telegramChatId);
    setCZalo(c.zaloChatId);
    setCEmail(c.email);
    setCMsg(null);
  }

  async function saveContactForm() {
    if (!cName.trim()) {
      setCMsg({ ok: false, text: "Vui lòng nhập tên gọi của người nhà (ví dụ: Tuấn, Lan)." });
      return;
    }
    setCBusy(true);
    setCMsg(null);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          id: editingId ?? undefined,
          name: cName.trim(),
          aliases: cAliases,
          telegramChatId: cTg.trim(),
          zaloChatId: cZalo.trim(),
          email: cEmail.trim(),
        }),
      });
      const j = (await res.json()) as { ok?: boolean; contacts?: Contact[]; message?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (j.contacts) setContacts(j.contacts);
      setCMsg({ ok: true, text: j.message ?? "Đã lưu vào danh bạ." });
      resetContactForm();
    } catch (e) {
      setCMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setCBusy(false);
    }
  }

  async function removeContact(c: Contact) {
    if (!confirm(`Xóa "${c.name}" khỏi danh bạ người nhà?`)) return;
    setCBusy(true);
    setCMsg(null);
    try {
      const res = await fetch(`/api/contacts?id=${encodeURIComponent(c.id)}`, { method: "DELETE" });
      const j = (await res.json()) as { contacts?: Contact[]; message?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (j.contacts) setContacts(j.contacts);
      if (editingId === c.id) resetContactForm();
      setCMsg({ ok: true, text: j.message ?? `Đã xóa "${c.name}".` });
    } catch (e) {
      setCMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setCBusy(false);
    }
  }

  async function testContact(c: Contact) {
    setCBusy(true);
    setCMsg(null);
    setTestResult(null);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", contactId: c.id }),
      });
      const j = (await res.json()) as { ok?: boolean; delivery?: Delivery[]; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setTestResult({ contactName: c.name, delivery: j.delivery ?? [] });
    } catch (e) {
      setCMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setCBusy(false);
    }
  }

  async function runVoiceRelay(mode: "plan" | "relay") {
    if (!voiceCmd.trim()) return;
    setVoiceBusy(mode);
    if (mode === "plan") setPlanOut(null);
    else setRelayOut(null);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, text: voiceCmd.trim() }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      if (mode === "plan") {
        setPlanOut(j as { isRelayCommand: boolean; plan: RelayPlan | null });
      } else {
        setRelayOut(j as typeof relayOut);
      }
    } catch (e) {
      setRelayOut({
        ok: false,
        isRelayCommand: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setVoiceBusy(null);
    }
  }

  const bot = s?.bot;
  const zalo = s?.zalo;
  const sampleContactName = contacts[0]?.name ?? "Tuấn";
  const samplePhrases = [
    `Gửi cho ${sampleContactName} là tối nay gọi cho ${elderCall || "mẹ"} lúc 8h nhé`,
    `Con ơi nhắn giùm ${elderCall || "bà"} cho ${sampleContactName} chiều nay nhớ mua sữa nhé`,
    `Chuyển lời cho ${sampleContactName} là ${elderCall || "mẹ"} đã uống thuốc rồi`,
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Cài đặt</h1>
          <p className="sub">
            Kết nối thiết bị, cách xưng hô, giọng đọc, danh bạ người nhà (nhắn tin bằng giọng nói) và bot Telegram / Zalo hai chiều.
          </p>
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
          <h2>Người được chăm sóc &amp; Giọng đọc</h2>
          <label className="field">
            <span>Gia đình gọi người cao tuổi là</span>
            <input value={elderCall} onChange={(e) => setElderCall(e.target.value)} placeholder="mẹ, bà, ông… (trống = tự đoán)" maxLength={20} />
          </label>
          <label className="field">
            <span>Tên in trước lời nhắn khi ông/bà gửi tin cho người nhà</span>
            <input
              value={relayLabel}
              onChange={(e) => setRelayLabel(e.target.value)}
              placeholder="Người thân, Mẹ, Bà nội…"
              maxLength={40}
            />
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
            <button className="b-main" onClick={() => void save({ elderCall, relayLabel, ttsVoice: voice })} disabled={busy}>
              Lưu
            </button>
            <button
              className="b-gray"
              onClick={() =>
                void new Audio(
                  `/api/tts?voice=${voice}&text=${encodeURIComponent(
                    `${elderCall || "Bà"} ơi, con chào ${elderCall || "bà"}. Hôm nay ${elderCall || "bà"} thấy trong người thế nào ạ?`,
                  )}`,
                )
                  .play()
                  .catch(() => undefined)
              }
            >
              ▶ Nghe thử giọng
            </button>
          </div>
        </div>

        {/* ---------------- DANH BẠ NGƯỜI NHÀ & VOICE RELAY ---------------- */}
        <div className="card full" id="danh-ba">
          <div className="card-head">
            <div>
              <h2>Danh bạ người nhà — Ông/bà nhắn tin bằng giọng nói (Voice Relay)</h2>
              <p className="sub" style={{ margin: "4px 0 0" }}>
                Khi {elderCall || "ông/bà"} giữ nút xanh trên thiết bị và nói{" "}
                <b>“Gửi cho {sampleContactName} là tối nay gọi về cho {elderCall || "mẹ"} nhé”</b>, hệ thống giữ nguyên
                văn lời nhắn, gửi qua Telegram / Zalo / Email của người đó rồi đọc câu xác nhận ra loa.
              </p>
            </div>
            {channels && (
              <div className="btns">
                <span className={`st-pill ${channels.telegram ? "ok" : ""}`}>
                  Telegram {channels.telegram ? "Sẵn sàng" : "Chưa khai token"}
                </span>
                <span className={`st-pill ${channels.zalo ? "ok" : ""}`}>
                  Zalo {channels.zalo ? "Sẵn sàng" : "Chưa khai token"}
                </span>
                <span className={`st-pill ${channels.email ? "ok" : ""}`}>
                  Email {channels.email ? "Sẵn sàng" : "Chưa khai Resend"}
                </span>
              </div>
            )}
          </div>

          {cMsg && (
            <div className={cMsg.ok ? "okbox" : "badbox"} style={{ marginTop: 10 }}>
              {cMsg.text}
            </div>
          )}

          {testResult && (
            <div className="preview-box" style={{ marginBottom: 14 }}>
              <span className="lbl">Kết quả gửi tin thử tới {testResult.contactName}</span>
              <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                {testResult.delivery.map((d, i) => (
                  <div key={i} style={{ fontSize: 13.5 }}>
                    <span className={`st-pill ${d.ok ? "ok" : "bad"}`} style={{ marginRight: 8 }}>
                      {d.channel.toUpperCase()} · {d.ok ? "Đã gửi" : "Lỗi"}
                    </span>
                    <code>{d.target}</code>
                    {d.error && <span style={{ color: "var(--bad)", marginLeft: 8 }}>— {d.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid-2col" style={{ marginTop: 12 }}>
            {/* Cột 1: Danh sách liên hệ + Form thêm/sửa */}
            <div>
              <h3 style={{ fontSize: 14, margin: "0 0 10px", color: "var(--brand-2)" }}>
                Danh sách người nhận ({contacts.length})
              </h3>
              {contacts.length === 0 ? (
                <div className="empty" style={{ border: "1px dashed var(--line)", borderRadius: 12, marginBottom: 12 }}>
                  Danh bạ đang trống. Hãy thêm ít nhất một người nhà ở khung bên dưới để {elderCall || "ông/bà"} có thể
                  nhắn tin bằng giọng nói.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 10, marginBottom: 14 }}>
                  {contacts.map((c) => (
                    <div
                      key={c.id}
                      style={{
                        border: editingId === c.id ? "2px solid var(--brand)" : "1px solid var(--line)",
                        borderRadius: 14,
                        padding: "12px 14px",
                        background: "#fbfcff",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                        <div>
                          <b style={{ fontSize: 16, color: "var(--brand-2)" }}>{c.name}</b>
                          {c.aliases.length > 0 && (
                            <span className="sub" style={{ marginLeft: 8 }}>
                              (còn gọi: {c.aliases.join(", ")})
                            </span>
                          )}
                        </div>
                        <div className="btns" style={{ gap: 6 }}>
                          <button className="b-gray small" onClick={() => void testContact(c)} disabled={cBusy}>
                            Gửi thử
                          </button>
                          <button className="b-gray small" onClick={() => startEditContact(c)} disabled={cBusy}>
                            Sửa
                          </button>
                          <button className="b-gray small" onClick={() => void removeContact(c)} disabled={cBusy}>
                            Xóa
                          </button>
                        </div>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                        {c.telegramChatId ? (
                          <span className="st-pill navy">Telegram: {c.telegramChatId}</span>
                        ) : (
                          <span className="st-pill">Telegram: —</span>
                        )}
                        {c.zaloChatId ? (
                          <span className="st-pill navy">Zalo: {c.zaloChatId}</span>
                        ) : (
                          <span className="st-pill">Zalo: —</span>
                        )}
                        {c.email ? (
                          <span className="st-pill navy">Email: {c.email}</span>
                        ) : (
                          <span className="st-pill">Email: —</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div
                style={{
                  background: "var(--bg2)",
                  border: "1px solid var(--line)",
                  borderRadius: 14,
                  padding: 14,
                }}
              >
                <h3 style={{ fontSize: 14, margin: "0 0 10px", color: "var(--brand-2)" }}>
                  {editingId ? "Cập nhật người nhận" : "Thêm người nhà vào danh bạ"}
                </h3>
                <div className="inline">
                  <label className="field">
                    <span>Tên chính (khi nói “gửi cho …”)</span>
                    <input
                      value={cName}
                      onChange={(e) => setCName(e.target.value)}
                      placeholder="VD: Tuấn"
                      maxLength={40}
                    />
                  </label>
                  <label className="field">
                    <span>Cách gọi khác (cách nhau dấu phẩy)</span>
                    <input
                      value={cAliases}
                      onChange={(e) => setCAliases(e.target.value)}
                      placeholder="VD: con trai, anh Hai, thằng Tuấn"
                    />
                  </label>
                </div>
                <div className="inline">
                  <label className="field">
                    <span>Mã chat Telegram (Chat ID)</span>
                    <input
                      value={cTg}
                      onChange={(e) => setCTg(e.target.value)}
                      placeholder="VD: 123456789"
                    />
                  </label>
                  <label className="field">
                    <span>Mã chat Zalo Bot</span>
                    <input
                      value={cZalo}
                      onChange={(e) => setCZalo(e.target.value)}
                      placeholder="Mã do bot Zalo báo khi nhắn /chatid"
                    />
                  </label>
                </div>
                <label className="field">
                  <span>Địa chỉ Email nhận lời nhắn</span>
                  <input
                    type="email"
                    value={cEmail}
                    onChange={(e) => setCEmail(e.target.value)}
                    placeholder="VD: tuan@example.com"
                  />
                </label>
                <div className="btns">
                  <button className="b-main" onClick={() => void saveContactForm()} disabled={cBusy}>
                    {cBusy ? "Đang lưu…" : editingId ? "Lưu cập nhật" : "+ Thêm vào danh bạ"}
                  </button>
                  {editingId && (
                    <button className="b-gray" onClick={resetContactForm} disabled={cBusy}>
                      Hủy sửa
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Cột 2: Thử nghiệm câu lệnh giọng nói từ web */}
            <div
              style={{
                background: "linear-gradient(180deg, #f7f9ff 0%, #ffffff 100%)",
                border: "1px solid #d9e1f5",
                borderRadius: 14,
                padding: 16,
              }}
            >
              <h3 style={{ fontSize: 14, margin: "0 0 6px", color: "var(--brand-2)" }}>
                Thử câu lệnh giọng nói (Mô phỏng {elderCall || "ông/bà"} nói với thiết bị)
              </h3>
              <p className="sub" style={{ marginTop: 0 }}>
                Nhập thử câu {elderCall || "ông/bà"} nói vào mic ESP32 để kiểm tra bộ tách lệnh nguyên văn và gửi thật
                tới Telegram / Zalo / Email của người nhận.
              </p>

              <label className="field">
                <span>Câu nói của {elderCall || "ông/bà"}</span>
                <textarea
                  rows={3}
                  value={voiceCmd}
                  onChange={(e) => {
                    setVoiceCmd(e.target.value);
                    setPlanOut(null);
                    setRelayOut(null);
                  }}
                  placeholder={`Ví dụ: Gửi cho ${sampleContactName} là tối nay gọi cho ${elderCall || "mẹ"} lúc 8h nhé`}
                />
              </label>

              <div className="suggest" style={{ padding: "0 0 12px", border: 0 }}>
                {samplePhrases.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="suggest-chip"
                    onClick={() => {
                      setVoiceCmd(p);
                      setPlanOut(null);
                      setRelayOut(null);
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>

              <div className="btns">
                <button
                  className="b-gray"
                  onClick={() => void runVoiceRelay("plan")}
                  disabled={!voiceCmd.trim() || voiceBusy !== null}
                >
                  {voiceBusy === "plan" ? "Đang tách lệnh…" : "Xem trước (Chưa gửi)"}
                </button>
                <button
                  className="b-main"
                  onClick={() => void runVoiceRelay("relay")}
                  disabled={!voiceCmd.trim() || voiceBusy !== null}
                >
                  {voiceBusy === "relay" ? "Đang gửi tin…" : "Gửi thử & Nghe câu loa báo"}
                </button>
              </div>

              {planOut && (
                <div className="preview-box" style={{ marginTop: 12 }}>
                  <span className="lbl">
                    Kết quả phân tích {planOut.plan?.ai ? "(Có hỗ trợ AI)" : "(Tách bằng luật nguyên văn)"}
                  </span>
                  {!planOut.isRelayCommand || !planOut.plan ? (
                    <p style={{ fontSize: 14 }}>
                      Câu này <b>không phải lệnh gửi tin</b> — thiết bị sẽ chuyển sang trò chuyện với trợ lý AI.
                    </p>
                  ) : planOut.plan.parsed.kind === "ok" ? (
                    <div style={{ marginTop: 6, fontSize: 14.5 }}>
                      <div>
                        Người nhận: <b>{planOut.plan.parsed.contact.name}</b>
                      </div>
                      <div style={{ marginTop: 4 }}>
                        Tin sẽ gửi:{" "}
                        <code className="cmd">
                          {relayLabel || "Người thân"}: &ldquo;{planOut.plan.parsed.message}&rdquo;
                        </code>
                      </div>
                    </div>
                  ) : planOut.plan.parsed.kind === "unknown" ? (
                    <p style={{ fontSize: 14 }}>
                      Nhận ra lệnh gửi cho <b>{planOut.plan.parsed.name}</b> nhưng tên này <b>chưa có trong danh bạ</b>.
                    </p>
                  ) : planOut.plan.parsed.kind === "no-message" ? (
                    <p style={{ fontSize: 14 }}>
                      Nhận ra người nhận <b>{planOut.plan.parsed.contact.name}</b> nhưng chưa có nội dung lời nhắn.
                    </p>
                  ) : (
                    <p style={{ fontSize: 14 }}>
                      Trùng tên nhiều người trong danh bạ: <b>{planOut.plan.parsed.names.join(", ")}</b>.
                    </p>
                  )}
                </div>
              )}

              {relayOut && (
                <div
                  className={relayOut.ok ? "okbox" : relayOut.isRelayCommand ? "warnbox" : "badbox"}
                  style={{ marginTop: 12 }}
                >
                  {relayOut.error && <div>{relayOut.error}</div>}
                  {relayOut.reply && (
                    <div>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>
                        🔊 Câu loa ESP32 đọc lại cho {elderCall || "ông/bà"}:
                      </div>
                      <div style={{ fontSize: 15, marginBottom: 8 }}>&ldquo;{relayOut.reply}&rdquo;</div>
                      <button
                        type="button"
                        className="b-gray small"
                        onClick={() =>
                          void new Audio(
                            `/api/tts?voice=${voice}&text=${encodeURIComponent(relayOut.reply!)}`,
                          )
                            .play()
                            .catch(() => undefined)
                        }
                      >
                        ▶ Nghe câu xác nhận
                      </button>
                    </div>
                  )}
                  {relayOut.relay && (
                    <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(0,0,0,0.08)" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                        <span
                          className={`st-pill ${RELAY_STATUS_LABEL[relayOut.relay.status]?.tone ?? ""}`}
                        >
                          {RELAY_STATUS_LABEL[relayOut.relay.status]?.text ?? relayOut.relay.status}
                        </span>
                        {relayOut.relay.sent && <code>{relayOut.relay.sent}</code>}
                      </div>
                      {relayOut.relay.delivery.length > 0 && (
                        <div style={{ display: "grid", gap: 4, marginTop: 6, fontSize: 13 }}>
                          {relayOut.relay.delivery.map((d, idx) => (
                            <div key={idx}>
                              <b>{d.channel.toUpperCase()}</b> ({d.target}):{" "}
                              {d.ok ? "✓ Đã gửi" : `✗ ${d.error ?? "Lỗi"}`}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
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
