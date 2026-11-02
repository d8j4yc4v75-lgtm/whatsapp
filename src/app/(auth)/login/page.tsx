import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Iniciar sesión" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : "/hoy";
  const registered = params.registrado === "1";
  const failed = params.error === "confirmacion";

  return (
    <>
      <h1 className="text-xl font-semibold text-slate-900">Iniciar sesión</h1>
      <p className="mb-5 mt-1 text-sm text-slate-500">Revisa tus seguimientos del día.</p>
      {registered && (
        <p className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Cuenta creada. Te enviamos un correo para confirmarla.
        </p>
      )}
      {failed && (
        <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          El enlace de confirmación no es válido o expiró.
        </p>
      )}
      <LoginForm next={next} />
      <p className="mt-5 text-center text-sm text-slate-500">
        ¿No tienes cuenta?{" "}
        <Link href="/registro" className="font-medium text-brand-600 hover:underline">
          Regístrate
        </Link>
      </p>
    </>
  );
}
