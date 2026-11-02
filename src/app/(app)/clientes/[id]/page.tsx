import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SubmitButton } from "@/components/submit-button";
import { buttonStyles, Card, inputClass } from "@/components/ui";
import { formatDate, formatMoney, STATUS_LABEL, STATUS_STYLE, toWhatsAppNumber } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Activity, Client, Quote } from "@/lib/types";
import { addNoteAction, deleteClientAction } from "../actions";
import { DeleteClientButton } from "./delete-button";

export const metadata: Metadata = { title: "Cliente" };

const ACTIVITY_LABEL: Record<string, string> = {
  nota: "Nota",
  llamada: "Llamada",
  whatsapp: "WhatsApp",
  email: "Correo",
  reunion: "Reunión",
  cambio_estado: "Cambio de estado",
  seguimiento_hecho: "Seguimiento realizado",
  seguimiento_reprogramado: "Seguimiento reprogramado",
};

export default async function ClientDetailPage({ params }: PageProps<"/clientes/[id]">) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: client }, { data: quotes }, { data: activities }] = await Promise.all([
    supabase.from("clients").select("*").eq("id", id).maybeSingle<Client>(),
    supabase.from("quotes").select("*").eq("client_id", id).order("created_at", { ascending: false }),
    supabase.from("activities").select("*").eq("client_id", id).order("created_at", { ascending: false }).limit(50),
  ]);
  if (!client) notFound();

  const wa = toWhatsAppNumber(client.phone);

  return (
    <>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link href="/clientes" className="text-sm text-slate-500 hover:text-slate-900">
            ← Clientes
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{client.name}</h1>
          {client.company && <p className="text-sm text-slate-500">{client.company}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {wa && (
            <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" className={buttonStyles.whatsapp}>
              WhatsApp
            </a>
          )}
          <Link href={`/clientes/${id}/editar`} className={buttonStyles.secondary}>
            Editar
          </Link>
          <DeleteClientButton action={deleteClientAction.bind(null, id)} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">Datos de contacto</h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-slate-500">Teléfono</dt>
                <dd className="text-slate-900">{client.phone ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Correo</dt>
                <dd className="break-all text-slate-900">
                  {client.email ? (
                    <a href={`mailto:${client.email}`} className="hover:text-brand-600">
                      {client.email}
                    </a>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Notas</dt>
                <dd className="whitespace-pre-line text-slate-900">{client.notes ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Cliente desde</dt>
                <dd className="text-slate-900">{formatDate(client.created_at)}</dd>
              </div>
            </dl>
          </Card>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">Cotizaciones</h2>
            {(quotes as Quote[] | null)?.length ? (
              <ul className="divide-y divide-slate-100">
                {(quotes as Quote[]).map((q) => (
                  <li key={q.id} className="flex items-center justify-between gap-4 py-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-900">{q.title}</p>
                      <p className="text-slate-500">Enviada: {formatDate(q.sent_at)}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-slate-900">{formatMoney(Number(q.amount), q.currency)}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[q.status]}`}>
                        {STATUS_LABEL[q.status]}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">Sin cotizaciones todavía. (Se habilitan en la siguiente etapa.)</p>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">Historial</h2>
            <form action={addNoteAction.bind(null, id)} className="mb-5 space-y-3">
              <textarea name="body" rows={2} required placeholder="Registra una llamada, mensaje o nota…" className={inputClass} />
              <div className="flex items-center justify-between gap-3">
                <select name="type" className={`${inputClass} max-w-[180px]`} defaultValue="nota">
                  <option value="nota">Nota</option>
                  <option value="llamada">Llamada</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">Correo</option>
                  <option value="reunion">Reunión</option>
                </select>
                <SubmitButton pendingText="Guardando…">Registrar</SubmitButton>
              </div>
            </form>
            {(activities as Activity[] | null)?.length ? (
              <ol className="space-y-4 border-l border-slate-200 pl-4">
                {(activities as Activity[]).map((a) => (
                  <li key={a.id} className="relative text-sm">
                    <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-brand-500" />
                    <p className="text-xs text-slate-500">
                      {ACTIVITY_LABEL[a.type] ?? a.type} · {formatDate(a.created_at)}
                    </p>
                    {a.body && <p className="mt-0.5 whitespace-pre-line text-slate-800">{a.body}</p>}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-slate-500">Aún no hay actividad registrada.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
