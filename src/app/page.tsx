import Link from "next/link";
import { Logo } from "@/components/logo";
import { buttonStyles } from "@/components/ui";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-6">
      <header className="flex items-center justify-between py-6">
        <Logo />
        <Link href="/login" className={buttonStyles.secondary}>
          Iniciar sesión
        </Link>
      </header>
      <section className="flex flex-1 flex-col items-center justify-center py-16 text-center">
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
          Ninguna cotización se queda sin seguimiento
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-slate-600">
          CotizaFollow te dice cada mañana a quién contactar, con el mensaje de WhatsApp listo para enviar.
          Sin complicarte con un CRM difícil de usar.
        </p>
        <div className="mt-8 flex gap-3">
          <Link href="/registro" className={buttonStyles.primary}>
            Probar gratis 14 días
          </Link>
          <Link href="/login" className={buttonStyles.secondary}>
            Ya tengo cuenta
          </Link>
        </div>
      </section>
    </main>
  );
}
