/**
 * GET /api/export?kind=trials|events|summary|train&sessionId=...&fmt=xlsx|csv
 *
 * Xuất dữ liệu để đưa vào chương thực nghiệm.
 *   - fmt=xlsx (mặc định cho nút trên giao diện): file Excel .xlsx thật, mỗi
 *     loại một sheet, có định dạng tiêu đề, cố định dòng tiêu đề, auto-fit cột.
 *     Tiếng Việt hiển thị đúng, không cần mẹo BOM như CSV.
 *   - fmt=csv: giữ nguyên CSV (BOM UTF-8) cho ai vẫn cần.
 */
import { FEATURE_SPEC_VERSION, WINDOW_SIZE } from "@/lib/features";
import { computeMetrics, pct } from "@/lib/metrics";
import { pollerSnapshot } from "@/lib/poller";
import { getEvents, getSamples, getSessions, getTrials } from "@/lib/store";
import ExcelJS from "exceljs";

/**
 * kind=train: MỘT file JSON chứa chuỗi đặc trưng + các lần thử + cấu hình radar,
 * để upload lên Kaggle chạy notebook tools/kaggle/huan_luyen_model_te_nga.ipynb.
 * Mẫu ghi dạng mảng (theo "columns") cho file gọn.
 */
async function trainBundle(): Promise<Response> {
  const [samples, sessions, trials] = await Promise.all([getSamples(), getSessions(), getTrials()]);
  const cfg = pollerSnapshot().status?.config;
  const body = {
    format: "oalpha-train-v1",
    exportedAt: Date.now(),
    featureSpec: FEATURE_SPEC_VERSION,
    window: WINDOW_SIZE,
    periodMs: 250,
    device: {
      installHeightCm: cfg?.installHeightCm ?? null,
      sensitivity: cfg?.sensitivity ?? null,
      fallTimeS: cfg?.fallTimeS ?? 5,
    },
    columns: ["t", "present", "movement", "range", "staticStay", "distanceCm", "trackX", "trackY", "recvAt"],
    samples: samples.map((s) => [s.t, s.present, s.movement, s.range, s.staticStay, s.distanceCm, s.trackX, s.trackY, s.recvAt]),
    sessions,
    trials: trials.filter((t) => t.endedAt !== null),
  };
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="oalpha_du_lieu_huan_luyen.json"',
    },
  });
}

export const dynamic = "force-dynamic";

const BOM = "\uFEFF";

