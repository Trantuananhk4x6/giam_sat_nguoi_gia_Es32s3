"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LivePayload } from "@/lib/types";

/**
 * Hook hỏi /api/live theo chu kỳ.
 *
 * Dùng cách hỏi lại định kỳ (polling) thay vì WebSocket vì:
 *   - firmware đã có WebSocket riêng cho trang của nó;
 *   - dashboard hỏi mỗi 1,5 giây là đủ nhanh để theo dõi quy trình 30 giây,
 *     mà lại không bị rắc rối khi Next.js nạp lại code lúc đang lập trình.
 *
 * Chu kỳ tiếp theo chỉ được hẹn SAU KHI lời gọi trước xong, nên mạng chậm cũng
 * không bị dồn hàng loạt yêu cầu.
 */
export function useLive(intervalMs = 1500) {
  const [data, setData] = useState<LivePayload | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch("/api/live", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as LivePayload;
      if (alive.current) {
        setData(json);
        setNetError(null);
      }
    } catch (err) {
      if (alive.current) {
        setNetError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const loop = async () => {
      await fetchOnce();
      if (alive.current) timer.current = setTimeout(loop, intervalMs);
    };
    void loop();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fetchOnce, intervalMs]);

  return { data, netError, refresh: fetchOnce };
}

/** Gửi một thao tác xuống ESP32 qua máy chủ Next.js */
export async function sendAction(name: string): Promise<string | null> {
  try {
    const res = await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    return json.ok ? null : (json.error ?? "Không gửi được thao tác");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
