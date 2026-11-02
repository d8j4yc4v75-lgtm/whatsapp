import { Sidebar } from "@/components/sidebar";
import { getCurrentUser } from "@/lib/auth";
import { logout } from "../(auth)/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  const footer = (
    <div className="flex items-center justify-between gap-2 px-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-900">{user.fullName || user.email}</p>
        <p className="truncate text-xs text-slate-500">{user.email}</p>
      </div>
      <form action={logout}>
        <button className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-900">Salir</button>
      </form>
    </div>
  );

  return (
    <div className="min-h-screen">
      <Sidebar orgName={user.org?.name ?? ""} footer={footer} />
      <main className="lg:pl-64">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}
