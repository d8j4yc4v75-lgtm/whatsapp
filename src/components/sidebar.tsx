"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Logo } from "./logo";

type NavItem = { href: string; label: string; icon: string; soon?: boolean };

const NAV: NavItem[] = [
  { href: "/hoy", label: "Seguimientos de hoy", icon: "M12 6v6l4 2m6-2a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z" },
  { href: "/clientes", label: "Clientes", icon: "M17 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-3.87M14 4.13a4 4 0 0 1 0 7.75M14 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" },
  { href: "/cotizaciones", label: "Cotizaciones", icon: "M9 12h6m-6 4h6M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z", soon: true },
  { href: "/plantillas", label: "Plantillas", icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z", soon: true },
  { href: "/panel", label: "Panel", icon: "M3 3v18h18M7 15l4-4 3 3 5-6", soon: true },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 shrink-0">
      <path d={d} />
    </svg>
  );
}

export function Sidebar({ orgName, footer }: { orgName: string; footer: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex-1 space-y-1 px-3">
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        if (item.soon) {
          return (
            <span key={item.href} className="flex cursor-default items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400">
              <Icon d={item.icon} />
              {item.label}
              <span className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase">Pronto</span>
            </span>
          );
        }
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
              active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <Icon d={item.icon} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Barra superior en móvil */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
        <Logo />
        <button onClick={() => setOpen(!open)} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100" aria-label="Menú">
          <Icon d={open ? "M6 6l12 12M18 6 6 18" : "M4 6h16M4 12h16M4 18h16"} />
        </button>
      </div>
      {open && <div className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden" onClick={() => setOpen(false)} />}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-white py-5 transition-transform lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-6 px-6">
          <Logo />
          <p className="mt-2 truncate text-xs text-slate-500">{orgName}</p>
        </div>
        {nav}
        <div className="border-t border-slate-200 px-3 pt-4">{footer}</div>
      </aside>
    </>
  );
}
