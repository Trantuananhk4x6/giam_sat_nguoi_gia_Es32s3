"use client";

import { useCallback, useEffect, useState } from "react";
import { useLive } from "@/components/useLive";
import { Ic } from "@/components/Icon";
import type { WifiSavedEntry, WifiScanEntry } from "@/lib/esp32";

/**
 * Trang "Wi-Fi thiết bị": cấu hình mạng Wi-Fi của ESP32 ngay trên dashboard.
 *
 * GIỚI HẠN QUAN TRỌNG: dashboard chỉ cấu hình được Wi-Fi KHI ESP32 đang online
 * (cùng mạng với máy chủ). Nếu thiết bị mất mạng hoàn toàn, máy chủ không với tới
 * được nó nên phải dùng Wi-Fi riêng do thiết bị phát (AP 192.168.4.1). Phần dưới
 * giải thích rõ điều này cho người dùng.
 */

/** Tên Wi-Fi do thiết bị phát khi ở chế độ cấu hình (khớp với firmware) */
const AP_SSID = "canhbao-tenga";
const AP_URL = "http://192.168.4.1";

type ErrorBody = { error?: string };

export default function WifiPage() {
  const { data, netError, refresh } = useLive(3000);

  const [saved, setSaved] = useState<WifiSavedEntry[]>([]);
  const [savedErr, setSavedErr] = useState<string | null>(null);
  const [savedBusy, setSavedBusy] = useState(false);

  const [scan, setScan] = useState<WifiScanEntry[] | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);

  const [ssid, setSsid] = useState("");
  const [pass, setPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [addOk, setAddOk] = useState<string | null>(null);

  const online = data?.online ?? false;
  const wifi = data?.status?.wifi ?? null;

  /** Tải lại danh sách mạng đã lưu từ firmware (qua máy chủ Next.js) */
  const loadSaved = useCallback(async () => {
    setSavedBusy(true);
    setSavedErr(null);
    try {
      const res = await fetch("/api/wifi/list", { cache: "no-store" });
      const json = (await res.json()) as WifiSavedEntry[] | ErrorBody;
      if (!res.ok) throw new Error((json as ErrorBody).error ?? `HTTP ${res.status}`);
      setSaved(json as WifiSavedEntry[]);
    } catch (err) {
      setSavedErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSavedBusy(false);
    }
  }, []);

  // Chỉ tải danh sách đã lưu khi thiết bị online (ngoại tuyến thì gọi cũng vô ích).
  useEffect(() => {
    if (online) void loadSaved();
  }, [online, loadSaved]);

  /** Quét các mạng xung quanh (mất ~2–3 giây trên firmware) */
  async function doScan() {
    setScanBusy(true);
    setScanErr(null);
    try {
      const res = await fetch("/api/wifi/scan", { cache: "no-store" });
      const json = (await res.json()) as WifiScanEntry[] | ErrorBody;
      if (!res.ok) throw new Error((json as ErrorBody).error ?? `HTTP ${res.status}`);
      const nets = (json as WifiScanEntry[]).slice().sort((a, b) => b.rssi - a.rssi);
      setScan(nets);
    } catch (err) {
      setScanErr(err instanceof Error ? err.message : String(err));
      setScan(null);
    } finally {
      setScanBusy(false);
    }
  }

  /** Lưu mạng mới + yêu cầu kết nối */
  async function doAdd() {
    const name = ssid.trim();
    if (!name) {
      setAddErr("Hãy nhập tên mạng (SSID).");
      return;
    }
    setAddBusy(true);
    setAddErr(null);
    setAddOk(null);
    try {
      const res = await fetch("/api/wifi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: name, pass }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setAddOk(
        `Đã lưu mạng "${name}" và yêu cầu thiết bị kết nối. Thiết bị có thể mất ` +
          "vài giây để nối lại — nếu đổi sang mạng khác, hãy đợi trạng thái ở trên cập nhật.",
      );
      setPass("");
      await Promise.all([loadSaved(), refresh()]);
    } catch (err) {
      setAddErr(err instanceof Error ? err.message : String(err));
    } finally {
      setAddBusy(false);
    }
  }

  /** Xóa một mạng đã lưu */
  async function doRemove(target: string) {
    if (!confirm(`Xóa mạng đã lưu "${target}"?`)) return;
    setSavedErr(null);
    try {
      const res = await fetch("/api/wifi", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: target }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await Promise.all([loadSaved(), refresh()]);
    } catch (err) {
      setSavedErr(err instanceof Error ? err.message : String(err));
    }
  }

  /** Mô tả trạng thái Wi-Fi hiện tại thành câu dễ hiểu */
  function currentStateText(): string {
    if (!data) return "Đang kết nối tới máy chủ dashboard…";
    if (!online) return "Không liên lạc được với thiết bị.";
    if (!wifi) return "Thiết bị online nhưng chưa báo trạng thái Wi-Fi.";
    if (wifi.ap || wifi.portal) return "Thiết bị đang ở chế độ phát Wi-Fi để cấu hình (AP).";
    if (wifi.up) return `Đang kết nối mạng "${wifi.ssid}".`;
    return "Thiết bị chưa nối được mạng Wi-Fi nào.";
  }

  return (
    <>
      <h1>Wi-Fi thiết bị</h1>
      <p className="sub">
        Cấu hình mạng Wi-Fi cho thiết bị ESP32 ngay trên dashboard. Mọi lời gọi đều đi qua
        máy chủ dashboard rồi mới sang thiết bị, nên trang này{" "}
        <b>chỉ dùng được khi thiết bị đang online cùng mạng</b>. Nếu thiết bị mất mạng hoàn
        toàn, hãy dùng Wi-Fi riêng do thiết bị phát (xem hướng dẫn bên dưới).
      </p>

      {netError && (
        <div className="badbox">Không gọi được máy chủ dashboard: {netError}</div>
      )}

      {/* --------- Thiết bị offline: hướng dẫn dùng AP 192.168.4.1 --------- */}
      {data && !online && (
        <div className="warnbox">
          <b>Thiết bị đang không có mạng.</b> Lúc này máy chủ dashboard không với tới được
          thiết bị (dashboard gọi thiết bị qua mạng Wi-Fi chung — mất mạng là mất đường
          liên lạc), nên không thể cấu hình Wi-Fi từ đây. Hãy làm trực tiếp trên thiết bị:
          <ol style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            <li>
              Nối điện thoại vào Wi-Fi <b>&quot;{AP_SSID}&quot;</b> do thiết bị phát ra.
            </li>
            <li>
              Mở trình duyệt vào <b>{AP_URL}</b> để nhập tên mạng và mật khẩu Wi-Fi nhà.
            </li>
            <li>
              Khi thiết bị nối lại được mạng nhà, quay lại trang này để quản lý tiếp.
            </li>
          </ol>
        </div>
      )}

      <div className="grid">
        {/* ----------------------- Trạng thái hiện tại ---------------------- */}
        <div className="card">
          <h2>Trạng thái hiện tại</h2>
          <div className="row">
            <span>Liên lạc với thiết bị</span>
            <b style={{ color: online ? "var(--ok)" : "var(--bad)" }}>
              {data ? (online ? "Online" : "OFFLINE") : "—"}
            </b>
          </div>
          <div className="row">
            <span>Tình trạng</span>
            <b>{currentStateText()}</b>
          </div>
          <div className="row">
            <span>Tên mạng đang nối</span>
            <b>{wifi?.up ? wifi.ssid : "—"}</b>
          </div>
          <div className="row">
            <span>Địa chỉ IP</span>
            <b>{wifi?.up ? wifi.ip : "—"}</b>
          </div>
          <div className="row">
            <span>Cường độ tín hiệu</span>
            <b>{wifi?.up ? `${wifi.rssi} dBm` : "—"}</b>
          </div>
          {wifi?.ap && (
            <div className="row">
              <span>Chế độ phát Wi-Fi (AP)</span>
              <b style={{ color: "var(--warn)" }}>Đang bật</b>
            </div>
          )}
        </div>

        {/* ----------------------- Mạng đã lưu ------------------------------ */}
        <div className="card">
          <h2>Mạng đã lưu trên thiết bị</h2>
          {!online ? (
            <p className="sub">Cần thiết bị online để xem và sửa danh sách mạng đã lưu.</p>
          ) : savedErr ? (
            <div className="badbox" style={{ marginBottom: 0 }}>{savedErr}</div>
          ) : saved.length === 0 ? (
            <p className="sub">{savedBusy ? "Đang tải…" : "Chưa lưu mạng nào."}</p>
          ) : (
            saved.map((n) => (
              <div className="row" key={n.ssid}>
                <span>{n.ssid}</span>
                <button className="b-gray" onClick={() => void doRemove(n.ssid)}>
                  Xóa
                </button>
              </div>
            ))
          )}
          {online && (
            <div className="btns" style={{ marginTop: 12 }}>
              <button className="b-gray" onClick={() => void loadSaved()} disabled={savedBusy}>
                {savedBusy ? "Đang tải…" : "Tải lại danh sách"}
              </button>
            </div>
          )}
        </div>

        {/* ----------------------- Quét mạng xung quanh --------------------- */}
        <div className="card full">
          <h2>Quét mạng xung quanh</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            Bấm để thiết bị quét các mạng Wi-Fi gần đó (mất khoảng 2–3 giây). Bấm vào một
            mạng trong kết quả để điền sẵn tên mạng vào ô phía dưới.
          </p>
          <div className="btns">
            <button className="b-main" onClick={() => void doScan()} disabled={!online || scanBusy}>
              {scanBusy ? "Đang quét…" : "Quét mạng xung quanh"}
            </button>
          </div>
          {!online && (
            <p className="sub" style={{ marginTop: 10 }}>
              Cần thiết bị online mới quét được.
            </p>
          )}
          {scanErr && <div className="badbox" style={{ marginTop: 12 }}>{scanErr}</div>}
          {scan && scan.length === 0 && (
            <p className="sub" style={{ marginTop: 10 }}>Không thấy mạng nào xung quanh.</p>
          )}
          {scan && scan.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {scan.map((n, i) => (
                <div className="row" key={`${n.ssid}-${i}`}>
                  <button
                    className="b-gray"
                    style={{ flex: 1, justifyContent: "flex-start", textAlign: "left" }}
                    onClick={() => setSsid(n.ssid)}
                    title="Bấm để điền sẵn tên mạng này"
                  >
                    {n.ssid || "(mạng ẩn)"}
                  </button>
                  <b style={{ marginLeft: 10 }}>
                    {n.enc === 0 ? "Mở · " : "Khóa · "}
                    {n.rssi} dBm
                  </b>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ----------------------- Thêm mạng mới ---------------------------- */}
        <div className="card full">
          <h2>Lưu &amp; kết nối mạng mới</h2>
          <div className="row">
            <span>Tên mạng (SSID)</span>
            <input
              value={ssid}
              onChange={(e) => setSsid(e.target.value)}
              placeholder="Ví dụ: Wifi-Nha"
              style={{ flex: 1, marginLeft: 12, maxWidth: 320 }}
              disabled={!online}
            />
          </div>
          <div className="row">
            <span>Mật khẩu</span>
            <input
              type={showPass ? "text" : "password"}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="Để trống nếu là mạng mở"
              style={{ flex: 1, marginLeft: 12, maxWidth: 320 }}
              disabled={!online}
            />
          </div>
          <div className="btns" style={{ marginTop: 12 }}>
            <button className="b-main" onClick={() => void doAdd()} disabled={!online || addBusy}>
              {addBusy ? "Đang lưu…" : "Lưu & kết nối"}
            </button>
            <button className="b-gray" onClick={() => setShowPass((v) => !v)}>
              {showPass ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
            </button>
          </div>
          {!online && (
            <p className="sub" style={{ marginTop: 10 }}>
              Cần thiết bị online mới lưu được mạng mới. Nếu thiết bị đang mất mạng, dùng
              Wi-Fi <b>&quot;{AP_SSID}&quot;</b> và mở <b>{AP_URL}</b> như hướng dẫn phía trên.
            </p>
          )}
          {addErr && <div className="badbox" style={{ marginTop: 12 }}>{addErr}</div>}
          {addOk && <div className="okbox" style={{ marginTop: 12 }}>{addOk}</div>}
        </div>

        {/* ----------------------- Lưu ý về giới hạn ------------------------ */}
        <div className="card full">
          <h2>Vì sao cần thiết bị online?</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            <Ic name="warning" size={14} /> Dashboard không gọi thẳng vào thiết bị mà đi qua
            máy chủ dashboard; cả hai phải ở chung mạng Wi-Fi thì mới liên lạc được. Vì vậy:
          </p>
          <ul className="sub" style={{ margin: "6px 0 0", paddingLeft: 20 }}>
            <li>
              Khi thiết bị <b>đang online</b>: dùng trang này để quét, lưu, xóa và chuyển
              mạng Wi-Fi bình thường.
            </li>
            <li>
              Khi thiết bị <b>mất mạng hoàn toàn</b>: trang này bất lực. Hãy nối điện thoại
              vào Wi-Fi <b>&quot;{AP_SSID}&quot;</b> do thiết bị phát rồi mở{" "}
              <b>{AP_URL}</b> để cấu hình trực tiếp trên thiết bị.
            </li>
          </ul>
        </div>
      </div>
    </>
  );
}
