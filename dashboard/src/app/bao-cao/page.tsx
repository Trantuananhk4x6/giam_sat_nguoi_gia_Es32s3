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

type BinaryConfusionModel = {
  id: string;
  name: string;
  subtitle: string;
  level: "event" | "window";
  tp: number;
  fn: number;
  fp: number;
  tn: number;
  total: number;
  threshold: number;
  faPerHour: number;
  hours: number;
  precision: number;
  recall: number;
  specificity: number;
  npv: number;
  f1: number;
  accuracy: number;
  auc?: number;
  ap?: number;
  verdict: string;
};

type PostureClassMetric = {
  code: string;
  label: string;
  precision: number;
  recall: number;
  f1: number;
  support: number;
  correct: number;
};

type FeatureAuditRow = {
  index: number;
  code: string;
  rawName: string;
  viName: string;
  unit: string;
  weight: number;
  oddsRatio: number;
  absRank: number;
  meanNonFall: number;
  meanFall: number;
  singleAuc: number;
  cohenD: number;
  empiricalDirection: string;
  scalerMean: number;
  scalerScale: number;
  expectedSign: string;
  actualSign: string;
  signAuditStatus: "PASS" | "COLLINEAR_COMPENSATION" | "POST_FALL_DEFERRED";
  physicalMeaning: string;
  auditExplanation: string;
};

type CoralRow = {
  method: string;
  recallAt1Fa: number;
  recallAt3Fa: number;
  recallAt6Fa: number;
  recallAt12Fa: number;
  sourceThreshold: number;
  actualFaPerHour: number;
};

type DistillModelRow = {
  role: string;
  architecture: string;
  paramsCount: number;
  flashBytes: number;
  latencyMs: number;
  eventRecallAt6Fa: number;
  faPerHour: number;
  rocAuc: number;
  brierScore: number;
  ece: number;
  deployableOnEsp32: boolean;
  note: string;
};

type AuditImage = {
  filename: string;
  url: string;
  title: string;
  category: "confusion-bias" | "eda-signal" | "domain-posture";
  description: string;
  order: number;
};

