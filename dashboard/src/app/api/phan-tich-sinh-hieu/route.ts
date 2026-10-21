/**
 * POST /api/phan-tich-sinh-hieu
 *
 * Nhờ LLM trên Groq (Llama) ĐỌC các số nhịp tim / nhịp thở mà radar C1001 đã ước
 * lượng, rồi DIỄN GIẢI BẰNG LỜI cho người nhà dễ hiểu ("nhịp tim hơi thấp, có thể
 * do đang ngủ sâu, theo dõi thêm"...).
 *
 * RANH GIỚI AN TOÀN (BẮT BUỘC):
 *   - Đây KHÔNG phải thiết bị y tế. Số liệu là ƯỚC LƯỢNG bằng sóng radar.
 *   - AI CHỈ nhận xét xu hướng bằng lời, TUYỆT ĐỐI không chẩn đoán bệnh, không kê
 *     đơn, không khuyên điều trị. Luôn kèm câu nhắc hỏi bác sĩ.
 *   - Groq chỉ nhận các CON SỐ sinh hiệu + bối cảnh, không nhận tên/PII.
 *
 * Lay key mien phi o https://console.groq.com/keys -> khai GROQ_API_KEY trong
 * dashboard/.env.local.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type VitalsIn = {
  valid?: boolean;
  heartRate?: number;
  breatheValue?: number;
  breatheState?: number;
  inBed?: number;
  sleepState?: number;
  sleepScore?: number;
  struggle?: number;
};

const SLEEP = ["ngu sau", "ngu nong", "tinh", "khong co nguoi"];

const SYSTEM_PROMPT = `Bạn là trợ lý theo dõi sức khỏe cho GIA ĐÌNH người cao tuổi, nói TIẾNG VIỆT, giọng ấm áp, dễ hiểu.
Bạn nhận các số liệu sinh hiệu ƯỚC LƯỢNG bằng radar sóng milimet (KHÔNG phải thiết bị y tế).

Nhiệm vụ: diễn giải các con số thành vài câu ngắn gọn, dễ hiểu cho người nhà không rành y khoa.

RÀNG BUỘC BẮT BUỘC — không được vi phạm:
- TUYỆT ĐỐI KHÔNG chẩn đoán bệnh, KHÔNG gọi tên bệnh, KHÔNG kê đơn, KHÔNG khuyên dùng thuốc hay điều trị.
- Chỉ mô tả xu hướng ("bình thường", "hơi cao/thấp so với mức nghỉ thông thường", "ổn định").
- Luôn nhắc rằng đây là ƯỚC LƯỢNG bằng radar, không phải chẩn đoán y tế.
- Nếu số liệu bất thường rõ, khuyên NHẸ NHÀNG là nên gọi điện hỏi thăm / đưa đi khám nếu thấy lo, chứ không khẳng định có vấn đề.
- Nếu không đủ dữ liệu (chưa đo được / radar đang ở chế độ phát hiện té ngã), nói thẳng là chưa đo được, đừng bịa.
- Độ dài: 3-6 câu. Không dùng markdown tiêu đề, chỉ văn xuôi ngắn.
- Kết thúc BẮT BUỘC bằng đúng câu: "(Đây là ước lượng bằng radar, không thay thế thăm khám của bác sĩ.)"`;

function buildBrief(v: VitalsIn): string {
  if (!v.valid) {
    return "Hiện CHƯA đo được sinh hiệu (radar đang ở chế độ phát hiện té ngã, hoặc chưa có người nằm yên đủ lâu trên giường).";
  }
  const lines: string[] = [];
  lines.push("Số liệu sinh hiệu ước lượng gần nhất:");
  lines.push(`- Nhịp tim: ${v.heartRate || 0} nhịp/phút`);
  lines.push(`- Nhịp thở: ${v.breatheValue || 0} lần/phút`);
  lines.push(`- Trên giường: ${v.inBed ? "có" : "không"}`);
  lines.push(`- Trạng thái giấc ngủ: ${SLEEP[v.sleepState ?? 3] ?? "khong ro"}`);
  if (typeof v.sleepScore === "number") lines.push(`- Điểm chất lượng giấc ngủ (0-100): ${v.sleepScore}`);
  if (v.struggle) lines.push("- Radar ghi nhận VÙNG VẪY BẤT THƯỜNG trong lúc ngủ.");
  lines.push("", "Mức tham khảo người lớn lúc nghỉ: nhịp tim ~60-100, nhịp thở ~12-20. Ban đêm/ngủ sâu thường thấp hơn.");
  return lines.join("\n");
}

async function askGroq(brief: string): Promise<string> {
  const key = process.env.GROQ_API_KEY!;
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      temperature: 0.4,
      max_tokens: 500,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: brief },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq trả về HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Groq không trả về nội dung nào.");
  return text.trim();
}

export async function POST(req: Request) {
  if (!process.env.GROQ_API_KEY) {
    return NextResponse.json(
      {
        error:
          "Chưa khai GROQ_API_KEY trong dashboard/.env.local. " +
          "Lấy key miễn phí ở https://console.groq.com/keys",
      },
      { status: 400 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as { vitals?: VitalsIn };
  try {
    const brief = buildBrief(body.vitals ?? {});
    const text = await askGroq(brief);
    return NextResponse.json({ provider: "groq", brief, text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}