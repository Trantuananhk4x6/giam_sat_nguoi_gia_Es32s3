"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLive } from "@/components/useLive";
import { clockOf, dateTimeOf, deltaSec } from "@/lib/format";
import { SCENARIOS } from "@/lib/scenarios";
import type { Outcome, Session, Trial } from "@/lib/types";

type SessionRow = Session & { trialCount: number };

const OUTCOME_LABEL: Record<Outcome, string> = {
  TP: "TP – phát hiện đúng ca té ngã",
  FN: "FN – té ngã thật nhưng bỏ sót",
  FP: "FP – báo nhầm khi không ngã",
  TN: "TN – không ngã và không báo",
};

export default function ThucNghiemPage() {
  const { data, refresh } = useLive(1000);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [scenarioId, setScenarioId] = useState<string>(SCENARIOS[0].id);
  const [trials, setTrials] = useState<Trial[]>([]);
  const [note, setNote] = useState("");
  const [override, setOverride] = useState<"" | Outcome>("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Form tạo phiên đo mới
  const [newName, setNewName] = useState("");
  const [newHeight, setNewHeight] = useState("270");
  const [newSens, setNewSens] = useState("3");
  const [newNote, setNewNote] = useState("");

  const active = data?.activeTrial ?? null;

  const loadSessions = useCallback(async () => {
    const res = await fetch("/api/sessions", { cache: "no-store" });
    const rows = (await res.json()) as SessionRow[];
    setSessions(rows);
    setSessionId((cur) => cur || rows[0]?.id || "");
  }, []);

  const loadTrials = useCallback(async (id: string) => {
    if (!id) {
      setTrials([]);
      return;
    }
    const res = await fetch(`/api/trials?sessionId=${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    setTrials((await res.json()) as Trial[]);
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    void loadTrials(sessionId);
  }, [sessionId, loadTrials, active?.id]);

  // Đồng hồ đếm thời gian của lần thử đang chạy
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [active]);

  const doneByScenario = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of trials) {
      if (t.endedAt !== null) m.set(t.scenarioId, (m.get(t.scenarioId) ?? 0) + 1);
    }
    return m;
  }, [trials]);

  async function post<T>(url: string, body: unknown, method = "POST"): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
    return json as T;
  }

  async function createSession() {
    setErr(null);
    try {
      const s = await post<Session>("/api/sessions", {
        name: newName,
        installHeightCm: Number(newHeight),
        sensitivity: Number(newSens),
        note: newNote,
      });
      setNewName("");
      setNewNote("");
      await loadSessions();
      setSessionId(s.id);
      setMsg(`Đã tạo phiên đo “${s.name}”.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function startTrial() {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await post("/api/trials", { action: "start", sessionId, scenarioId });
      setNote("");
      setOverride("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function stopTrial() {
    setErr(null);
    setBusy(true);
    try {
      const t = await post<Trial>("/api/trials", {
        action: "stop",
        outcome: override === "" ? undefined : override,
        note,
      });
      setMsg(
        t.outcome
          ? `Đã lưu lần thử: kết quả ${t.outcome}${t.manualOutcome ? " (chấm tay)" : " (tự chấm)"}.`
          : "Đã lưu lần thử (kịch bản này không tính vào độ chính xác phát hiện).",
      );
      setNote("");
      setOverride("");
      await refresh();
      await loadTrials(sessionId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rescore(id: string, outcome: "" | Outcome) {
    await post(`/api/trials/${id}`, { outcome: outcome === "" ? null : outcome }, "PATCH");
    await loadTrials(sessionId);
  }

  async function removeTrial(id: string) {
    if (!confirm("Xóa lần thử này khỏi số liệu?")) return;
    await fetch(`/api/trials/${id}`, { method: "DELETE" });
    await loadTrials(sessionId);
  }

  // Firmware tự báo cấu hình đang nạp -> đối chiếu với thông số người đo khai
  const fwConfig = data?.status?.config ?? null;
  const mismatch =
    fwConfig !== null &&
    (Number(newHeight) !== fwConfig.installHeightCm ||
      Number(newSens) !== fwConfig.sensitivity);

  const currentScenario = SCENARIOS.find((s) => s.id === (active?.scenarioId ?? scenarioId));
  const elapsed = active ? (now - active.startedAt) / 1000 : 0;

  return (
    <>
      <h1>Đo thực nghiệm</h1>
      <p className="sub">
        Mỗi lần thử được bấm “bắt đầu”, hệ thống tự đọc nhật ký firmware để biết radar có báo
        ngã hay không, mất bao lâu, và tự chấm TP/FP/FN/TN. Bạn chỉ cần làm động tác và bấm
        kết thúc.
      </p>

      {err && <div className="badbox">{err}</div>}
      {msg && <div className="okbox">{msg}</div>}
      {data && !data.online && (
        <div className="badbox">
          Chưa liên lạc được với ESP32 — không nên đo lúc này vì sẽ không ghi được mốc thời gian.
          {" "}
          {data.error}
        </div>
      )}
      {data?.status?.simulate && (
        <div className="warnbox">
          Firmware đang ở <b>chế độ mô phỏng radar</b>. Số liệu đo bây giờ chỉ dùng để kiểm tra
          quy trình, không được đưa vào báo cáo.
        </div>
      )}

      <div className="grid">
        {/* ------------------------------------------- Phiên đo --------------- */}
        <div className="card">
          <h2>Phiên đo</h2>
          <label className="field">
            <span>Chọn phiên đang làm</span>
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              {sessions.length === 0 && <option value="">(chưa có phiên nào)</option>}
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.installHeightCm} cm, độ nhạy {s.sensitivity} ({s.trialCount} lần)
                </option>
              ))}
            </select>
          </label>
          <div className="sub">
            Một phiên đo giữ cố định chiều cao lắp và độ nhạy. Muốn so sánh hai cấu hình thì tạo
            hai phiên — trang Báo cáo sẽ tự vẽ biểu đồ so sánh.
          </div>
        </div>

        {/* --------------------------------------- Tạo phiên mới -------------- */}
        <div className="card">
          <h2>Tạo phiên đo mới</h2>
          <label className="field">
            <span>Tên phiên (để trống sẽ tự đặt theo ngày giờ)</span>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="VD: Lắp 270cm – độ nhạy 3"
            />
          </label>
          <div className="inline">
            <label className="field">
              <span>Chiều cao lắp (cm)</span>
              <input
                type="number"
                value={newHeight}
                onChange={(e) => setNewHeight(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Độ nhạy (0–3)</span>
              <input
                type="number"
                min={0}
                max={3}
                value={newSens}
                onChange={(e) => setNewSens(e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>Ghi chú</span>
            <input
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="VD: phòng 4x4m, thảm yoga dày 10mm"
            />
          </label>
          <button className="b-main" onClick={createSession}>
            Tạo phiên đo
          </button>
          {fwConfig && (
            <div className="sub" style={{ marginTop: 8 }}>
              Firmware đang chạy: <b>{fwConfig.installHeightCm} cm</b>, độ nhạy{" "}
              <b>{fwConfig.sensitivity}</b>, trễ xác nhận ngã{" "}
              <b>{fwConfig.fallTimeS} giây</b>.{" "}
              <button
                className="b-gray"
                style={{ padding: "2px 8px", fontSize: 12 }}
                onClick={() => {
                  setNewHeight(String(fwConfig.installHeightCm));
                  setNewSens(String(fwConfig.sensitivity));
                }}
              >
                Điền theo firmware
              </button>
            </div>
          )}
          {mismatch && (
            <div className="warnbox" style={{ marginTop: 10 }}>
              Thông số bạn khai <b>khác với firmware đang chạy</b> ({fwConfig?.installHeightCm} cm,
              độ nhạy {fwConfig?.sensitivity}). Nếu khai sai thì bảng so sánh giữa các cấu hình
              trong báo cáo sẽ sai theo. Sửa lại cho khớp, hoặc nạp lại firmware với thông số mới.
            </div>
          )}
          <div className="sub" style={{ marginTop: 8 }}>
            Hai thông số này phải khớp với <code>RADAR_INSTALL_HEIGHT_CM</code> và{" "}
            <code>RADAR_FALL_SENSITIVITY</code> đang nạp trong firmware.
          </div>
        </div>

        {/* -------------------------------------- Lần thử hiện tại ------------ */}
        <div className={`card full ${active ? "hero warn" : ""}`}>
          <div style={{ flex: "1 1 320px" }}>
            <h2>{active ? "Đang đo một lần thử" : "Bắt đầu một lần thử"}</h2>

            {!active && (
              <>
                <label className="field">
                  <span>Kịch bản</span>
                  <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
                    {SCENARIOS.map((s) => (
                      <option key={s.id} value={s.id}>
                        [{s.group}] {s.name} — đã đo {doneByScenario.get(s.id) ?? 0}/{s.target}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="sub">
                  {currentScenario?.expectFall
                    ? "Kịch bản này LÀ té ngã thật → hệ thống phải báo mới đúng (TP)."
                    : "Kịch bản này KHÔNG phải té ngã → hệ thống báo là sai (FP)."}
                  {currentScenario && !currentScenario.countInDetection &&
                    " Kịch bản kiểm tra quy trình cảnh báo, không tính vào độ chính xác phát hiện."}
                </div>
                <div className="btns" style={{ marginTop: 12 }}>
                  <button
                    className="big b-main"
                    disabled={!sessionId || busy || !data?.online}
                    onClick={startTrial}
                  >
                    BẮT ĐẦU LẦN THỬ
                  </button>
                </div>
                {!sessionId && (
                  <div className="sub" style={{ marginTop: 8 }}>
                    Cần tạo hoặc chọn một phiên đo trước.
                  </div>
                )}
              </>
            )}

            {active && (
              <>
                <div className="state">{active.scenarioName}</div>
                <div className="sub">
                  Bắt đầu lúc {clockOf(active.startedAt)} · đã {elapsed.toFixed(1)} giây
                  {active.expectFall ? " · kỳ vọng: CÓ ngã" : " · kỳ vọng: KHÔNG ngã"}
                </div>

                <div className="marks">
                  <div className={`mark ${active.detectedAt ? "hit" : ""}`}>
                    Radar báo ngã:{" "}
                    <b>{active.detectedAt ? deltaSec(active.detectedAt, active.startedAt) : "chưa"}</b>
                  </div>
                  <div className={`mark ${active.cancelledAt ? "hit" : ""}`}>
                    Bấm “Tôi ổn”:{" "}
                    <b>
                      {active.cancelledAt
                        ? deltaSec(active.cancelledAt, active.detectedAt ?? active.startedAt)
                        : "chưa"}
                    </b>
                  </div>
                  <div className={`mark ${active.sosAt ? "hit" : ""}`}>
                    Bấm SOS: <b>{active.sosAt ? deltaSec(active.sosAt, active.startedAt) : "chưa"}</b>
                  </div>
                  <div className={`mark ${active.alertedAt ? "hit" : ""}`}>
                    Phát cảnh báo:{" "}
                    <b>{active.alertedAt ? deltaSec(active.alertedAt, active.startedAt) : "chưa"}</b>
                  </div>
                  <div className={`mark ${active.telegramAt ? "hit" : ""}`}>
                    Telegram gửi xong:{" "}
                    <b>
                      {active.telegramAt
                        ? deltaSec(active.telegramAt, active.detectedAt ?? active.startedAt)
                        : "chưa"}
                    </b>
                  </div>
                </div>

                {active.cooldownIgnored && (
                  <div className="warnbox" style={{ marginTop: 12 }}>
                    Radar có báo ngã nhưng firmware <b>bỏ qua vì đang trong thời gian nghỉ 60
                    giây</b> sau lần hủy trước. Nên xóa lần thử này và đo lại sau khi hết thời
                    gian nghỉ, nếu không số liệu sẽ bị tính thành bỏ sót (FN) oan.
                  </div>
                )}

                <div className="inline" style={{ marginTop: 12 }}>
                  <label className="field">
                    <span>Ghi chú (vì sao sai, điều kiện đặc biệt…)</span>
                    <input value={note} onChange={(e) => setNote(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Chấm tay (để trống = để hệ thống tự chấm)</span>
                    <select
                      value={override}
                      onChange={(e) => setOverride(e.target.value as "" | Outcome)}
                    >
                      <option value="">Tự chấm</option>
                      {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) => (
                        <option key={o} value={o}>
                          {OUTCOME_LABEL[o]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="btns">
                  <button className="big b-ok" disabled={busy} onClick={stopTrial}>
                    KẾT THÚC &amp; LƯU
                  </button>
                </div>
                <div className="sub" style={{ marginTop: 8 }}>
                  Mẹo: với kịch bản “không phản hồi”, hãy chờ hết 30 giây và thấy mốc “Telegram
                  gửi xong” hiện lên rồi mới bấm kết thúc, để đo được trễ cảnh báo thật.
                </div>
              </>
            )}
          </div>
        </div>

        {/* -------------------------------------------- Bảng lần thử ---------- */}
        <div className="card full">
          <h2>
            Các lần thử của phiên này ({trials.filter((t) => t.endedAt !== null).length})
          </h2>
          <div className="btns" style={{ marginBottom: 12 }}>
            <button
              className="b-gray"
              onClick={() => location.assign(`/api/export?kind=trials&sessionId=${sessionId}`)}
              disabled={!sessionId}
            >
              Tải chi tiết từng lần (Excel)
            </button>
            <button
              className="b-gray"
              onClick={() => location.assign(`/api/export?kind=summary&sessionId=${sessionId}`)}
              disabled={!sessionId}
            >
              Tải bảng tổng hợp (Excel)
            </button>
          </div>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Thời điểm</th>
                  <th>Kịch bản</th>
                  <th>Kỳ vọng</th>
                  <th>Kết quả</th>
                  <th>Trễ phát hiện</th>
                  <th>Trễ cảnh báo</th>
                  <th>Phản hồi</th>
                  <th>Ghi chú</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {trials.filter((t) => t.endedAt !== null).length === 0 && (
                  <tr>
                    <td colSpan={10} className="note">
                      Chưa có lần thử nào trong phiên này.
                    </td>
                  </tr>
                )}
                {trials
                  .filter((t) => t.endedAt !== null)
                  .map((t, i) => (
                    <tr key={t.id}>
                      <td>{trials.filter((x) => x.endedAt !== null).length - i}</td>
                      <td>{dateTimeOf(t.startedAt)}</td>
                      <td>{t.scenarioName}</td>
                      <td>{t.expectFall ? "Có ngã" : "Không ngã"}</td>
                      <td>
                        <select
                          value={t.outcome ?? ""}
                          onChange={(e) => void rescore(t.id, e.target.value as "" | Outcome)}
                          style={{ width: 92, padding: "4px 6px" }}
                          className={t.outcome ? `o-${t.outcome}` : ""}
                        >
                          <option value="">—</option>
                          <option value="TP">TP</option>
                          <option value="FP">FP</option>
                          <option value="FN">FN</option>
                          <option value="TN">TN</option>
                        </select>
                        {t.manualOutcome && <span className="sub"> (tay)</span>}
                      </td>
                      <td>{deltaSec(t.detectedAt, t.startedAt)}</td>
                      <td>
                        {t.deviceAlertMs !== null
                          ? `${(t.deviceAlertMs / 1000).toFixed(1)} s`
                          : deltaSec(t.telegramAt, t.detectedAt)}
                      </td>
                      <td>
                        {t.deviceResponseMs !== null
                          ? `${(t.deviceResponseMs / 1000).toFixed(1)} s`
                          : deltaSec(t.cancelledAt, t.detectedAt)}
                      </td>
                      <td className="note">
                        {t.cooldownIgnored && (
                          <span className="tag t-FALL_SUSPECT">rơi vào thời gian nghỉ</span>
                        )}{" "}
                        {t.note}
                      </td>
                      <td>
                        <button
                          className="b-gray"
                          style={{ padding: "4px 10px" }}
                          onClick={() => void removeTrial(t.id)}
                        >
                          Xóa
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
