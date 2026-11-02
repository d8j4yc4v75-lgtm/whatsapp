"use client";

import { useActionState } from "react";
import { login } from "../actions";
import { SubmitButton } from "@/components/submit-button";
import { ErrorMessage, Field, inputClass } from "@/components/ui";

export function LoginForm({ next }: { next: string }) {
  const [state, action] = useActionState(login, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <Field label="Correo">
        <input name="email" type="email" required autoComplete="email" className={inputClass} />
      </Field>
      <Field label="Contraseña">
        <input name="password" type="password" required autoComplete="current-password" className={inputClass} />
      </Field>
      <ErrorMessage message={state?.error} />
      <SubmitButton pendingText="Entrando…" className="w-full">
        Entrar
      </SubmitButton>
    </form>
  );
}
