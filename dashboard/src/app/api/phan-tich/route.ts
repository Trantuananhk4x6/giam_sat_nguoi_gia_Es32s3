/**
 * POST /api/phan-tich
 *
 * Nhờ một mô hình ngôn ngữ trên cloud đọc số liệu thực nghiệm rồi viết nhận xét
 * cho chương "Đánh giá, phân tích các ca sai" của báo cáo.
 *
 * HAI NHÀ CUNG CẤP, TỰ CHỌN THEO API KEY CÓ SẴN
 *   - ANTHROPIC_API_KEY  -> Claude (chất lượng viết tốt nhất, trả phí nhưng rất rẻ:
 *                           một lần phân tích tốn khoảng 0,05–0,1 USD)
 *   - GEMINI_API_KEY     -> Google Gemini (có bậc miễn phí, lấy key ở
 *                           https://aistudio.google.com/apikey)
 *   Khai một trong hai vào dashboard/.env.local. Nếu có cả hai thì Claude được ưu tiên,
 *   trừ khi gửi kèm { provider: "gemini" }.
 *
 * KHÔNG CÓ KEY NÀO cũng không sao: trang Báo cáo vẫn đầy đủ số liệu và biểu đồ,
 * chỉ thiếu phần nhận xét bằng lời.
 *
 * LƯU Ý: dữ liệu gửi lên cloud chỉ là SỐ LIỆU TỔNG HỢP (số lần đúng/sai, thời gian
 * trễ). Không gửi tên người được giám sát, không gửi gì liên quan đời tư.
 */
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { computeMetrics } from "@/lib/metrics";
import { getModel, getSessions, getTrials } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Gom số liệu thành một bản mô tả gọn để đưa cho mô hình đọc */
async function buildBrief(sessionId: string | null): Promise<string> {
  const [sessions, allTrials, stored] = await Promise.all([
    getSessions(),
    getTrials(),
    getModel(),
  ]);
  const session = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const trials = sessionId ? allTrials.filter((t) => t.sessionId === sessionId) : allTrials;
  const m = computeMetrics(trials);

  const lines: string[] = [];
  lines.push("## Cấu hình đo");
  lines.push(`- Phiên đo: ${session?.name ?? "tất cả các phiên"}`);
  if (session) {
    lines.push(`- Chiều cao lắp radar: ${session.installHeightCm} cm`);
    lines.push(`- Độ nhạy phát hiện té ngã: ${session.sensitivity}/3`);
    if (session.note) lines.push(`- Ghi chú: ${session.note}`);
  }

  lines.push("", "## Kết quả tổng hợp");
  lines.push(`- Tổng số lần thử: ${m.totalTrials}`);
  lines.push(
    `- TP=${m.confusion.TP}, FP=${m.confusion.FP}, FN=${m.confusion.FN}, TN=${m.confusion.TN}`,
  );
  const p = (v: number | null) => (v === null ? "không tính được" : `${(v * 100).toFixed(1)}%`);
  lines.push(`- Precision: ${p(m.precision)}, Recall: ${p(m.recall)}, F1: ${p(m.f1)}`);
  const s = (v: number | null) => (v === null ? "—" : `${(v / 1000).toFixed(1)} s`);
  lines.push(
    `- Trễ cảnh báo (radar báo ngã -> Telegram gửi xong): trung bình ${s(
      m.alertLatency.meanMs,
    )}, lớn nhất ${s(m.alertLatency.maxMs)} (${m.alertLatency.count} mẫu)`,
  );
  lines.push(
    `- Thời gian người dùng bấm "Tôi ổn": trung bình ${s(m.responseLatency.meanMs)}`,
  );
  if (m.cooldownIgnored > 0) {
    lines.push(`- Có ${m.cooldownIgnored} lần thử rơi vào thời gian nghỉ 60 giây của firmware`);
  }

  lines.push("", "## Chi tiết theo kịch bản");
  for (const sc of m.scenarios) {
    lines.push(
      `- ${sc.scenarioName} [${sc.group}]: đã đo ${sc.done}/${sc.target}, ` +
        `đúng ${sc.correct}, sai ${sc.wrong} ` +
        `(TP ${sc.outcomes.TP}, FP ${sc.outcomes.FP}, FN ${sc.outcomes.FN}, TN ${sc.outcomes.TN})`,
    );
  }

  const notes = trials
    .filter((t) => t.note && t.outcome && (t.outcome === "FP" || t.outcome === "FN"))
    .slice(0, 25)
    .map((t) => `- [${t.outcome}] ${t.scenarioName}: ${t.note}`);
  if (notes.length) {
    lines.push("", "## Ghi chú của người đo ở các ca sai");
    lines.push(...notes);
  }

  if (stored) {
    const ts = stored.testScores as { precision: number | null; recall: number | null; f1: number | null };
    lines.push("", "## Model hồi quy logistic tự huấn luyện (chạy song song)");
    lines.push(
      `- Trên tập kiểm tra: Precision ${p(ts.precision)}, Recall ${p(ts.recall)}, F1 ${p(ts.f1)}`,
    );
    lines.push(
      `- Tập dữ liệu: ${stored.datasetInfo.train} cửa sổ huấn luyện, ${stored.datasetInfo.test} cửa sổ kiểm tra`,
    );
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT = `Bạn là người hướng dẫn đồ án tốt nghiệp ngành điện tử - viễn thông ở Việt Nam.
Sinh viên đang làm hệ thống phát hiện té ngã cho người cao tuổi dùng radar 60 GHz và ESP32-S3.
Hãy đọc số liệu thực nghiệm và viết nhận xét bằng TIẾNG VIỆT, dùng cho chương
"Đánh giá kết quả" của báo cáo.

Yêu cầu:
- Viết thẳng vào vấn đề, không khen sáo rỗng.
- Nêu rõ điểm mạnh và điểm yếu của hệ thống dựa trên con số, có dẫn số liệu cụ thể.
- Giải thích nguyên nhân kỹ thuật có thể gây ra các ca FP và FN, gắn với đặc tính
  của radar sóng milimet (góc quét, chiều cao lắp, ngưỡng độ nhạy, thời gian xác nhận).
- Chỉ ra chỗ nào số liệu còn chưa đủ để kết luận, nói rõ là chưa đủ.
- Đề xuất 3-5 việc cụ thể nên làm tiếp để cải thiện.
- Nêu 3 câu hỏi mà hội đồng bảo vệ có khả năng sẽ hỏi, kèm gợi ý trả lời ngắn.
- Dùng markdown, tiêu đề cấp 2, tổng độ dài khoảng 500-700 từ.
- Nếu số liệu quá ít để kết luận, hãy nói thẳng điều đó ngay đầu bài thay vì
  phân tích quá mức.`;

async function askClaude(brief: string): Promise<string> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Số liệu thực nghiệm:\n\n${brief}` }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Mô hình từ chối trả lời yêu cầu này.");
  }
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function askGemini(brief: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY!;
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
  const res = await fetch(`${url}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: `Số liệu thực nghiệm:\n\n${brief}` }] }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini trả về HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini không trả về nội dung nào.");
  return text;
}

