"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";

type Item = { href: string; label: string; hint?: string };
type Entry = Item | { label: string; items: Item[] };

/** Menu chia hai tầng: phần cho NGƯỜI NHÀ đứng trước, phần KỸ THUẬT gom vào sub-menu. */
const MENU: Entry[] = [
  { href: "/", label: "Tổng quan" },
  {
    label: "Hỏi thăm",
    items: [
      { href: "/tro-chuyen", label: "Trò chuyện với trợ lý", hint: "Hỏi AI về sức khỏe, tình hình trong ngày" },
      { href: "/loi-nhan", label: "Gửi lời nhắn qua loa", hint: "Loa trong phòng đọc lời nhắn của con cháu" },
    ],
  },
  { href: "/nhat-ky", label: "Nhật ký" },
  {
    label: "Kỹ thuật",
    items: [
      { href: "/ky-thuat", label: "Giám sát thiết bị", hint: "Số liệu radar, mạng, công cụ thử" },
      { href: "/wifi", label: "Wi-Fi thiết bị", hint: "Quét, lưu, đổi mạng Wi-Fi của thiết bị" },
      { href: "/thuc-nghiem", label: "Đo thực nghiệm", hint: "Chấm TP/FP/FN/TN từng lần thử" },
      { href: "/bao-cao", label: "Báo cáo & biểu đồ", hint: "Precision, Recall, F1, model AI" },
    ],
  },
  { href: "/cai-dat", label: "Cài đặt" },
];

/** Biểu tượng OALPHA cắt từ logo gốc (image.png), nền trong suốt. Chữ OALPHA đứng cạnh nên alt để trống. */
function Logo() {
  return <Image src="/logo-mark.png" alt="" width={30} height={30} preload />;
}

function Group({ label, items, path, open, onToggle }: {
  label: string; items: Item[]; path: string; open: boolean; onToggle: (v: boolean) => void;
}) {
  const active = items.some((i) => i.href === path);
  const id = `menu-${label.replace(/\s+/g, "-")}`;
  return (
    <div className={`nav-group${open ? " open" : ""}`}>
      <button
        type="button"
        className={`nav-trigger${active ? " on" : ""}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onToggle(!open)}
      >
        {label}
        <svg viewBox="0 0 12 12" aria-hidden><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div className="nav-menu" id={id}>
          {items.map((i) => (
            <Link key={i.href} href={i.href} className={path === i.href ? "on" : ""} onClick={() => onToggle(false)}>
              <b>{i.label}</b>
              {i.hint && <span>{i.hint}</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Nav() {
  const path = usePathname();
  const [open, setOpen] = useState<string | null>(null);
  // Menu dang (mobile): dong/mo bang nut hamburger.
  const [mobileOpen, setMobileOpen] = useState(false);
  const ref = useRef<HTMLElement | null>(null);

  // Đóng sub-menu + menu mobile khi chuyển trang
  useEffect(() => {
    setOpen(null);
    setMobileOpen(false);
  }, [path]);
  useEffect(() => {
    if (!open && !mobileOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(null);
        setMobileOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(null); setMobileOpen(false); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, mobileOpen]);

  return (
    <nav className={`nav${mobileOpen ? " mobile-open" : ""}`} ref={ref} aria-label="Điều hướng chính">
      <Link href="/" className="brand">
        <span className="logo"><Logo /></span>
        <span>
          OALPHA
          <small>Giám sát sức khỏe người cao tuổi</small>
        </span>
      </Link>
      <span className="spacer" />
      {/* Nut hamburger - chi hien tren mobile (CSS) */}
      <button
        type="button"
        className="nav-burger"
        aria-label={mobileOpen ? "Đóng menu" : "Mở menu"}
        aria-expanded={mobileOpen}
        onClick={() => { setMobileOpen((v) => !v); setOpen(null); }}
      >
        {mobileOpen ? <X size={22} /> : <Menu size={22} />}
      </button>
      {/* Bo cac muc dieu huong vao mot khoi de an/hien goi gon tren mobile */}
      <div className="nav-items">
        {MENU.map((e) =>
          "items" in e ? (
            <Group
              key={e.label}
              label={e.label}
              items={e.items}
              path={path}
              open={open === e.label}
              onToggle={(v) => setOpen(v ? e.label : null)}
            />
          ) : (
            <Link key={e.href} href={e.href} className={path === e.href ? "on" : ""}>
              {e.label}
            </Link>
          ),
        )}
      </div>
    </nav>
  );
}
