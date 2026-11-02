import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Capa de acceso: obtiene el usuario actual y su organización.
// `cache` evita repetir la consulta dentro de una misma petición.
export const getCurrentUser = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims) redirect("/login");

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, currency, locale, followup_days, plan, trial_ends_at")
    .limit(1)
    .single();

  return {
    id: claims.sub,
    email: (claims.email as string | undefined) ?? "",
    fullName: (claims.user_metadata as { full_name?: string } | undefined)?.full_name ?? "",
    org,
  };
});
