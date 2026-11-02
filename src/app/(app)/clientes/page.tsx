import type { Metadata } from "next";
import Link from "next/link";
import { buttonStyles, Card, EmptyState, inputClass, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Client } from "@/lib/types";

export const metadata: Metadata = { title: "Clientes" };

export default async function ClientsPage({ searchParams }: PageProps<"/clientes">) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : "";

  const supabase = await createClient();
  let query = supabase.from("clients").select("*").order("created_at", { ascending: false }).limit(200);
  if (q) {
    // Quita caracteres que rompen el filtro .or() de Supabase
    const term = q.replace(/[,()%*]/g, " ");
    query = query.or(`name.ilike.%${term}%,company.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%`);
  }
  const { data } = await query;
  const clients = (data ?? []) as Client[];

  return (
    <>
      <PageHeader
        title="Clientes"
        description="Tus prospectos y clientes con su historial."
        action={
          <Link href="/clientes/nuevo" className={buttonStyles.primary}>
            + Nuevo cliente
          </Link>
        }
      />

      <form className="mb-4">
        <input name="q" defaultValue={q} placeholder="Buscar por nombre, empresa, teléfono o correo…" className={`${inputClass} max-w-md`} />
      </form>

      {clients.length === 0 ? (
        q ? (
          <EmptyState title="Sin resultados" description={`No encontramos clientes que coincidan con “${q}”.`} />
        ) : (
          <EmptyState
            title="Aún no tienes clientes"
            description="Registra a tu primer prospecto. Después podrás crearle cotizaciones y programar seguimientos."
            href="/clientes/nuevo"
            cta="Registrar cliente"
          />
        )
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Nombre</th>
                  <th className="px-4 py-3 font-medium">Empresa</th>
                  <th className="hidden px-4 py-3 font-medium md:table-cell">Teléfono</th>
                  <th className="hidden px-4 py-3 font-medium lg:table-cell">Correo</th>
                  <th className="hidden px-4 py-3 font-medium sm:table-cell">Alta</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {clients.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link href={`/clientes/${c.id}`} className="font-medium text-slate-900 hover:text-brand-600">
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{c.company ?? "—"}</td>
                    <td className="hidden px-4 py-3 text-slate-600 md:table-cell">{c.phone ?? "—"}</td>
                    <td className="hidden px-4 py-3 text-slate-600 lg:table-cell">{c.email ?? "—"}</td>
                    <td className="hidden px-4 py-3 text-slate-500 sm:table-cell">{formatDate(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
