"use client";

import { useFormStatus } from "react-dom";
import { buttonStyles } from "./ui";

export function SubmitButton({
  children,
  pendingText = "Guardando…",
  variant = "primary",
  className = "",
}: {
  children: React.ReactNode;
  pendingText?: string;
  variant?: keyof typeof buttonStyles;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${buttonStyles[variant]} ${className}`}>
      {pending ? pendingText : children}
    </button>
  );
}
