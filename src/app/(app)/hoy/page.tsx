import type { Metadata } from "next";
import Link from "next/link";
import { buttonStyles, Card, EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { formatDate, formatMoney, todayISO, toWhatsAppNumber } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Seguimientos de hoy" };

type Due = {
  followup_id: string;
  due_date: string;
  days_overdue: number;
  quote_title: string;
  amount: number;
  currency: string;
  client_id: string;
  client_name: string;
  client_company: string | null;
  client_phone: string | null;
};

export default async function TodayPage() {
  const user = await getCurrentUser();
  const today = todayISO();
  const supabase = await createClient();

  const { data } = await supabase
    .from("followups_due")
    .select("*")
    .lte("due_date", today)
    .order("due_date", { ascending: true });
  const items = (data ?? []) as Due[];

  const overdue = items.filter((i) => i.due_date < today);
  const dueToday = items.filter((i) => i.due_date === today);
  const firstName = user.fullName.split(" ")[0];

  return (
    <>
      <PageHeader
        title={firstName ? `Hola, ${firstName}` : "Seguimientos de hoy"}
        description={`${formatDate(today)} · ${items.length} ${items.length === 1 ? "cliente requiere" : "clientes requieren"} atención`}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Para hoy" value={dueToday.length} tone="text-brand-600" />
        <Stat label="Atrasados" value={overdue.length} tone="text-rose-600" />
        <Stat
          label="Valor en seguimiento"
          value={formatMoney(items.reduce((s, i) => s + Number(i.amount), 0), user.org?.currency ?? "MXN")}
          tone="text-slate-900"
        />
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="Todo al día"
          description="No tienes seguimientos pendientes. Cuando marques una cotización como enviada, aquí aparecerán los recordatorios a 3, 7 y 14 días."
          href="/clientes"
          cta="Ir a clientes"
        />
      ) : (
        <div className="space-y-6">
          {overdue.length > 0 && <Section title="Atrasados" items={overdue} />}
          {dueToday.length > 0 && <Section title="Hoy" items={dueToday} />}
        </div>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone: string }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</p>
    </Card>
  );
}

function Section({ title, items }: { title: string; items: Due[] }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      <Card className="divide-y divide-slate-100">
        {items.map((i) => {
          const wa = toWhatsAppNumber(i.client_phone);
          return (
            <div key={i.followup_id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <Link href={`/clientes/${i.client_id}`} className="font-medium text-slate-900 hover:text-brand-600">
                  {i.client_name}
                  {i.client_company && <span className="font-normal text-slate-500"> · {i.client_company}</span>}
                </Link>
                <p className="truncate text-sm text-slate-500">
                  {i.quote_title} · {formatMoney(Number(i.amount), i.currency)}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {i.days_overdue > 0 && (
                  <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">
                    {i.days_overdue} {i.days_overdue === 1 ? "día" : "días"} de atraso
                  </span>
                )}
                {wa && (
                  <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" className={buttonStyles.whatsapp}>
                    WhatsApp
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </Card>
    </section>
  );
}
