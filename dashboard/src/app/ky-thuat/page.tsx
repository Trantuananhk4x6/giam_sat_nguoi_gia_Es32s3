"use client";

import { useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import EventTable from "@/components/EventTable";
import { sendAction, useLive } from "@/components/useLive";
import { Ic } from "@/components/Icon";
import { hhmmss, heroClass, movementText } from "@/lib/format";

/** Trang kỹ thuật (trước đây là trang chủ): số liệu thô của radar, mạng, thiết bị. */
export default function KyThuatPage() {
  const { data, netError, refresh } = useLive(1500);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [vitalsAI, setVitalsAI] = useState<string | null>(null);
  const [vitalsAIErr, setVitalsAIErr] = useState<string | null>(null);
  const [vitalsBusy, setVitalsBusy] = useState(false);

  async function run(name: string, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(name);
    setActionError(await sendAction(name));
    setBusy(null);
    await refresh();
  }

  async function analyseVitals() {
    setVitalsBusy(true);
    setVitalsAIErr(null);
    setVitalsAI(null);
    try {
      const res = await fetch("/api/phan-tich-sinh-hieu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vitals: st?.vitals ?? {} }),
      });
      const json = (await res.json()) as { text?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setVitalsAI(json.text ?? "");
    } catch (e) {
      setVitalsAIErr(e instanceof Error ? e.message : String(e));
    } finally {
      setVitalsBusy(false);
    }
  }

  const st = data?.status ?? null;
  const series = (data?.movementSeries ?? []).map((p) => ({
    t: new Date(p.t).toLocaleTimeString("vi-VN", { minute: "2-digit", second: "2-digit" }),
    range: p.range,
    present: p.present * 100,
  }));

  // Chuỗi sinh hiệu theo thời gian (chỉ có dữ liệu khi đang bật chế độ theo dõi giấc ngủ)
  const vitalsSeries = (data?.vitalsSeries ?? []).map((p) => ({
    t: new Date(p.t).toLocaleTimeString("vi-VN", { minute: "2-digit", second: "2-digit" }),
    heartRate: p.heartRate,
    breatheValue: p.breatheValue,
  }));

  return (
    <>
      <h1>Giám sát thiết bị</h1>
      <p className="sub">
        Trang kỹ thuật cho người làm đồ án: số liệu thô của radar, mạng và công cụ thử.
        Người nhà xem trang <a href="/">Tổng quan</a> cho dễ hiểu hơn.{" "}
        Dữ liệu do máy chủ dashboard hỏi ESP32 mỗi {(data?.settings.pollMs ?? 1500) / 1000} giây.
        Đã lưu {data?.storedEventCount ?? 0} sự kiện vào máy tính — nhiều hơn 40 dòng mà bộ nhớ
        flash của ESP32 giữ được.
      </p>

      {netError && (
        <div className="badbox">Không gọi được máy chủ dashboard: {netError}</div>
      )}
      {data && !data.online && (
        <div className="badbox">
          <b>Chưa liên lạc được với ESP32.</b> {data.error}
        </div>
      )}
      {actionError && <div className="warnbox">{actionError}</div>}
      {st?.simulate && (
        <div className="warnbox">
          Firmware đang chạy <b>CHẾ ĐỘ MÔ PHỎNG RADAR</b> (SIMULATE_RADAR = true). Số liệu
          phát hiện té ngã lúc này không dùng được cho báo cáo.
        </div>
      )}

      <div className="grid">
        {/* ------------------------------- Thẻ trạng thái lớn ------------------ */}
        <div className={`card hero full ${heroClass(st?.state)}`}>
          <div>
            <div className="sub">Trạng thái hệ thống</div>
            <div className="state">{st?.stateVi ?? "Đang kết nối…"}</div>
            <div className="sub">
              {st ? `Đã ở trạng thái này ${hhmmss(st.stateAge)}` : "—"}
              {st && st.cooldown > 0 && ` · đang nghỉ ${st.cooldown}s (bỏ qua báo ngã mới)`}
              {st?.voice && " · loa đang phát"}
            </div>
          </div>

          {st?.state === "NGHI_NGO_TE_NGA" && (
            <div style={{ textAlign: "center" }}>
              <div className="count">{st.countdown}</div>
              <div className="sub">giây còn lại để bấm “Tôi ổn”</div>
            </div>
          )}

          <div style={{ flex: 1 }} />
          <div className="btns">
            <button
              className="big b-ok"
              disabled={!data?.online || busy !== null}
              onClick={() => run("iamok")}
            >
              TÔI ỔN
            </button>
            <button
              className="big b-sos"
              disabled={!data?.online || busy !== null}
              onClick={() => run("sos", "Gửi cảnh báo khẩn cấp cho người thân ngay?")}
            >
              SOS
            </button>
          </div>
        </div>

        {/* ------------------------------------------ Radar ------------------- */}
        <div className="card">
          <h2>Mô-đun radar 60 GHz</h2>
          <div className="row">
            <span>Liên lạc</span>
            <b style={{ color: st?.radar.online ? "var(--ok)" : "var(--bad)" }}>
              {st ? (st.radar.online ? "Bình thường" : "MẤT LIÊN LẠC") : "—"}
            </b>
          </div>
          <div className="row">
            <span>Trong phòng</span>
            <b>{st ? (st.radar.present ? "Có người" : "Không có người") : "—"}</b>
          </div>
          <div className="row">
            <span>Chuyển động</span>
            <b>{st ? movementText(st.radar.movement) : "—"}</b>
          </div>
          <div className="row">
            <span>Biên độ (0–100)</span>
            <b>{st?.radar.range ?? "—"}</b>
          </div>
          <div className="row">
            <span>Khoảng cách</span>
            <b>{st?.radar.distance ? `${(st.radar.distance / 100).toFixed(2)} m` : "—"}</b>
          </div>
          <div className="row">
            <span>Cờ té ngã</span>
            <b style={{ color: st?.radar.fall ? "var(--bad)" : undefined }}>
              {st ? (st.radar.fall ? "ĐANG BÁO NGÃ" : "Bình thường") : "—"}
            </b>
          </div>
          <div className="row">
            <span>Nằm im một chỗ</span>
            <b>{st ? (st.radar.static ? "Có" : "Không") : "—"}</b>
          </div>
          <div className="row">
            <span>Số lần báo ngã / lỗi đọc</span>
            <b>
              {st ? `${st.radar.falls} / ${st.radar.errors}` : "—"}
            </b>
          </div>
        </div>

        {/* ----------------------------------- Mạng & Telegram ---------------- */}
        <div className="card">
          <h2>Mạng &amp; Telegram</h2>
          <div className="row">
            <span>Wi-Fi của ESP32</span>
            <b style={{ color: st?.wifi.up ? "var(--ok)" : "var(--bad)" }}>
              {st ? (st.wifi.up ? "Đã kết nối" : "Mất kết nối") : "—"}
            </b>
          </div>
          <div className="row">
            <span>Tên mạng</span>
            <b>{st?.wifi.ssid ?? "—"}</b>
          </div>
          <div className="row">
            <span>Cường độ</span>
            <b>{st?.wifi.up ? `${st.wifi.rssi} dBm` : "—"}</b>
          </div>
          <div className="row">
            <span>Địa chỉ IP</span>
            <b>{st?.wifi.ip ?? "—"}</b>
          </div>
          <div className="row">
            <span>Tin đã gửi / đang chờ</span>
            <b>{st ? `${st.telegram.sent} / ${st.telegram.pending}` : "—"}</b>
          </div>
          <div className="row">
            <span>Kết quả gửi gần nhất</span>
            <b>{st?.telegram.last ?? "—"}</b>
          </div>
          <div className="row">
            <span>Trễ cảnh báo lần gần nhất</span>
            <b>{st?.latencyMs ? `${(st.latencyMs / 1000).toFixed(1)} s` : "—"}</b>
          </div>
        </div>

        {/* ------------------------------------------ Thiết bị ---------------- */}
        <div className="card">
          <h2>Thiết bị</h2>
          <div className="row">
            <span>Người được giám sát</span>
            <b>{st?.device.name ?? "—"}</b>
          </div>
          <div className="row">
            <span>Vị trí</span>
            <b>{st?.device.place ?? "—"}</b>
          </div>
          <div className="row">
            <span>Giờ trên thiết bị</span>
            <b>{st?.device.clock ?? "—"}</b>
          </div>
          <div className="row">
            <span>Thời gian chạy</span>
            <b>{st ? hhmmss(st.device.uptimeS) : "—"}</b>
          </div>
          <div className="row">
            <span>RAM trống</span>
            <b>{st ? `${Math.round(st.device.heap / 1024)} KB` : "—"}</b>
          </div>
          <div className="row">
            <span>Số lần nghi ngờ / cảnh báo</span>
            <b>{st ? `${st.stats.suspects} / ${st.stats.emergency}` : "—"}</b>
          </div>
          <div className="row">
            <span>Bấm “Tôi ổn” / SOS</span>
            <b>{st ? `${st.stats.cancelled} / ${st.stats.sos}` : "—"}</b>
          </div>
        </div>

        {/* ----------------------- Chế độ radar & sinh hiệu ------------------- */}
        {st?.mode?.enabled && (
          <div className="card">
            <h2>Chế độ radar &amp; sinh hiệu</h2>
            <div className="row">
              <span>Chế độ đang chạy</span>
              <b style={{ color: st.mode.code === "DANG_DOI_CHE_DO" ? "var(--warn)" : undefined }}>
                {st.mode.vi}
              </b>
            </div>
            <div className="row">
              <span>Đã ở chế độ này</span>
              <b>{hhmmss(st.mode.sinceS)}</b>
            </div>
            <div className="row">
              <span>Số lần đổi chế độ</span>
              <b>{st.mode.switches}</b>
            </div>
            <div className="row">
              <span>Tổng thời gian “mù”</span>
              <b style={{ color: st.mode.blindMs > 0 ? "var(--warn)" : undefined }}>
                {(st.mode.blindMs / 1000).toFixed(1)} giây
              </b>
            </div>
            <div className="row">
              <span>Trên giường</span>
              <b>{st.vitals?.valid ? (st.vitals.inBed ? "Có" : "Không") : "—"}</b>
            </div>
            <div className="row">
              <span>Nhịp tim (ước lượng)</span>
              <b>{st.vitals?.heartRate ? `${st.vitals.heartRate} nhịp/phút` : "—"}</b>
            </div>
            <div className="row">
              <span>Nhịp thở (ước lượng)</span>
              <b>{st.vitals?.breatheValue ? `${st.vitals.breatheValue} lần/phút` : "—"}</b>
            </div>
            <div className="row">
              <span>Trạng thái giấc ngủ</span>
              <b>
                {st.vitals?.valid
                  ? (["Ngủ sâu", "Ngủ nông", "Tỉnh", "Không có người"][st.vitals.sleepState] ?? "—")
                  : "—"}
              </b>
            </div>
            <div className="row">
              <span>Vùng vẫy bất thường</span>
              <b style={{ color: st.vitals?.struggle ? "var(--bad)" : undefined }}>
                {st.vitals?.valid ? (st.vitals.struggle ? "CÓ" : "Không") : "—"}
              </b>
            </div>
            <div className="sub" style={{ marginTop: 8 }}>
              Nhịp tim và nhịp thở là <b>ước lượng bằng sóng radar, không phải thiết bị y
              tế</b>. Trong lúc đo sinh hiệu, mô-đun <b>không phát hiện được té ngã</b> —
              cột “thời gian mù” là con số nên đưa vào phần hạn chế của báo cáo.
            </div>
          </div>
        )}

        {/* -------------------- Đồ thị nhịp tim & nhịp thở -------------------- */}
        {st?.mode?.enabled && (
          <div className="card full">
            <h2>Nhịp tim &amp; nhịp thở theo thời gian</h2>
            <div style={{ width: "100%", height: 190 }}>
              <ResponsiveContainer>
                <LineChart data={vitalsSeries} margin={{ top: 6, right: 10, bottom: 0, left: -18 }}>
                  <XAxis dataKey="t" tick={{ fill: "#9aa4b6", fontSize: 11 }} minTickGap={40} />
                  <YAxis tick={{ fill: "#9aa4b6", fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      background: "#ffffff",
                      border: "1px solid #e6eaf2",
                      borderRadius: 10,
                      color: "#1f2733",
                      boxShadow: "0 6px 20px rgba(22,34,64,.12)",
                    }}
                    formatter={(value: unknown, name: unknown): [string, string] =>
                      name === "heartRate"
                        ? [`${Number(value)} nhịp/phút`, "Nhịp tim"]
                        : [`${Number(value)} lần/phút`, "Nhịp thở"]
                    }
                  />
                  <Line
                    type="monotone"
                    dataKey="heartRate"
                    stroke="#e23d4b"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="breatheValue"
                    stroke="#2563eb"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="sub">
              Đường đỏ: nhịp tim (nhịp/phút). Đường xanh dương: nhịp thở (lần/phút).
              Đây là <b>ước lượng bằng radar, không phải thiết bị y tế</b> — chỉ nên dùng
              để theo dõi xu hướng, không dùng để chẩn đoán bệnh.
            </div>
          </div>
        )}

        {/* --------------------- AI phân tích sinh hiệu (Groq) --------------- */}
        {st?.mode?.enabled && (
          <div className="card full">
            <h2>AI nhận xét nhịp tim &amp; nhịp thở</h2>
            <p className="sub" style={{ marginTop: 0 }}>
              Nhờ mô hình ngôn ngữ (Groq/Llama) diễn giải các số sinh hiệu ước lượng thành
              vài câu dễ hiểu cho người nhà. <b>Chỉ gửi các con số</b>, không gửi tên hay
              thông tin đời tư.
            </p>
            <div className="btns">
              <button className="b-main" onClick={() => void analyseVitals()} disabled={vitalsBusy}>
                {vitalsBusy ? "Đang phân tích…" : "Nhờ AI nhận xét"}
              </button>
              {vitalsAI && (
                <button className="b-gray" onClick={() => void navigator.clipboard.writeText(vitalsAI)}>
                  Copy
                </button>
              )}
            </div>
            {vitalsAIErr && (
              <div className="badbox" style={{ marginTop: 12 }}>{vitalsAIErr}</div>
            )}
            {vitalsAI && (
              <div className="okbox" style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{vitalsAI}</div>
            )}
            <div className="sub" style={{ marginTop: 10 }}>
              <Ic name="warning" size={14} /> Đây là <b>ước lượng bằng radar</b>, không phải thiết bị y tế. AI chỉ nhận xét
              xu hướng, <b>không chẩn đoán bệnh</b>. Cần khai <code>GROQ_API_KEY</code> trong{" "}
              <code>dashboard/.env.local</code> (lấy miễn phí ở console.groq.com/keys).
            </div>
          </div>
        )}

        {/* --------------------------- Nút SOS đeo tay ----------------------- */}
        {st?.remote?.enabled && (
          <div className="card">
            <h2>Nút SOS đeo tay (433 MHz)</h2>
            <div className="row">
              <span>Số lần bấm hợp lệ</span>
              <b>{st.remote.presses}</b>
            </div>
            <div className="row">
              <span>Mã lạ đã bỏ qua</span>
              <b>{st.remote.rejected}</b>
            </div>
            <div className="row">
              <span>Mã nhận gần nhất</span>
              <b>{st.remote.lastCode || "—"}</b>
            </div>
            <div className="sub" style={{ marginTop: 8 }}>
              Lúc mới lắp, để <code>RF_REMOTE_CODE_1 = 0</code> trong{" "}
              <code>secrets.h</code>, bấm nút của bạn rồi lấy “mã nhận gần nhất” ở trên
              dán vào đó. Từ đó remote của nhà bên cạnh bấm cũng không kích được hệ thống.
            </div>
          </div>
        )}

        {/* ------------------------------- Đồ thị chuyển động ----------------- */}
        <div className="card full">
          <h2>Biên độ chuyển động theo thời gian</h2>
          <div style={{ width: "100%", height: 190 }}>
            <ResponsiveContainer>
              <LineChart data={series} margin={{ top: 6, right: 10, bottom: 0, left: -18 }}>
                <XAxis dataKey="t" tick={{ fill: "#9aa4b6", fontSize: 11 }} minTickGap={40} />
                <YAxis domain={[0, 100]} tick={{ fill: "#9aa4b6", fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    background: "#ffffff",
                    border: "1px solid #e6eaf2",
                    borderRadius: 10,
                    color: "#1f2733",
                    boxShadow: "0 6px 20px rgba(22,34,64,.12)",
                  }}
                  formatter={(value: unknown, name: unknown): [string, string] =>
                    name === "present"
                      ? [Number(value) > 0 ? "Có người" : "Không", "Hiện diện"]
                      : [String(value), "Biên độ"]
                  }
                />
                <Line
                  type="monotone"
                  dataKey="present"
                  stroke="#17a673"
                  strokeWidth={1}
                  dot={false}
                  strokeDasharray="4 4"
                />
                <Line type="monotone" dataKey="range" stroke="#2563eb" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="sub">
            Đường xanh dương: biên độ chuyển động radar đo được (0–100). Đường xanh lá nét đứt:
            có người trong phòng hay không.
          </div>
        </div>

        {/* ------------------------------------- Công cụ thử ------------------ */}
        <div className="card full">
          <h2>Công cụ thử nghiệm</h2>
          <div className="btns">
            <button className="b-gray" disabled={!data?.online} onClick={() => run("simfall")}>
              Mô phỏng té ngã
            </button>
            <button className="b-gray" disabled={!data?.online} onClick={() => run("present_on")}>
              Giả lập có người
            </button>
            <button className="b-gray" disabled={!data?.online} onClick={() => run("present_off")}>
              Giả lập không người
            </button>
            <button className="b-gray" disabled={!data?.online} onClick={() => run("testvoice")}>
              Thử loa
            </button>
            <button className="b-gray" disabled={!data?.online} onClick={() => run("testtg")}>
              Gửi Telegram thử
            </button>
            <button className="b-gray" onClick={() => location.assign("/api/export?kind=events")}>
              Tải nhật ký Excel
            </button>
          </div>
        </div>

        {/* ----------------------------------------- Nhật ký ------------------ */}
        <div className="card full">
          <h2>Nhật ký sự kiện (lưu trên máy tính)</h2>
          <EventTable events={data?.events ?? []} limit={40} />
        </div>
      </div>
    </>
  );
}
