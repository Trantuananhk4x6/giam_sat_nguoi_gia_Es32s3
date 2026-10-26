/**
 * API Quản lý Danh bạ Người nhà & Gửi thử lời nhắn giọng nói (Voice Relay)
 *
 * GET    /api/contacts
 *        Trả danh sách danh bạ (`contacts`), trạng thái các kênh gửi tin (`channels`: Telegram, Zalo, Email)
 *        và nhãn người gửi (`relayLabel`).
 *
 * POST   /api/contacts
 *        Hỗ trợ 4 chế độ (theo trường `action` hoặc tự suy từ dữ liệu gửi lên):
 *        1. `action: "save"` (hoặc mặc định khi có `name`): Thêm mới / cập nhật người nhận trong danh bạ.
 *        2. `action: "test"`: Gửi tin nhắn thử (`sendTestToContact`) tới một liên hệ theo `id` / `contactId`.
 *        3. `action: "plan"`: Phân tích thử câu lệnh giọng nói (`planRelay(text)`), chưa gửi thật.
 *        4. `action: "relay"`: Chạy thử câu lệnh giọng nói từ web (`relayFromElder(text, "web")`), gửi thật tới người nhà.
 *
 * DELETE /api/contacts?id=<id> (hoặc JSON body `{ id }`)
 *        Xóa một liên hệ khỏi danh bạ theo `id`.
 */
import { NextResponse } from "next/server";
import { notifyChannels } from "@/lib/notify";
import { planRelay, relayFromElder, relayLabelOf, sendTestToContact } from "@/lib/relay";
import { deleteContact, getContacts, getSettings, saveContact } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseAliases(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((x) => (typeof x === "string" ? x.normalize("NFC").trim() : ""))
      .filter(Boolean)
      .slice(0, 12);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,;]+/)
      .map((x) => x.normalize("NFC").trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  return [];
}

export async function GET() {
  const [contacts, settings] = await Promise.all([getContacts(), getSettings()]);
  return NextResponse.json({
    contacts,
    channels: notifyChannels(),
    relayLabel: relayLabelOf(settings),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ." }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action.trim() : "";

  // 1. Gửi tin nhắn thử tới một người trong danh bạ
  if (action === "test" || typeof body.testContactId === "string") {
    const targetId = String(body.contactId ?? body.testContactId ?? body.id ?? "").trim();
    if (!targetId) {
      return NextResponse.json({ error: "Thiếu mã liên hệ cần gửi thử." }, { status: 400 });
    }
    const contacts = await getContacts();
    const contact = contacts.find((c) => c.id === targetId);
    if (!contact) {
      return NextResponse.json({ error: "Không tìm thấy người nhận trong danh bạ." }, { status: 404 });
    }
    if (!contact.telegramChatId && !contact.zaloChatId && !contact.email) {
      return NextResponse.json(
        { error: `${contact.name} chưa khai Telegram, Zalo hay Email để gửi thử.` },
        { status: 400 },
      );
    }
    const delivery = await sendTestToContact(contact);
    const ok = delivery.length > 0 && delivery.every((d) => d.ok);
    const anyOk = delivery.some((d) => d.ok);
    return NextResponse.json({
      ok: anyOk,
      allOk: ok,
      contact,
      delivery,
    });
  }

  // 2. Phân tích thử câu lệnh giọng nói (Xem trước người nhận + nội dung, chưa gửi)
  if (action === "plan" || (body.preview === true && (typeof body.text === "string" || typeof body.heard === "string"))) {
    const text = String(body.text ?? body.heard ?? "").trim();
    if (!text) {
      return NextResponse.json({ error: "Vui lòng nhập câu nói cần phân tích thử." }, { status: 400 });
    }
    const plan = await planRelay(text);
    return NextResponse.json({
      ok: true,
      isRelayCommand: plan !== null,
      plan,
    });
  }

  // 3. Chạy thử câu lệnh giọng nói từ web (gửi thật tới người nhận trong danh bạ)
  if (action === "relay" || (!("name" in body) && (typeof body.text === "string" || typeof body.heard === "string"))) {
    const text = String(body.text ?? body.heard ?? "").trim();
    if (!text) {
      return NextResponse.json({ error: "Vui lòng nhập câu nói của người cao tuổi." }, { status: 400 });
    }
    const outcome = await relayFromElder(text, "web");
    if (!outcome) {
      return NextResponse.json({
        ok: false,
        isRelayCommand: false,
        error:
          "Câu này không giống lệnh gửi lời nhắn (ví dụ: “Gửi cho Tuấn là tối nay gọi cho mẹ lúc 8h nhé”). Thiết bị sẽ chuyển sang trò chuyện bình thường với trợ lý.",
      });
    }
    return NextResponse.json({
      ok: outcome.relay.status === "da-gui" || outcome.relay.status === "gui-mot-phan",
      isRelayCommand: true,
      reply: outcome.reply,
      relay: outcome.relay,
      ai: outcome.ai,
    });
  }

  // 4. Thêm mới hoặc cập nhật người nhận trong danh bạ
  const name = typeof body.name === "string" ? body.name.normalize("NFC").trim().slice(0, 40) : "";
  if (!name) {
    return NextResponse.json({ error: "Vui lòng nhập tên gọi của người nhà (ví dụ: Tuấn, Lan)." }, { status: 400 });
  }

  const aliases = parseAliases(body.aliases);
  const telegramChatId = typeof body.telegramChatId === "string" ? body.telegramChatId.trim().slice(0, 40) : "";
  const zaloChatId =
    typeof body.zaloChatId === "string" ? body.zaloChatId.trim().slice(0, 60) : undefined;
  const email = typeof body.email === "string" ? body.email.trim().slice(0, 120) : "";
  const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined;

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Địa chỉ email không hợp lệ." }, { status: 400 });
  }

  const contact = await saveContact({
    id,
    name,
    aliases,
    telegramChatId,
    zaloChatId,
    email,
  });

  return NextResponse.json({
    ok: true,
    contact,
    contacts: await getContacts(),
    message: id ? `Đã cập nhật liên hệ "${contact.name}".` : `Đã thêm "${contact.name}" vào danh bạ người nhà.`,
  });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  let id = (url.searchParams.get("id") ?? "").trim();
  if (!id) {
    const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
    if (body && typeof body.id === "string") id = body.id.trim();
  }
  if (!id) {
    return NextResponse.json({ error: "Thiếu mã liên hệ (id) cần xóa." }, { status: 400 });
  }
  const deleted = await deleteContact(id);
  if (!deleted) {
    return NextResponse.json({ error: "Không tìm thấy liên hệ cần xóa." }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    contacts: await getContacts(),
    message: "Đã xóa liên hệ khỏi danh bạ.",
  });
}