async function askGroq(brief: string): Promise<string> {
  const key = process.env.GROQ_API_KEY!;
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      temperature: 0.4,
      max_tokens: 4000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `So lieu thuc nghiem:\n\n${brief}` },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const b = await res.text();
    throw new Error(`Groq tra ve HTTP ${res.status}: ${b.slice(0, 200)}`);
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Groq khong tra ve noi dung nao.");
  return text;
}
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    sessionId?: string | null;
    provider?: "claude" | "gemini" | "groq";
  };

  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const hasGroq = Boolean(process.env.GROQ_API_KEY);
  const want = body.provider ?? (hasClaude ? "claude" : hasGemini ? "gemini" : "groq");

  if (want === "claude" && !hasClaude) {
    return NextResponse.json(
      {
        error:
          "Chưa khai ANTHROPIC_API_KEY trong dashboard/.env.local. " +
          "Hoặc dùng bản miễn phí: lấy key ở https://aistudio.google.com/apikey rồi " +
          "khai GEMINI_API_KEY.",
      },
      { status: 400 },
    );
  }
  if (want === "gemini" && !hasGemini) {
    return NextResponse.json(
      {
        error:
          "Chưa khai GEMINI_API_KEY trong dashboard/.env.local. " +
          "Lấy key miễn phí ở https://aistudio.google.com/apikey",
      },
      { status: 400 },
    );
  }

  if (want === "groq" && !hasGroq) {
    return NextResponse.json(
      { error: "Chua khai GROQ_API_KEY trong dashboard/.env.local. Lay key mien phi o https://console.groq.com/keys" },
      { status: 400 },
    );
  }

  try {
    const brief = await buildBrief(body.sessionId ?? null);
    const text =
      want === "claude" ? await askClaude(brief)
      : want === "groq" ? await askGroq(brief)
      : await askGemini(brief);
    return NextResponse.json({ provider: want, brief, text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
