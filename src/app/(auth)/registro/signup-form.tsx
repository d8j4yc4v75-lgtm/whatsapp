"use client";

import { useActionState } from "react";
import { signup } from "../actions";
import { SubmitButton } from "@/components/submit-button";
import { ErrorMessage, Field, inputClass } from "@/components/ui";

export function SignupForm() {
  const [state, action] = useActionState(signup, undefined);
  return (
    <form action={action} className="space-y-4">
      <Field label="Tu nombre">
        <input name="full_name" required autoComplete="name" className={inputClass} />
      </Field>
      <Field label="Nombre de tu empresa">
        <input name="company" required autoComplete="organization" className={inputClass} />
      </Field>
      <Field label="Correo">
        <input name="email" type="email" required autoComplete="email" className={inputClass} />
      </Field>
      <Field label="Contraseña" hint="Mínimo 8 caracteres.">
        <input name="password" type="password" required minLength={8} autoComplete="new-password" className={inputClass} />
      </Field>
      <ErrorMessage message={state?.error} />
      <SubmitButton pendingText="Creando cuenta…" className="w-full">
        Crear cuenta
      </SubmitButton>
    </form>
  );
}
