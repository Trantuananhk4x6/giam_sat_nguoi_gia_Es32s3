"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { pct, secs, type Metrics } from "@/lib/metrics";
import type { Session } from "@/lib/types";

type ComparisonRow = {
  sessionId: string;
  name: string;
  installHeightCm: number;
  sensitivity: number;
  trials: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accuracy: number | null;
  alertMeanMs: number | null;
  alertMaxMs: number | null;
};

type ReportData = {
  session: Session | null;
  metrics: Metrics;
  comparison: ComparisonRow[];
  sessions: Session[];
};

const AXIS = { fill: "#9aa4b6", fontSize: 11 };
const TOOLTIP = {
  background: "#ffffff",
  border: "1px solid #e6eaf2",
  borderRadius: 10,
  color: "#1f2733",
  boxShadow: "0 6px 20px rgba(22,34,64,.12)",
};

export default function BaoCaoPage() {
  const [sessionId, setSessionId] = useState<string>("");
  const [data, setData] = useState<ReportData | null>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analysisErr, setAnalysisErr] = useState<string | null>(null);
  const [analysing, setAnalysing] = useState(false);

  const load = useCallback(async (id: string) => {
    const q = id ? `?sessionId=${encodeURIComponent(id)}` : "";
    const res = await fetch(`/api/report${q}`, { cache: "no-store" });
    setData((await res.json()) as ReportData);
  }, []);

  useEffect(() => {
    void load(sessionId);
  }, [sessionId, load]);

  async function analyse(provider?: "claude" | "gemini" | "groq") {
    setAnalysing(true);
    setAnalysisErr(null);
    setAnalysis(null);
    try {
      const res = await fetch("/api/phan-tich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId || null, provider }),
      });
      const json = (await res.json()) as { text?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setAnalysis(json.text ?? "");
    } catch (e) {
      setAnalysisErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalysing(false);
    }
  }

  const m = data?.metrics;

  const scenarioChart =
    m?.scenarios.map((s) => ({
      name: s.scenarioName.length > 22 ? s.scenarioName.slice(0, 21) + "…" : s.scenarioName,
      Đúng: s.correct,
      Sai: s.wrong,
    })) ?? [];

  const compareChart =
    data?.comparison.map((c) => ({
      name: `${c.installHeightCm}cm / độ nhạy ${c.sensitivity}`,
      "Độ nhạy (Recall)": c.recall === null ? 0 : Math.round(c.recall * 1000) / 10,
      "Độ chính xác (Precision)": c.precision === null ? 0 : Math.round(c.precision * 1000) / 10,
    })) ?? [];

  const confusionChart = m
    ? [
        { name: "TP", value: m.confusion.TP, fill: "#17a673" },
        { name: "TN", value: m.confusion.TN, fill: "#5ec49a" },
        { name: "FP", value: m.confusion.FP, fill: "#e8930c" },
        { name: "FN", value: m.confusion.FN, fill: "#e23d4b" },
      ]
    : [];

  return (
    <>
      <h1>Báo cáo &amp; biểu đồ</h1>
      <p className="sub">
        Các con số và biểu đồ ở trang này tính trực tiếp từ dữ liệu đã đo, dùng được ngay cho
        chương “Thi công và kết quả” của báo cáo.
      </p>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="inline">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Phiên đo</span>
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              <option value="">Tất cả các phiên (gộp chung)</option>
              {data?.sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.installHeightCm} cm, độ nhạy {s.sensitivity}
                </option>
              ))}
            </select>
          </label>
          <div className="btns" style={{ flex: "0 0 auto" }}>
            <button
              className="b-gray"
              onClick={() => location.assign(`/api/export?kind=summary&sessionId=${sessionId}`)}
            >
              Tải bảng tổng hợp (Excel)
            </button>
            <button
              className="b-gray"
              onClick={() => location.assign(`/api/export?kind=trials&sessionId=${sessionId}`)}
            >
              Tải chi tiết từng lần (Excel)
            </button>
            <button
              className="b-main"
              title="Một file JSON gồm chuỗi đặc trưng radar + các lần thử, upload lên Kaggle để huấn luyện model"
              onClick={() => location.assign("/api/export?kind=train")}
            >
              Tải dữ liệu huấn luyện (Kaggle)
            </button>
          </div>
        </div>
      </div>

      {m && m.totalTrials === 0 && (
        <div className="warnbox">
          Chưa có lần thử nào đã kết thúc. Sang trang <b>Đo thực nghiệm</b> để bắt đầu.
        </div>
      )}
      {m && m.cooldownIgnored > 0 && (
        <div className="warnbox">
          Có <b>{m.cooldownIgnored} lần thử</b> rơi vào thời gian nghỉ 60 giây của firmware nên
          radar báo ngã mà hệ thống bỏ qua. Nên xóa và đo lại các lần đó để số liệu không bị
          tính thành bỏ sót oan.
        </div>
      )}

      {/* --------------------------------------------- Chỉ số chính --------- */}
      <div className="card" style={{ marginBottom: 12 }}>
        <h2>Chỉ số đánh giá{data?.session ? ` — ${data.session.name}` : ""}</h2>
        <div className="kpi">
          <div className="box">
            <em>Độ nhạy (Recall)</em>
            <strong>{pct(m?.recall ?? null)}</strong>
            <small>TP / (TP + FN) — tỉ lệ ca ngã thật được phát hiện</small>
          </div>
          <div className="box">
            <em>Độ chính xác (Precision)</em>
            <strong>{pct(m?.precision ?? null)}</strong>
            <small>TP / (TP + FP) — trong số lần báo, bao nhiêu là đúng</small>
          </div>
          <div className="box">
            <em>F1</em>
            <strong>{pct(m?.f1 ?? null)}</strong>
            <small>Trung bình điều hòa của hai chỉ số trên</small>
          </div>
          <div className="box">
            <em>Accuracy</em>
            <strong>{pct(m?.accuracy ?? null)}</strong>
            <small>(TP + TN) / tổng số lần thử</small>
          </div>
          <div className="box">
            <em>Số lần thử</em>
            <strong>{m?.totalTrials ?? 0}</strong>
            <small>{m?.scored ?? 0} lần được tính vào chỉ số</small>
          </div>
        </div>
      </div>

      <div className="grid">
        {/* ------------------------------------------- Ma trận nhầm lẫn ------ */}
        <div className="card">
          <h2>Ma trận nhầm lẫn</h2>
          <div style={{ width: "100%", height: 210 }}>
            <ResponsiveContainer>
              <BarChart data={confusionChart} margin={{ top: 6, right: 8, bottom: 0, left: -22 }}>
                <CartesianGrid stroke="#ffffff10" vertical={false} />
                <XAxis dataKey="name" tick={AXIS} />
                <YAxis allowDecimals={false} tick={AXIS} />
                <Tooltip contentStyle={TOOLTIP} />
                <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                  {confusionChart.map((c) => (
                    <Cell key={c.name} fill={c.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="row">
            <span>TP – phát hiện đúng</span>
            <b className="o-TP">{m?.confusion.TP ?? 0}</b>
          </div>
          <div className="row">
            <span>TN – không ngã, không báo</span>
            <b className="o-TN">{m?.confusion.TN ?? 0}</b>
          </div>
          <div className="row">
            <span>FP – báo nhầm</span>
            <b className="o-FP">{m?.confusion.FP ?? 0}</b>
          </div>
          <div className="row">
            <span>FN – bỏ sót</span>
            <b className="o-FN">{m?.confusion.FN ?? 0}</b>
          </div>
        </div>

        {/* ------------------------------------------------ Thời gian --------- */}
        <div className="card">
          <h2>Thời gian cảnh báo</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Khoảng thời gian</th>
                  <th>Số mẫu</th>
                  <th>Trung bình</th>
                  <th>Lớn nhất</th>
                  <th>Nhỏ nhất</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Bắt đầu thử → radar báo ngã</td>
                  <td>{m?.detectLatency.count ?? 0}</td>
                  <td>{secs(m?.detectLatency.meanMs ?? null)}</td>
                  <td>{secs(m?.detectLatency.maxMs ?? null)}</td>
                  <td>{secs(m?.detectLatency.minMs ?? null)}</td>
                </tr>
                <tr>
                  <td>Radar báo ngã → Telegram gửi xong</td>
                  <td>{m?.alertLatency.count ?? 0}</td>
                  <td>{secs(m?.alertLatency.meanMs ?? null)}</td>
                  <td>{secs(m?.alertLatency.maxMs ?? null)}</td>
                  <td>{secs(m?.alertLatency.minMs ?? null)}</td>
                </tr>
                <tr>
                  <td>Radar báo ngã → người dùng bấm “Tôi ổn”</td>
                  <td>{m?.responseLatency.count ?? 0}</td>
                  <td>{secs(m?.responseLatency.meanMs ?? null)}</td>
                  <td>{secs(m?.responseLatency.maxMs ?? null)}</td>
                  <td>{secs(m?.responseLatency.minMs ?? null)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="sub" style={{ marginTop: 10 }}>
            Hàng thứ hai là số liệu đáng tin nhất để đưa vào báo cáo, vì nó đo từ lúc chính
            firmware phát hiện ngã, không phụ thuộc vào việc người đo bấm nút nhanh hay chậm.
          </div>
        </div>

        {/* ------------------------------------- Đúng / sai theo kịch bản ---- */}
        <div className="card full">
          <h2>Đúng và sai theo từng kịch bản</h2>
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={scenarioChart} margin={{ top: 6, right: 10, bottom: 50, left: -22 }}>
                <CartesianGrid stroke="#ffffff10" vertical={false} />
                <XAxis dataKey="name" tick={AXIS} angle={-28} textAnchor="end" interval={0} />
                <YAxis allowDecimals={false} tick={AXIS} />
                <Tooltip contentStyle={TOOLTIP} />
                <Legend wrapperStyle={{ fontSize: 12, color: "#6b7688" }} />
                <Bar dataKey="Đúng" stackId="a" fill="#17a673" radius={[0, 0, 0, 0]} />
                <Bar dataKey="Sai" stackId="a" fill="#e23d4b" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="scroll" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th>Kịch bản</th>
                  <th>Nhóm</th>
                  <th>Đã đo / mục tiêu</th>
                  <th>Đúng</th>
                  <th>Sai</th>
                  <th>Tỉ lệ đúng</th>
                  <th>TP</th>
                  <th>FP</th>
                  <th>FN</th>
                  <th>TN</th>
                </tr>
              </thead>
              <tbody>
                {(m?.scenarios.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={10} className="note">
                      Chưa có dữ liệu.
                    </td>
                  </tr>
                )}
                {m?.scenarios.map((s) => (
                  <tr key={s.scenarioId}>
                    <td>{s.scenarioName}</td>
                    <td className="note">{s.group}</td>
                    <td>
                      {s.done} / {s.target}
                    </td>
                    <td>{s.correct}</td>
                    <td>{s.wrong}</td>
                    <td>{pct(s.accuracy)}</td>
                    <td className="o-TP">{s.outcomes.TP}</td>
                    <td className="o-FP">{s.outcomes.FP}</td>
                    <td className="o-FN">{s.outcomes.FN}</td>
                    <td className="o-TN">{s.outcomes.TN}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ---------------------------------- Nhận xét bằng AI --------------- */}
        <div className="card full">
          <h2>Nhận xét tự động cho chương &ldquo;Đánh giá kết quả&rdquo;</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            Gửi <b>số liệu tổng hợp</b> (số lần đúng/sai, thời gian trễ, ghi chú các ca sai)
            lên một mô hình ngôn ngữ để nhờ viết nhận xét kỹ thuật. Không gửi tên người được
            giám sát hay bất cứ thông tin đời tư nào.
          </p>
          <div className="btns">
            <button className="b-main" onClick={() => analyse()} disabled={analysing}>
              {analysing ? "Đang phân tích…" : "Viết nhận xét"}
            </button>
            <button className="b-gray" onClick={() => analyse("gemini")} disabled={analysing}>
              Dùng Gemini (bậc miễn phí)
            </button>
            <button className="b-gray" onClick={() => analyse("groq")} disabled={analysing}>
              Dùng Groq (miễn phí, nhanh)
            </button>
            {analysis && (
              <button
                className="b-gray"
                onClick={() => void navigator.clipboard.writeText(analysis)}
              >
                Copy để dán vào báo cáo
              </button>
            )}
          </div>
          {analysisErr && (
            <div className="badbox" style={{ marginTop: 12 }}>
              {analysisErr}
            </div>
          )}
          {analysis && (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                background: "var(--bg2)",
                border: "1px solid var(--line)",
                borderRadius: 12,
                padding: 14,
                marginTop: 12,
                fontSize: 13.5,
                lineHeight: 1.65,
                fontFamily: "inherit",
              }}
            >
              {analysis}
            </pre>
          )}
          {!analysis && !analysisErr && (
            <div className="sub" style={{ marginTop: 10 }}>
              Cần khai một trong hai khóa trong <code>dashboard/.env.local</code>:{" "}
              <code>ANTHROPIC_API_KEY</code> (Claude, trả phí nhưng một lần phân tích chỉ
              khoảng 0,05–0,1 USD) hoặc <code>GEMINI_API_KEY</code> (Google Gemini, có bậc
              miễn phí — lấy ở aistudio.google.com/apikey). Không có khóa thì mọi số liệu và
              biểu đồ ở trên vẫn dùng được bình thường.
            </div>
          )}
        </div>

        {/* ------------------------------------------ So sánh các phiên ------- */}
        <div className="card full">
          <h2>So sánh giữa các cấu hình lắp đặt</h2>
          {(data?.comparison.length ?? 0) < 2 ? (
            <div className="sub">
              Cần ít nhất hai phiên đo có dữ liệu để so sánh. Bản kế hoạch gợi ý đo thêm ở một
              chiều cao lắp khác (ví dụ 240 cm) hoặc một mức độ nhạy khác (ví dụ 2) — phần này
              làm báo cáo dày hơn hẳn và rất dễ bị hội đồng hỏi tới.
            </div>
          ) : (
            <>
              <div style={{ width: "100%", height: 250 }}>
                <ResponsiveContainer>
                  <BarChart
                    data={compareChart}
                    margin={{ top: 6, right: 10, bottom: 40, left: -22 }}
                  >
                    <CartesianGrid stroke="#ffffff10" vertical={false} />
                    <XAxis dataKey="name" tick={AXIS} angle={-18} textAnchor="end" interval={0} />
                    <YAxis domain={[0, 100]} unit="%" tick={AXIS} />
                    <Tooltip
                      contentStyle={TOOLTIP}
                      formatter={(value: unknown) => `${Number(value)}%`}
                    />
                    <Legend wrapperStyle={{ fontSize: 12, color: "#6b7688" }} />
                    <Bar dataKey="Độ nhạy (Recall)" fill="#2563eb" radius={[6, 6, 0, 0]} />
                    <Bar dataKey="Độ chính xác (Precision)" fill="#17a673" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Phiên đo</th>
                      <th>Chiều cao</th>
                      <th>Độ nhạy</th>
                      <th>Số lần</th>
                      <th>Recall</th>
                      <th>Precision</th>
                      <th>F1</th>
                      <th>Trễ TB</th>
                      <th>Trễ lớn nhất</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.comparison.map((c) => (
                      <tr key={c.sessionId}>
                        <td>{c.name}</td>
                        <td>{c.installHeightCm} cm</td>
                        <td>{c.sensitivity}</td>
                        <td>{c.trials}</td>
                        <td>{pct(c.recall)}</td>
                        <td>{pct(c.precision)}</td>
                        <td>{pct(c.f1)}</td>
                        <td>{secs(c.alertMeanMs)}</td>
                        <td>{secs(c.alertMaxMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
