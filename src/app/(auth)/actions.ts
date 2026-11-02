"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { FormState } from "@/lib/types";

const ERRORS: Record<string, string> = {
  "Invalid login credentials": "Correo o contraseña incorrectos.",
  "Email not confirmed": "Confirma tu correo antes de entrar (revisa tu bandeja).",
  "User already registered": "Ya existe una cuenta con ese correo.",
};

function translate(message: string) {
  return ERRORS[message] ?? message;
}

export async function login(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/hoy");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: translate(error.message) };

  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/hoy");
}

export async function signup(_prev: FormState, formData: FormData): Promise<FormState> {
  const fullName = String(formData.get("full_name") ?? "").trim();
  const company = String(formData.get("company") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (password.length < 8) return { error: "La contraseña debe tener al menos 8 caracteres." };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName, company },
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/confirm`,
    },
  });
  if (error) return { error: translate(error.message) };

  // Si la confirmación por correo está desactivada, ya hay sesión.
  if (data.session) redirect("/hoy");
  redirect("/login?registrado=1");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
