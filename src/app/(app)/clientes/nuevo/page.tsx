import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { createClientAction } from "../actions";
import { ClientForm } from "../client-form";

export const metadata: Metadata = { title: "Nuevo cliente" };

export default function NewClientPage() {
  return (
    <div className="max-w-3xl">
      <PageHeader title="Nuevo cliente" description="Registra al prospecto para empezar a darle seguimiento." />
      <ClientForm action={createClientAction} cancelHref="/clientes" />
    </div>
  );
}
