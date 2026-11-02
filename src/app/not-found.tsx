import Link from "next/link";
import { buttonStyles } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <h1 className="text-2xl font-semibold text-slate-900">No encontrado</h1>
      <p className="mt-2 text-sm text-slate-500">La página o el registro que buscas no existe.</p>
      <Link href="/hoy" className={`${buttonStyles.primary} mt-6`}>
        Volver al inicio
      </Link>
    </main>
  );
}