/** Một "trang tính": tên sheet + các dòng (dòng đầu thường là tiêu đề cột). */
type Sheet = { name: string; rows: unknown[][] };

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows: unknown[][]): string {
  return BOM + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/**
 * Dựng workbook Excel từ danh sách sheet.
 * - Dòng đầu mỗi sheet in đậm, nền xanh, chữ trắng, cố định (freeze) để cuộn vẫn thấy.
 * - Độ rộng cột tự co theo nội dung (giới hạn 60 ký tự cho khỏi quá rộng).
 */
async function buildXlsx(sheets: Sheet[]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Dashboard canh bao te nga";
  wb.created = new Date();

  for (const s of sheets) {
    // Tên sheet trong Excel không được chứa : \ / ? * [ ] và tối đa 31 ký tự.
    const safeName = s.name.replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Sheet";
    const ws = wb.addWorksheet(safeName, { views: [{ state: "frozen", ySplit: 1 }] });

    s.rows.forEach((r) => ws.addRow(r));

    // Định dạng dòng tiêu đề (dòng 1).
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
    header.alignment = { vertical: "middle", horizontal: "left" };
    header.height = 20;

    // Tự co độ rộng cột theo nội dung dài nhất.
    const colCount = s.rows.reduce((m, r) => Math.max(m, r.length), 0);
    for (let c = 1; c <= colCount; c++) {
      let max = 10;
      s.rows.forEach((r) => {
        const v = r[c - 1];
        if (v !== null && v !== undefined) max = Math.max(max, String(v).length + 2);
      });
      ws.getColumn(c).width = Math.min(max, 60);
    }
  }

  // exceljs trả về ArrayBuffer (kiểu khai báo là ArrayBufferLike) -> copy sang
  // một ArrayBuffer "thuần" để hợp kiểu BlobPart của DOM lib.
  const buf = await wb.xlsx.writeBuffer();
  const u8 = new Uint8Array(buf as ArrayBuffer);
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

function dt(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString("vi-VN") : "";
}

function secOrBlank(a: number | null, b: number | null): string {
  if (a === null || b === null) return "";
  return ((a - b) / 1000).toFixed(2);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? "trials";
  const sessionId = url.searchParams.get("sessionId");
  // Mặc định xuất Excel; truyền fmt=csv nếu vẫn muốn CSV.
  const fmt = (url.searchParams.get("fmt") ?? "xlsx").toLowerCase();
  if (kind === "train") return trainBundle();

  const [sessions, allTrials] = await Promise.all([getSessions(), getTrials()]);
  const session = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const trials = sessionId ? allTrials.filter((t) => t.sessionId === sessionId) : allTrials;

  // Mỗi loại chuẩn bị dữ liệu dạng sheet (tên file bỏ phần đuôi, thêm sau).
  let sheets: Sheet[] = [];
  let baseName = "xuat";

  if (kind === "events") {
    const events = await getEvents();
    sheets = [
      {
        name: "Nhat ky su kien",
        rows: [
          ["id", "thoi_diem_nhan", "gio_thiet_bi", "uptime_s", "ma_su_kien", "ten_su_kien", "nguon", "trang_thai", "ghi_chu"],
          ...events.map((e) => [
            e.id,
            dt(e.recvAt),
            e.ts > 1600000000 ? new Date(e.ts * 1000).toLocaleString("vi-VN") : "",
            e.uptime,
            e.type,
            e.label,
            e.src,
            e.state,
            e.note,
          ]),
        ],
      },
    ];
    baseName = "nhat_ky_su_kien";
  } else if (kind === "summary") {
    const m = computeMetrics(trials);
    const rows: unknown[][] = [
      ["BANG TONG HOP KET QUA THUC NGHIEM"],
      ["Phien do", session?.name ?? "Tat ca cac phien"],
      ["Chieu cao lap (cm)", session?.installHeightCm ?? ""],
      ["Do nhay radar (0-3)", session?.sensitivity ?? ""],
      ["Xuat luc", new Date().toLocaleString("vi-VN")],
      [],
      ["Kich ban", "Nhom", "Muc tieu", "Da thu", "Dung", "Sai", "Ty le dung", "TP", "FP", "FN", "TN"],
      ...m.scenarios.map((s) => [
        s.scenarioName,
        s.group,
        s.target,
        s.done,
        s.correct,
        s.wrong,
        pct(s.accuracy),
        s.outcomes.TP,
        s.outcomes.FP,
        s.outcomes.FN,
        s.outcomes.TN,
      ]),
      [],
      ["CHI SO CHUNG"],
      ["Tong so lan thu", m.totalTrials],
      ["TP (phat hien dung)", m.confusion.TP],
      ["FP (bao nham)", m.confusion.FP],
      ["FN (bo sot)", m.confusion.FN],
      ["TN (dung khi khong nga)", m.confusion.TN],
      ["Do chinh xac - Precision = TP/(TP+FP)", pct(m.precision)],
      ["Do nhay - Recall = TP/(TP+FN)", pct(m.recall)],
      ["F1 = 2PR/(P+R)", pct(m.f1)],
      ["Accuracy = (TP+TN)/tong", pct(m.accuracy)],
      [],
      ["THOI GIAN (giay)", "So mau", "Trung binh", "Lon nhat", "Nho nhat"],
      [
        "Tu luc bat dau lan thu den khi radar bao nga",
        m.detectLatency.count,
        m.detectLatency.meanMs !== null ? (m.detectLatency.meanMs / 1000).toFixed(2) : "",
        m.detectLatency.maxMs !== null ? (m.detectLatency.maxMs / 1000).toFixed(2) : "",
        m.detectLatency.minMs !== null ? (m.detectLatency.minMs / 1000).toFixed(2) : "",
      ],
      [
        "Tu luc radar bao nga den khi gui xong Telegram",
        m.alertLatency.count,
        m.alertLatency.meanMs !== null ? (m.alertLatency.meanMs / 1000).toFixed(2) : "",
        m.alertLatency.maxMs !== null ? (m.alertLatency.maxMs / 1000).toFixed(2) : "",
        m.alertLatency.minMs !== null ? (m.alertLatency.minMs / 1000).toFixed(2) : "",
      ],
      [
        "Thoi gian nguoi dung bam Toi on",
        m.responseLatency.count,
        m.responseLatency.meanMs !== null ? (m.responseLatency.meanMs / 1000).toFixed(2) : "",
        m.responseLatency.maxMs !== null ? (m.responseLatency.maxMs / 1000).toFixed(2) : "",
        m.responseLatency.minMs !== null ? (m.responseLatency.minMs / 1000).toFixed(2) : "",
      ],
    ];
    sheets = [{ name: "Tong hop", rows }];
    baseName = "tong_hop_thuc_nghiem";
  } else {
    const rows: unknown[][] = [
      [
        "stt",
        "phien_do",
        "chieu_cao_cm",
        "do_nhay",
        "kich_ban",
        "ky_vong_nga",
        "bat_dau",
        "ket_qua",
        "cham_tay",
        "tre_phat_hien_s",
        "tre_canh_bao_s",
        "tre_tong_s",
        "thoi_gian_phan_hoi_s",
        "bi_bo_qua_do_thoi_gian_nghi",
        "ghi_chu",
      ],
      ...trials
        .slice()
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((t, i) => {
          const ss = sessions.find((s) => s.id === t.sessionId);
          return [
            i + 1,
            ss?.name ?? "",
            ss?.installHeightCm ?? "",
            ss?.sensitivity ?? "",
            t.scenarioName,
            t.expectFall ? "co" : "khong",
            dt(t.startedAt),
            t.outcome ?? "",
            t.manualOutcome ? "x" : "",
            secOrBlank(t.detectedAt, t.startedAt),
            t.deviceAlertMs !== null ? (t.deviceAlertMs / 1000).toFixed(2) : secOrBlank(t.telegramAt, t.detectedAt),
            secOrBlank(t.telegramAt, t.startedAt),
            t.deviceResponseMs !== null ? (t.deviceResponseMs / 1000).toFixed(2) : secOrBlank(t.cancelledAt, t.detectedAt),
            t.cooldownIgnored ? "x" : "",
            t.note,
          ];
        }),
    ];
    sheets = [{ name: "Chi tiet tung lan", rows }];
    baseName = "chi_tiet_tung_lan_thu";
  }

  if (fmt === "csv") {
    // CSV chỉ xuất sheet đầu (giữ đúng hành vi cũ).
    const csv = rowsToCsv(sheets[0].rows);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${baseName}.csv"`,
      },
    });
  }

  const xlsx = await buildXlsx(sheets);
  // Bọc trong Blob: kiểu BodyInit (DOM lib) chấp nhận Blob, còn Next.js chạy tốt.
  const blob = new Blob([xlsx], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return new Response(blob, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${baseName}.xlsx"`,
    },
  });
}
