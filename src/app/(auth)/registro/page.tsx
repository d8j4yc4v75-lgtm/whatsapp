import type { Metadata } from "next";
import Link from "next/link";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Crear cuenta" };

export default function SignupPage() {
  return (
    <>
      <h1 className="text-xl font-semibold text-slate-900">Crea tu cuenta</h1>
      <p className="mb-5 mt-1 text-sm text-slate-500">14 días gratis. Sin tarjeta.</p>
      <SignupForm />
      <p className="mt-5 text-center text-sm text-slate-500">
        ¿Ya tienes cuenta?{" "}
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Inicia sesión
        </Link>
      </p>
    </>
  );
}
