"use client";

import { buttonStyles } from "@/components/ui";

export function DeleteClientButton({ action }: { action: () => Promise<void> }) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm("¿Eliminar este cliente? También se borrarán sus cotizaciones, seguimientos e historial.")) {
          e.preventDefault();
        }
      }}
    >
      <button type="submit" className={buttonStyles.danger}>
        Eliminar
      </button>
    </form>
  );
}
