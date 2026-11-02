"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { FormState } from "@/lib/types";

// Lee y limpia los campos del formulario de cliente.
function readClient(formData: FormData) {
  const value = (key: string) => {
    const v = String(formData.get(key) ?? "").trim();
    return v === "" ? null : v;
  };
  return {
    name: value("name") ?? "",
    company: value("company"),
    phone: value("phone"),
    email: value("email"),
    notes: value("notes"),
  };
}

export async function createClientAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const client = readClient(formData);
  if (!client.name) return { error: "El nombre es obligatorio." };

  const supabase = await createClient();
  const { data, error } = await supabase.from("clients").insert(client).select("id").single();
  if (error) return { error: "No se pudo guardar el cliente. Intenta de nuevo." };

  revalidatePath("/clientes");
  redirect(`/clientes/${data.id}`);
}

export async function updateClientAction(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const client = readClient(formData);
  if (!client.name) return { error: "El nombre es obligatorio." };

  const supabase = await createClient();
  const { error } = await supabase.from("clients").update(client).eq("id", id);
  if (error) return { error: "No se pudo actualizar el cliente." };

  revalidatePath("/clientes");
  redirect(`/clientes/${id}`);
}

export async function deleteClientAction(id: string) {
  const supabase = await createClient();
  await supabase.from("clients").delete().eq("id", id);
  revalidatePath("/clientes");
  redirect("/clientes");
}

export async function addNoteAction(clientId: string, formData: FormData) {
  const body = String(formData.get("body") ?? "").trim();
  const type = String(formData.get("type") ?? "nota");
  if (!body) return;

  const supabase = await createClient();
  await supabase.from("activities").insert({ client_id: clientId, type, body });
  revalidatePath(`/clientes/${clientId}`);
}
