"use client";

import { dateTimeOf } from "@/lib/format";
import type { StoredEvent } from "@/lib/types";

export default function EventTable({
  events,
  limit = 40,
}: {
  events: StoredEvent[];
  limit?: number;
}) {
  const rows = events.slice(0, limit);
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Thời điểm</th>
            <th>Sự kiện</th>
            <th>Nguồn</th>
            <th>Trạng thái</th>
            <th>Ghi chú của firmware</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="note">
                Chưa thu được sự kiện nào. Hãy kiểm tra địa chỉ ESP32 ở trang Cài đặt.
              </td>
            </tr>
          )}
          {rows.map((e) => (
            <tr key={e.key}>
              <td>{e.id}</td>
              <td>{dateTimeOf(e.recvAt)}</td>
              <td>
                <span className={`tag t-${e.type}`}>{e.label}</span>
              </td>
              <td>{e.src}</td>
              <td>{e.state}</td>
              <td className="note">{e.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
