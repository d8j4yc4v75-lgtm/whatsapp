import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import type { Client } from "@/lib/types";
import { updateClientAction } from "../../actions";
import { ClientForm } from "../../client-form";

export const metadata: Metadata = { title: "Editar cliente" };

export default async function EditClientPage({ params }: PageProps<"/clientes/[id]/editar">) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("*").eq("id", id).maybeSingle<Client>();
  if (!client) notFound();

  return (
    <div className="max-w-3xl">
      <PageHeader title="Editar cliente" description={client.name} />
      <ClientForm action={updateClientAction.bind(null, id)} client={client} cancelHref={`/clientes/${id}`} />
    </div>
  );
}
