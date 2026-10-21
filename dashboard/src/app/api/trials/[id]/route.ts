/**
 * Sửa / xóa một lần thử đã kết thúc.
 *   PATCH  /api/trials/<id>   body: { outcome?, note? }  -> chấm lại bằng tay
 *   DELETE /api/trials/<id>                              -> bỏ lần thử lỗi
 */
import { NextResponse } from "next/server";
import { deleteTrial } from "@/lib/store";
import { editTrial } from "@/lib/trials";
import type { Outcome } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json()) as { outcome?: Outcome | null; note?: string };
  try {
    const trial = await editTrial(id, body);
    return NextResponse.json(trial);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 404 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  await deleteTrial(id);
  return NextResponse.json({ ok: true });
}
