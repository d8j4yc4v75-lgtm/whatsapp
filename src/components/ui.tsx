// Estilos compartidos. Mantenerlos aquí hace que toda la app se vea igual.
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60";

export const buttonStyles = {
  primary: `${buttonBase} bg-brand-600 text-white shadow-sm hover:bg-brand-700`,
  secondary: `${buttonBase} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`,
  danger: `${buttonBase} border border-rose-200 bg-white text-rose-600 hover:bg-rose-50`,
  whatsapp: `${buttonBase} bg-[#25D366] text-white hover:bg-[#1ebe5b]`,
};

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Card({ className = "", ...props }: ComponentProps<"div">) {
  return <div className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`} {...props} />;
}

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ title, description, href, cta }: { title: string; description: string; href?: string; cta?: string }) {
  return (
    <Card className="px-6 py-14 text-center">
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{description}</p>
      {href && cta && (
        <Link href={href} className={`${buttonStyles.primary} mt-5`}>
          {cta}
        </Link>
      )}
    </Card>
  );
}

export function ErrorMessage({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{message}</p>;
}