type ModelAuditData = {
  generatedAt: string;
  specVersion: number;
  confirmWindows: number;
  falseAlarmBudgetPerHour: number;
  confusionMatrices: {
    binaryModels: BinaryConfusionModel[];
    posture5x5: {
      labels: string[];
      codes: string[];
      matrix: number[][];
      perClass: PostureClassMetric[];
      overallAccuracy: number;
    };
    crossDomainCoral: CoralRow[];
  };
  biasAudit: {
    intercept: number;
    logisticThreshold: number;
    logisticF1Threshold: number;
    mlpThreshold: number;
    regularizationC: number;
    classImbalance: {
      totalWindows: number;
      fallWindows: number;
      nonFallWindows: number;
      positiveRate: number;
      imbalanceRatio: number;
      totalFallEvents: number;
      totalLivingHours: number;
    };
    features: FeatureAuditRow[];
    domainBias: {
      sourceDomain: {
        name: string;
        windows: number;
        fallWindows: number;
        auc: number;
        ap: number;
        precision: number;
        recall: number;
      };
      targetDomain: {
        name: string;
        windows: number;
        fallWindows: number;
        auc: number;
        ap: number;
        precision: number;
        recall: number;
      };
      coralFaReduction: {
        beforeFaPerHour: number;
        afterFaPerHour: number;
        reductionPercent: number;
        recallAt6FaBefore: number;
        recallAt6FaAfter: number;
      };
    };
    subjectFairness: {
      folds: number;
      subjectsCount: number;
      mlpPublicRecall: number;
      mlpNestedRecall: number;
      mlpPublicFaPerHour: number;
      mlpNestedFaPerHour: number;
      logPublicRecall: number;
      logNestedRecall: number;
    };
    markdownReport: string | null;
  };
  distillation: {
    strategy: string;
    formula: string;
    whyDistill: string;
    models: DistillModelRow[];
  };
  images: AuditImage[];
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
  const [audit, setAudit] = useState<ModelAuditData | null>(null);
  const [selectedBinaryId, setSelectedBinaryId] = useState<string>("mlp-event-main");
  const [postureNorm, setPostureNorm] = useState<boolean>(true);
  const [auditTab, setAuditTab] = useState<"cm" | "bias" | "distill" | "gallery">("cm");
  const [galleryFilter, setGalleryFilter] = useState<string>("all");
  const [lightboxImg, setLightboxImg] = useState<AuditImage | null>(null);

  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analysisErr, setAnalysisErr] = useState<string | null>(null);
  const [analysing, setAnalysing] = useState(false);

  const load = useCallback(async (id: string) => {
    const q = id ? `?sessionId=${encodeURIComponent(id)}` : "";
    const res = await fetch(`/api/report${q}`, { cache: "no-store" });
    setData((await res.json()) as ReportData);
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const res = await fetch("/api/model-audit", { cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as ModelAuditData;
        setAudit(json);
      }
    } catch {
      // ignore if offline
    }
  }, []);

  useEffect(() => {
    void load(sessionId);
  }, [sessionId, load]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

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

  const activeBinary: BinaryConfusionModel | null =
    audit?.confusionMatrices.binaryModels.find((b) => b.id === selectedBinaryId) ??
    audit?.confusionMatrices.binaryModels[0] ??
    null;

  const filteredImages =
    audit?.images.filter((img) => galleryFilter === "all" || img.category === galleryFilter) ?? [];

  return (
    <>
      <h1>Báo cáo thực nghiệm, Kiểm toán AI &amp; Ma trận nhầm lẫn</h1>
      <p className="sub">
        Tổng hợp số liệu đo thực nghiệm tại chỗ cùng Trung tâm Kiểm toán Mô hình AI (Ma trận nhầm
        lẫn 2×2 &amp; 5×5, Kiểm toán độ chệch Bias Audit, Chuẩn hóa liên miền CORAL và Chưng cất
        tri thức Teacher → Student ESP32-S3).
      </p>

      {/* =====================================================================
          PHẦN 1: TRUNG TÂM KIỂM TOÁN MÔ HÌNH AI & MA TRẬN NHẦM LẪN (FLAGSHIP)
         ===================================================================== */}
      {audit && (
        <div
          className="card"
          style={{
            marginBottom: 18,
            border: "1px solid #c7d7fe",
            background: "linear-gradient(180deg, #f8faff 0%, #ffffff 120px)",
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              marginBottom: 14,
            }}
          >
            <div>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  background: "#eef4ff",
                  color: "#1e4fd6",
                  fontSize: 12,
                  fontWeight: 700,
                  padding: "4px 10px",
                  borderRadius: 999,
                  marginBottom: 6,
                }}
              >
                <span>AI MODEL AUDIT &amp; DISTILLATION STUDIO</span>
                <span>•</span>
                <span>147,192 Cửa sổ | 795 Cú ngã | 15 Người</span>
              </div>
              <h2 style={{ margin: 0, fontSize: 18 }}>
                Kiểm Toán Ma Trận Nhầm Lẫn, Độ Chệch (Bias) &amp; Chưng Cất Tri Thức Nhúng
              </h2>
            </div>

            <div className="btns" style={{ margin: 0 }}>
              <button
                className={auditTab === "cm" ? "b-main" : "b-gray"}
                onClick={() => setAuditTab("cm")}
              >
                1. Ma trận nhầm lẫn (2×2 &amp; 5×5)
              </button>
              <button
                className={auditTab === "bias" ? "b-main" : "b-gray"}
                onClick={() => setAuditTab("bias")}
              >
                2. Kiểm toán Bias &amp; 10 Đặc trưng
              </button>
              <button
                className={auditTab === "distill" ? "b-main" : "b-gray"}
                onClick={() => setAuditTab("distill")}
              >
                3. Chưng cất Teacher → Student
              </button>
              <button
                className={auditTab === "gallery" ? "b-main" : "b-gray"}
                onClick={() => setAuditTab("gallery")}
              >
                4. Biểu đồ nghiên cứu ({audit.images.length})
              </button>
            </div>
          </div>

          {/* Tóm tắt KPI Kiểm toán AI */}
          <div className="kpi" style={{ marginBottom: 16 }}>
            <div className="box" style={{ background: "#f0fdf4", borderColor: "#bbf7d0" }}>
              <em>Student MLP (Sự kiện @ ≤6 FA/h)</em>
              <strong style={{ color: "#15803d" }}>
                261 / 795 ({(audit.biasAudit.subjectFairness.mlpPublicRecall * 100).toFixed(1)}%)
              </strong>
              <small>Bắt gấp 5.1× số cú ngã so với Logistic (51/795) ở 5.5 báo nhầm/giờ</small>
            </div>
            <div className="box" style={{ background: "#eff6ff", borderColor: "#bfdbfe" }}>
              <em>Đánh giá chéo 3-Fold Theo Người</em>
              <strong style={{ color: "#1d4ed8" }}>
                {(audit.biasAudit.subjectFairness.mlpNestedRecall * 100).toFixed(1)}% Recall
              </strong>
              <small>Không suy giảm khi gặp người mới (Nested CV: 269/795 cú ngã)</small>
            </div>
            <div className="box" style={{ background: "#fefce8", borderColor: "#fef08a" }}>
              <em>Phân loại 5 Tư Thế (Posture MLP)</em>
              <strong style={{ color: "#a16207" }}>
                {(audit.confusionMatrices.posture5x5.overallAccuracy * 100).toFixed(1)}% Acc
              </strong>
              <small>Lớp &ldquo;Nằm trên sàn&rdquo; đạt độ nhạy 80.2% (hậu kiểm chống báo giả)</small>
            </div>
            <div className="box" style={{ background: "#faf5ff", borderColor: "#e9d5ff" }}>
              <em>Chuẩn hóa Đổi nhà (CORAL)</em>
              <strong style={{ color: "#7e22ce" }}>−80.0% Báo nhầm</strong>
              <small>Giảm từ 58.9 xuống 11.8 báo nhầm/giờ khi lắp ở ngôi nhà mới</small>
            </div>
            <div className="box">
              <em>Dung lượng Nhúng ESP32-S3</em>
              <strong>17.2 KB Flash</strong>
              <small>4,294 tham số float32 (suy luận &lt; 0.35 ms, không cần PSRAM)</small>
            </div>
          </div>

          {/* -----------------------------------------------------------------
              TAB 1: MA TRẬN NHẦM LẪN ĐA CẤP (2x2 TÉ NGÃ & 5x5 TƯ THẾ & CORAL)
             ----------------------------------------------------------------- */}
          {auditTab === "cm" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="grid">
                {/* Cột trái: Ma trận nhầm lẫn 2x2 phát hiện té ngã */}
                <div className="card" style={{ margin: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 10,
                    }}
                  >
                    <h2 style={{ margin: 0 }}>Ma trận nhầm lẫn 2×2 — Phát hiện Té Ngã</h2>
                    <span
                      className="pill"
                      style={{
                        background: activeBinary?.level === "event" ? "#e0f2fe" : "#f3e8ff",
                        color: activeBinary?.level === "event" ? "#0369a1" : "#6b21a8",
                      }}
                    >
                      {activeBinary?.level === "event"
                        ? "Cấp Sự Kiện (2 cửa sổ liên tiếp)"
                        : "Cấp Cửa Sổ Đơn Lẻ (8.0s)"}
                    </span>
                  </div>

                  <label className="field" style={{ marginBottom: 12 }}>
                    <span>Chọn cấu hình mô hình &amp; cấp đánh giá để kiểm tra:</span>
                    <select
                      value={selectedBinaryId}
                      onChange={(e) => setSelectedBinaryId(e.target.value)}
                    >
                      {audit.confusionMatrices.binaryModels.map((bm) => (
                        <option key={bm.id} value={bm.id}>
                          {bm.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  {activeBinary && (
                    <>
                      <div className="sub" style={{ marginBottom: 10 }}>
                        {activeBinary.subtitle} • Ngưỡng xác suất:{" "}
                        <b>{activeBinary.threshold.toFixed(4)}</b> • Báo nhầm:{" "}
                        <b>{activeBinary.faPerHour.toFixed(1)} lần/giờ</b>
                      </div>

                      {/* Lưới trực quan 2x2 */}
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "110px 1fr 1fr",
                          gap: 8,
                          alignItems: "stretch",
                          marginBottom: 12,
                        }}
                      >
                        <div />
                        <div
                          style={{
                            textAlign: "center",
                            fontSize: 12,
                            fontWeight: 700,
                            color: "#1e293b",
                            padding: "4px 6px",
                            background: "#f1f5f9",
                            borderRadius: 8,
                          }}
                        >
                          Dự đoán: CÓ NGÃ (1)
                        </div>
                        <div
                          style={{
                            textAlign: "center",
                            fontSize: 12,
                            fontWeight: 700,
                            color: "#1e293b",
                            padding: "4px 6px",
                            background: "#f1f5f9",
                            borderRadius: 8,
                          }}
                        >
                          Dự đoán: BÌNH THƯỜNG (0)
                        </div>

                        {/* Hàng 1: Thực tế CÓ NGÃ */}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 12,
                            fontWeight: 700,
                            color: "#1e293b",
                            background: "#f1f5f9",
                            borderRadius: 8,
                            padding: 6,
                            textAlign: "center",
                          }}
                        >
                          Thực tế:
                          <br />
                          CÓ NGÃ
                          <br />({activeBinary.tp + activeBinary.fn})
                        </div>
                        <div
                          style={{
                            background: "#ecfdf5",
                            border: "2px solid #10b981",
                            borderRadius: 12,
                            padding: 12,
                            textAlign: "center",
                          }}
                        >
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#047857" }}>
                            TP (Bắt trúng ngã)
                          </div>
                          <div
                            style={{
                              fontSize: 24,
                              fontWeight: 800,
                              color: "#065f46",
                              margin: "4px 0",
                            }}
                          >
                            {activeBinary.tp.toLocaleString("vi-VN")}
                          </div>
                          <div style={{ fontSize: 12, color: "#047857" }}>
                            Độ nhạy (Recall): <b>{(activeBinary.recall * 100).toFixed(1)}%</b>
                          </div>
                        </div>
                        <div
                          style={{
                            background: "#fef2f2",
                            border: "2px solid #f87171",
                            borderRadius: 12,
                            padding: 12,
                            textAlign: "center",
                          }}
                        >
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#b91c1c" }}>
                            FN (Bỏ sót ngã)
                          </div>
                          <div
                            style={{
                              fontSize: 24,
                              fontWeight: 800,
                              color: "#991b1b",
                              margin: "4px 0",
                            }}
                          >
                            {activeBinary.fn.toLocaleString("vi-VN")}
                          </div>
                          <div style={{ fontSize: 12, color: "#b91c1c" }}>
                            Tỉ lệ sót: <b>{((1 - activeBinary.recall) * 100).toFixed(1)}%</b>
                          </div>
                        </div>

                        {/* Hàng 2: Thực tế KHÔNG NGÃ */}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 12,
                            fontWeight: 700,
                            color: "#1e293b",
                            background: "#f1f5f9",
                            borderRadius: 8,
                            padding: 6,
                            textAlign: "center",
                          }}
                        >
                          Thực tế:
                          <br />
                          SINH HOẠT
                          <br />({(activeBinary.fp + activeBinary.tn).toLocaleString("vi-VN")})
                        </div>
                        <div
                          style={{
                            background: "#fffbeb",
                            border: "2px solid #f59e0b",
                            borderRadius: 12,
                            padding: 12,
                            textAlign: "center",
                          }}
                        >
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#b45309" }}>
                            FP (Báo động nhầm)
                          </div>
                          <div
                            style={{
                              fontSize: 24,
                              fontWeight: 800,
                              color: "#92400e",
                              margin: "4px 0",
                            }}
                          >
                            {activeBinary.fp.toLocaleString("vi-VN")}
                          </div>
                          <div style={{ fontSize: 12, color: "#b45309" }}>
                            <b>{activeBinary.faPerHour.toFixed(1)}</b> lần/giờ (
                            {activeBinary.hours}h)
                          </div>
                        </div>
                        <div
                          style={{
                            background: "#f0fdf4",
                            border: "1px solid #86efac",
                            borderRadius: 12,
                            padding: 12,
                            textAlign: "center",
                          }}
                        >
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#15803d" }}>
                            TN (An toàn chuẩn)
                          </div>
                          <div
                            style={{
                              fontSize: 24,
                              fontWeight: 800,
                              color: "#166534",
                              margin: "4px 0",
                            }}
                          >
                            {activeBinary.tn.toLocaleString("vi-VN")}
                          </div>
                          <div style={{ fontSize: 12, color: "#15803d" }}>
                            Đặc hiệu (Spec): <b>{(activeBinary.specificity * 100).toFixed(2)}%</b>
                          </div>
                        </div>
                      </div>

                      <div className="row">
                        <span>Precision (PPV) / F1-Score</span>
                        <b>
                          {(activeBinary.precision * 100).toFixed(1)}% /{" "}
                          {(activeBinary.f1 * 100).toFixed(1)}%
                        </b>
                      </div>
                      <div className="row">
                        <span>NPV (Xác suất an toàn thật khi không báo)</span>
                        <b>{(activeBinary.npv * 100).toFixed(2)}%</b>
                      </div>
                      {activeBinary.auc !== undefined && (
                        <div className="row">
                          <span>ROC-AUC / Average Precision (PR-AUC)</span>
                          <b>
                            {activeBinary.auc.toFixed(3)} / {activeBinary.ap?.toFixed(3)}
                          </b>
                        </div>
                      )}
                      <div
                        style={{
                          marginTop: 10,
                          padding: 10,
                          borderRadius: 10,
                          background: "#f8fafc",
                          border: "1px solid #e2e8f0",
                          fontSize: 13,
                          lineHeight: 1.55,
                        }}
                      >
                        <b>Nhận định kiểm toán:</b> {activeBinary.verdict}
                      </div>
                    </>
                  )}
                </div>

                {/* Cột phải: Ma trận nhầm lẫn 5x5 cho 5 lớp Tư Thế */}
                <div className="card" style={{ margin: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 8,
                    }}
                  >
                    <h2 style={{ margin: 0 }}>Ma trận nhầm lẫn 5×5 — Phân loại Tư Thế</h2>
                    <button
                      className="b-gray"
                      style={{ padding: "5px 10px", fontSize: 12 }}
                      onClick={() => setPostureNorm((v) => !v)}
                    >
                      {postureNorm ? "Đang xem: % Theo hàng" : "Đang xem: Số mẫu tuyệt đối"}
                    </button>
                  </div>
                  <p className="sub" style={{ marginTop: 0, marginBottom: 10 }}>
                    Mạng <code>Posture MLP (10→32→16→5)</code> đạt độ chính xác tổng thể{" "}
                    <b>{(audit.confusionMatrices.posture5x5.overallAccuracy * 100).toFixed(1)}%</b>.
                    Đặc biệt lớp <b>Nằm trên sàn</b> đạt Recall <b>80.2%</b> để hậu kiểm sau va
                    chạm.
                  </p>

                  <div className="scroll">
                    <table style={{ fontSize: 12, textAlign: "center" }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left" }}>Thực tế \ Dự đoán</th>
                          {audit.confusionMatrices.posture5x5.labels.map((lb) => (
                            <th key={lb}>{lb}</th>
                          ))}
                          <th>Recall</th>
                        </tr>
                      </thead>
                      <tbody>
                        {audit.confusionMatrices.posture5x5.matrix.map((row, rIdx) => {
                          const rowSum = row.reduce((a, b) => a + b, 0) || 1;
                          const cls = audit.confusionMatrices.posture5x5.perClass[rIdx];
                          return (
                            <tr key={rIdx}>
                              <td style={{ textAlign: "left", fontWeight: 700 }}>
                                {audit.confusionMatrices.posture5x5.labels[rIdx]}
                              </td>
                              {row.map((val, cIdx) => {
                                const ratio = val / rowSum;
                                const isDiag = rIdx === cIdx;
                                const bg = isDiag
                                  ? `rgba(23, 166, 115, ${0.15 + ratio * 0.55})`
                                  : ratio > 0.15
                                    ? `rgba(232, 147, 12, ${ratio * 0.65})`
                                    : "transparent";
                                return (
                                  <td
                                    key={cIdx}
                                    style={{
                                      background: bg,
                                      fontWeight: isDiag ? 800 : 500,
                                      color: isDiag ? "#065f46" : "#334155",
                                      borderRadius: 4,
                                    }}
                                  >
                                    {postureNorm
                                      ? `${(ratio * 100).toFixed(1)}%`
                                      : val.toLocaleString("vi-VN")}
                                  </td>
                                );
                              })}
                              <td style={{ fontWeight: 700, color: "#1e4fd6" }}>
                                {((cls?.recall ?? 0) * 100).toFixed(1)}%
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div
                    style={{
                      marginTop: 12,
                      padding: 10,
                      borderRadius: 10,
                      background: "#eff6ff",
                      border: "1px solid #bfdbfe",
                      fontSize: 12.5,
                      lineHeight: 1.55,
                    }}
                  >
                    <b>Cơ chế kết hợp Tư Thế &amp; Té Ngã trên ESP32-S3:</b> Khi người cao tuổi nằm
                    nhanh xuống giường, cảm biến chỉ thấy khoảng cách giảm nhẹ (~1.7m) nên rơi vào
                    lớp <i>Nằm trên giường</i> thay vì <i>Nằm trên sàn</i> (~2.4m). Nhờ theo dõi{" "}
                    <code>floorProb</code> (Recall 80.2%), hệ thống phân biệt rõ{" "}
                    <b>nằm nghỉ trên giường</b> với <b>ngã bất động dưới sàn</b>.
                  </div>
                </div>
              </div>

              {/* Bảng đối chiếu toàn diện 6 cấu hình & Chuẩn hóa liên miền CORAL */}
              <div className="grid">
                <div className="card" style={{ margin: 0 }}>
                  <h2>So sánh trực diện các mô hình phát hiện té ngã</h2>
                  <div className="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Mô hình &amp; Chế độ</th>
                          <th>Ngưỡng</th>
                          <th>TP (Bắt được)</th>
                          <th>FN (Sót)</th>
                          <th>FP (Báo nhầm)</th>
                          <th>Recall</th>
                          <th>Báo nhầm/giờ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {audit.confusionMatrices.binaryModels.map((bm) => (
                          <tr
                            key={bm.id}
                            style={{
                              background: bm.id === selectedBinaryId ? "#eff6ff" : undefined,
                              cursor: "pointer",
                            }}
                            onClick={() => setSelectedBinaryId(bm.id)}
                          >
                            <td style={{ fontWeight: 600 }}>{bm.name}</td>
                            <td>{bm.threshold.toFixed(4)}</td>
                            <td className="o-TP">{bm.tp.toLocaleString("vi-VN")}</td>
                            <td className="o-FN">{bm.fn.toLocaleString("vi-VN")}</td>
                            <td className="o-FP">{bm.fp.toLocaleString("vi-VN")}</td>
                            <td>
                              <b>{(bm.recall * 100).toFixed(1)}%</b>
                            </td>
                            <td>
                              <b
                                style={{
                                  color: bm.faPerHour <= 6.2 ? "#15803d" : "#dc2626",
                                }}
                              >
                                {bm.faPerHour.toFixed(1)} / giờ
                              </b>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="card" style={{ margin: 0 }}>
                  <h2>Kiểm toán Đổi Nhà (Cross-Domain CORAL: mm-ADL → mm-ADL-Home)</h2>
                  <p className="sub" style={{ marginTop: 0 }}>
                    Khi mang thiết bị từ phòng chuẩn (mm-ADL) sang căn hộ thực tế có nội thất khác
                    biệt (mm-ADL-Home), phân bố khoảng cách bị lệch làm báo nhầm tăng vọt nếu không
                    căn chỉnh hiệp phương sai CORAL:
                  </p>
                  <div className="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Phương pháp thích nghi miền</th>
                          <th>Recall @ ≤1 FA/h</th>
                          <th>Recall @ ≤6 FA/h</th>
                          <th>Recall @ ≤12 FA/h</th>
                          <th>Báo nhầm/giờ thực tế</th>
                        </tr>
                      </thead>
                      <tbody>
                        {audit.confusionMatrices.crossDomainCoral.map((cr) => (
                          <tr key={cr.method}>
                            <td style={{ fontWeight: 600 }}>{cr.method}</td>
                            <td>{(cr.recallAt1Fa * 100).toFixed(1)}%</td>
                            <td>
                              <b>{(cr.recallAt6Fa * 100).toFixed(1)}%</b>
                            </td>
                            <td>{(cr.recallAt12Fa * 100).toFixed(1)}%</td>
                            <td>
                              <b
                                style={{
                                  color: cr.actualFaPerHour < 15 ? "#15803d" : "#dc2626",
                                }}
                              >
                                {cr.actualFaPerHour.toFixed(1)} lần/giờ
                              </b>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* -----------------------------------------------------------------
              TAB 2: KIỂM TOÁN ĐỘ CHỆCH (BIAS AUDIT) & GIẢI THÍCH 10 ĐẶC TRƯNG
             ----------------------------------------------------------------- */}
          {auditTab === "bias" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="grid">
                <div className="card" style={{ margin: 0 }}>
                  <h2>1. Kiểm toán Độ chệch Nền (Intercept Bias) &amp; Mất Cân Bằng Lớp</h2>
                  <div className="row">
                    <span>Tổng số cửa sổ huấn luyện công khai</span>
                    <b>
                      {audit.biasAudit.classImbalance.totalWindows.toLocaleString("vi-VN")} cửa sổ
                    </b>
                  </div>
                  <div className="row">
                    <span>Số cửa sổ Có Ngã vs Sinh Hoạt Thường</span>
                    <b>
                      {audit.biasAudit.classImbalance.fallWindows.toLocaleString("vi-VN")} (5.39%)
                      vs {audit.biasAudit.classImbalance.nonFallWindows.toLocaleString("vi-VN")}{" "}
                      (94.61%)
                    </b>
                  </div>
                  <div className="row">
                    <span>Tỷ lệ mất cân bằng lớp (Imbalance Ratio)</span>
                    <b>1 : {audit.biasAudit.classImbalance.imbalanceRatio.toFixed(2)}</b>
                  </div>
                  <div className="row">
                    <span>Độ chệch nền Hồi quy Logistic (Intercept w₀)</span>
                    <b>{audit.biasAudit.intercept.toFixed(6)}</b>
                  </div>
                  <div className="row">
                    <span>Ngưỡng xác suất (Logistic vs Student MLP)</span>
                    <b>
                      {audit.biasAudit.logisticThreshold.toFixed(5)} vs{" "}
                      {audit.biasAudit.mlpThreshold.toFixed(2)} (xác nhận 2 cửa sổ)
                    </b>
                  </div>
                  <div
                    style={{
                      marginTop: 10,
                      padding: 10,
                      borderRadius: 10,
                      background: "#fffbeb",
                      border: "1px solid #fde68a",
                      fontSize: 12.5,
                      lineHeight: 1.55,
                    }}
                  >
                    <b>Phát hiện kiểm toán:</b> Do huấn luyện với <code>class_weight=&quot;balanced&quot;</code>{" "}
                    (nhân trọng số lớp ngã lên 17.56 lần), phân phối xác suất đầu ra của Hồi quy
                    Logistic bị đẩy sát về phía 1.0, buộc ngưỡng quyết định phải đặt ở{" "}
                    <b>0.99078</b> mới kẹp được báo nhầm ≤ 6 lần/giờ. Ngược lại,{" "}
                    <b>Student MLP</b> được hiệu chuẩn tốt hơn nên ngưỡng quyết định nằm ở mức tự
                    nhiên <b>0.7600</b>.
                  </div>
                </div>

                <div className="card" style={{ margin: 0 }}>
                  <h2>2. Kiểm toán Công bằng Cá nhân (Subject Fairness — 15 Người)</h2>
                  <div className="row">
                    <span>Phương pháp kiểm chứng độc lập người</span>
                    <b>3-Fold Grouped Nested Cross-Validation</b>
                  </div>
                  <div className="row">
                    <span>Student MLP — Toàn tập vs Khác người (Nested CV)</span>
                    <b style={{ color: "#15803d" }}>
                      {(audit.biasAudit.subjectFairness.mlpPublicRecall * 100).toFixed(1)}% (5.5
                      FA/h) vs {(audit.biasAudit.subjectFairness.mlpNestedRecall * 100).toFixed(1)}%
                      (6.2 FA/h)
                    </b>
                  </div>
                  <div className="row">
                    <span>Hồi quy Logistic — Toàn tập vs Khác người (Nested CV)</span>
                    <b>
                      {(audit.biasAudit.subjectFairness.logPublicRecall * 100).toFixed(1)}% (5.8
                      FA/h) vs {(audit.biasAudit.subjectFairness.logNestedRecall * 100).toFixed(1)}%
                      (6.0 FA/h)
                    </b>
                  </div>
                  <div className="row">
                    <span>Độ lệch miền (Lab mm-ADL vs Nhà thật mm-ADL-Home)</span>
                    <b>
                      AUC {audit.biasAudit.domainBias.sourceDomain.auc.toFixed(3)} →{" "}
                      {audit.biasAudit.domainBias.targetDomain.auc.toFixed(3)}
                    </b>
                  </div>
                  <div
                    style={{
                      marginTop: 10,
                      padding: 10,
                      borderRadius: 10,
                      background: "#f0fdf4",
                      border: "1px solid #bbf7d0",
                      fontSize: 12.5,
                      lineHeight: 1.55,
                    }}
                  >
                    <b>Kết luận công bằng mô hình:</b> Sai lệch độ nhạy giữa tập huấn luyện và người
                    mới hoàn toàn chưa từng gặp trong 3-Fold Nested CV chỉ là <b>+1.0%</b> (32.8% →
                    33.8%), khẳng định mạng MLP không bị học vẹt theo chiều cao/thể trạng riêng của
                    từng tình nguyện viên.
                  </div>
                </div>
              </div>

              {/* Bảng Kiểm toán Dấu Vật lý 10 Đặc trưng */}
              <div className="card" style={{ margin: 0 }}>
                <h2>3. Bảng Kiểm Toán Dấu Vật Lý &amp; Trọng Số 10 Đặc Trưng Radar (f0..f9)</h2>
                <p className="sub" style={{ marginTop: 0 }}>
                  Kiểm tra tính nhất quán giữa bản chất vật lý của sóng mmWave 60GHz gắn trần
                  (2.7m), thống kê đơn biến (AUC, Cohen&apos;s d) và trọng số học máy thực tế trong{" "}
                  <code>include/model_weights.h</code> &amp; <code>include/nn_weights.h</code>:
                </p>
                <div className="scroll">
                  <table style={{ fontSize: 12.5 }}>
                    <thead>
                      <tr>
                        <th>Hạng</th>
                        <th>Mã &amp; Tên đặc trưng</th>
                        <th>Trọng số wᵢ</th>
                        <th>Odds Ratio (e^wᵢ)</th>
                        <th>TB Không ngã → Có ngã</th>
                        <th>AUC đơn</th>
                        <th>Chuẩn hóa MLP (μ / σ)</th>
                        <th>Trạng thái Kiểm toán</th>
                        <th>Giải thích Vật lý &amp; Toán học</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audit.biasAudit.features.map((f) => (
                        <tr key={f.code}>
                          <td style={{ fontWeight: 700, textAlign: "center" }}>#{f.absRank}</td>
                          <td>
                            <b>
                              {f.code} — {f.viName}
                            </b>
                            <div className="note">{f.physicalMeaning}</div>
                          </td>
                          <td
                            style={{
                              fontWeight: 800,
                              color:
                                Math.abs(f.weight) < 1e-5
                                  ? "#64748b"
                                  : f.weight > 0
                                    ? "#15803d"
                                    : "#dc2626",
                            }}
                          >
                            {f.weight >= 0 ? `+${f.weight.toFixed(4)}` : f.weight.toFixed(4)}
                          </td>
                          <td>
                            {f.weight > 10
                              ? `${(f.oddsRatio / 1e6).toFixed(2)}×10⁶`
                              : `${f.oddsRatio.toFixed(2)}×`}
                          </td>
                          <td>
                            {f.meanNonFall.toFixed(3)} → <b>{f.meanFall.toFixed(3)}</b>
                          </td>
                          <td>
                            <b>{f.singleAuc.toFixed(3)}</b>
                          </td>
                          <td className="note">
                            μ={f.scalerMean.toFixed(3)}
                            <br />
                            σ={f.scalerScale.toFixed(3)}
                          </td>
                          <td>
                            {f.signAuditStatus === "PASS" && (
                              <span
                                className="pill"
                                style={{ background: "#dcfce7", color: "#166534" }}
                              >
                                ĐÚNG VẬT LÝ
                              </span>
                            )}
                            {f.signAuditStatus === "COLLINEAR_COMPENSATION" && (
                              <span
                                className="pill"
                                style={{ background: "#dbeafe", color: "#1e40af" }}
                              >
                                BÙ ĐA CỘNG TUYẾN
                              </span>
                            )}
                            {f.signAuditStatus === "POST_FALL_DEFERRED" && (
                              <span
                                className="pill"
                                style={{ background: "#fef3c7", color: "#92400e" }}
                              >
                                HẬU KIỂM TƯ THẾ
                              </span>
                            )}
                          </td>
                          <td style={{ maxWidth: 380, lineHeight: 1.5 }}>{f.auditExplanation}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* -----------------------------------------------------------------
              TAB 3: CHƯNG CẤT TRI THỨC (TEACHER ENSEMBLE -> STUDENT ESP32-S3)
             ----------------------------------------------------------------- */}
          {auditTab === "distill" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="card" style={{ margin: 0 }}>
                <h2>Kiến trúc Chưng Cất Tri Thức (Knowledge Distillation) cho Vi điều khiển</h2>
                <p className="sub" style={{ marginTop: 0 }}>
                  {audit.distillation.whyDistill}
                </p>
                <div
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    background: "#0f172a",
                    color: "#f8fafc",
                    fontFamily: "monospace",
                    fontSize: 13,
                    marginBottom: 14,
                  }}
                >
                  <div>Chiến lược: {audit.distillation.strategy}</div>
                  <div style={{ color: "#38bdf8", marginTop: 4 }}>
                    Hàm mục tiêu: {audit.distillation.formula}
                  </div>
                </div>

                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Vai trò Mô hình</th>
                        <th>Kiến trúc</th>
                        <th>Tham số / Flash</th>
                        <th>Độ trễ suy luận</th>
                        <th>Recall @ ≤6 FA/h</th>
                        <th>Báo nhầm/giờ</th>
                        <th>ROC-AUC</th>
                        <th>Brier / ECE (Độ lệch hiệu chuẩn)</th>
                        <th>Chạy trên ESP32-S3</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audit.distillation.models.map((dm) => (
                        <tr
                          key={dm.role}
                          style={{
                            background: dm.role.includes("Distilled Student")
                              ? "#f0fdf4"
                              : undefined,
                          }}
                        >
                          <td>
                            <b>{dm.role}</b>
                            <div className="note">{dm.note}</div>
                          </td>
                          <td>{dm.architecture}</td>
                          <td>
                            <b>{dm.paramsCount.toLocaleString("vi-VN")}</b>
                            <div className="note">
                              {(dm.flashBytes / 1024).toFixed(2)} KB Flash
                            </div>
                          </td>
                          <td>{dm.latencyMs.toFixed(2)} ms</td>
                          <td>
                            <b style={{ color: "#15803d", fontSize: 14 }}>
                              {(dm.eventRecallAt6Fa * 100).toFixed(1)}%
                            </b>
                          </td>
                          <td>{dm.faPerHour.toFixed(1)} / giờ</td>
                          <td>{dm.rocAuc.toFixed(3)}</td>
                          <td>
                            Brier: {dm.brierScore.toFixed(3)}
                            <br />
                            <b>ECE: {(dm.ece * 100).toFixed(1)}%</b>
                          </td>
                          <td>
                            {dm.deployableOnEsp32 ? (
                              <span
                                className="pill"
                                style={{ background: "#dcfce7", color: "#166534" }}
                              >
                                CÓ (Nhúng trực tiếp)
                              </span>
                            ) : (
                              <span
                                className="pill"
                                style={{ background: "#f1f5f9", color: "#475569" }}
                              >
                                Chỉ chạy PC/Cloud
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* -----------------------------------------------------------------
              TAB 4: THƯ VIỆN BIỂU ĐỒ NGHIÊN CỨU (GALLERY + LIGHTBOX)
             ----------------------------------------------------------------- */}
          {auditTab === "gallery" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <div className="btns" style={{ margin: 0 }}>
                  <button
                    className={galleryFilter === "all" ? "b-main" : "b-gray"}
                    onClick={() => setGalleryFilter("all")}
                  >
                    Tất cả ({audit.images.length})
                  </button>
                  <button
                    className={galleryFilter === "confusion-bias" ? "b-main" : "b-gray"}
                    onClick={() => setGalleryFilter("confusion-bias")}
                  >
                    Ma trận nhầm lẫn &amp; Trọng số
                  </button>
                  <button
                    className={galleryFilter === "eda-signal" ? "b-main" : "b-gray"}
                    onClick={() => setGalleryFilter("eda-signal")}
                  >
                    Phân tích Tín hiệu &amp; Đặc trưng (EDA)
                  </button>
                  <button
                    className={galleryFilter === "domain-posture" ? "b-main" : "b-gray"}
                    onClick={() => setGalleryFilter("domain-posture")}
                  >
                    Đổi miền CORAL &amp; 5 Tư thế
                  </button>
                </div>
                <span className="note">
                  Bấm vào bất kỳ biểu đồ nào để phóng to toàn màn hình (Lightbox) hoặc tải ảnh gốc
                  độ phân giải cao.
                </span>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                  gap: 14,
                }}
              >
                {filteredImages.map((img) => (
                  <div
                    key={img.filename}
                    className="card"
                    style={{
                      margin: 0,
                      padding: 12,
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                    }}
                    onClick={() => setLightboxImg(img)}
                  >
                    <div>
                      <div
                        style={{
                          width: "100%",
                          height: 195,
                          background: "#f8fafc",
                          borderRadius: 8,
                          overflow: "hidden",
                          border: "1px solid #e2e8f0",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          marginBottom: 10,
                        }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={img.url}
                          alt={img.title}
                          style={{
                            maxWidth: "100%",
                            maxHeight: "100%",
                            objectFit: "contain",
                          }}
                          loading="lazy"
                        />
                      </div>
                      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
                        {img.title}
                      </div>
                      <div className="note" style={{ fontSize: 12, lineHeight: 1.45 }}>
                        {img.description}
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginTop: 10,
                        paddingTop: 8,
                        borderTop: "1px solid #f1f5f9",
                        fontSize: 11.5,
                        color: "#2563eb",
                        fontWeight: 600,
                      }}
                    >
                      <code>{img.filename}</code>
                      <span>Phóng to ↗</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal phóng to biểu đồ (Lightbox) */}
      {lightboxImg && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.82)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
          onClick={() => setLightboxImg(null)}
        >
          <div
            className="card"
            style={{
              maxWidth: "92vw",
              maxHeight: "92vh",
              overflow: "auto",
              padding: 20,
              background: "#ffffff",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 16,
                marginBottom: 12,
              }}
            >
              <div>
                <h2 style={{ margin: 0 }}>{lightboxImg.title}</h2>
                <div className="sub" style={{ margin: "4px 0 0 0" }}>
                  {lightboxImg.description} (<code>{lightboxImg.filename}</code>)
                </div>
              </div>
              <div className="btns" style={{ margin: 0 }}>
                <a
                  href={lightboxImg.url}
                  download={lightboxImg.filename}
                  className="b-main"
                  style={{ textDecoration: "none", padding: "8px 14px", borderRadius: 10 }}
                >
                  Tải ảnh PNG gốc
                </a>
                <button className="b-gray" onClick={() => setLightboxImg(null)}>
                  Đóng ✕
                </button>
              </div>
            </div>
            <div style={{ textAlign: "center", background: "#f8fafc", padding: 12, borderRadius: 10 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={lightboxImg.url}
                alt={lightboxImg.title}
                style={{ maxWidth: "85vw", maxHeight: "75vh", objectFit: "contain" }}
              />
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          PHẦN 2: SỐ LIỆU ĐO THỰC NGHIỆM TRỰC TIẾP TRÊN THIẾT BỊ (GIỮ NGUYÊN)
         ===================================================================== */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="inline">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Phiên đo thực nghiệm tại chỗ</span>
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
          Chưa có lần thử thực nghiệm nào tại chỗ đã kết thúc. Sang trang <b>Đo thực nghiệm</b> để
          bắt đầu đo thêm với phần cứng thật, hoặc sử dụng <b>Trung tâm Kiểm toán AI</b> ở phía trên
          cho chương Đánh giá mô hình.
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
        <h2>Chỉ số đánh giá phiên đo thực nghiệm{data?.session ? ` — ${data.session.name}` : ""}</h2>
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
          <h2>Ma trận nhầm lẫn (Phiên đo thực nghiệm)</h2>
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
