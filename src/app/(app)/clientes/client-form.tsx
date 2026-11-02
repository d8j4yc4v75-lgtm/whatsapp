"use client";

import Link from "next/link";
import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { buttonStyles, Card, ErrorMessage, Field, inputClass } from "@/components/ui";
import type { Client, FormState } from "@/lib/types";

type Props = {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  client?: Client;
  cancelHref: string;
};

export function ClientForm({ action, client, cancelHref }: Props) {
  const [state, formAction] = useActionState(action, undefined);

  return (
    <Card className="p-6">
      <form action={formAction} className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Nombre del contacto *">
            <input name="name" required defaultValue={client?.name} className={inputClass} placeholder="Juan Pérez" />
          </Field>
          <Field label="Empresa">
            <input name="company" defaultValue={client?.company ?? ""} className={inputClass} placeholder="Restaurante El Sol" />
          </Field>
          <Field label="Teléfono / WhatsApp" hint="10 dígitos para México o con lada de país.">
            <input name="phone" type="tel" defaultValue={client?.phone ?? ""} className={inputClass} placeholder="55 1234 5678" />
          </Field>
          <Field label="Correo">
            <input name="email" type="email" defaultValue={client?.email ?? ""} className={inputClass} placeholder="juan@empresa.com" />
          </Field>
        </div>
        <Field label="Notas">
          <textarea name="notes" rows={4} defaultValue={client?.notes ?? ""} className={inputClass} placeholder="Cómo llegó, qué necesita, horarios para contactarlo…" />
        </Field>
        <ErrorMessage message={state?.error} />
        <div className="flex justify-end gap-3">
          <Link href={cancelHref} className={buttonStyles.secondary}>
            Cancelar
          </Link>
          <SubmitButton>{client ? "Guardar cambios" : "Crear cliente"}</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
