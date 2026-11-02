// Tipos que reflejan las tablas de supabase/migrations.
// Más adelante se pueden generar automáticamente con `supabase gen types`.

export type QuoteStatus = "borrador" | "enviada" | "negociacion" | "ganada" | "perdida";

export type Client = {
  id: string;
  org_id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type Quote = {
  id: string;
  client_id: string;
  folio: string | null;
  title: string;
  description: string | null;
  amount: number;
  currency: string;
  status: QuoteStatus;
  sent_at: string | null;
  valid_until: string | null;
  closed_at: string | null;
  lost_reason: string | null;
  created_at: string;
};

export type Activity = {
  id: string;
  client_id: string;
  quote_id: string | null;
  type: string;
  body: string | null;
  created_at: string;
};

export type FormState = { error?: string } | undefined;
