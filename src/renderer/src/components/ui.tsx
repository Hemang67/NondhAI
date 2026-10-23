import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "border border-line bg-panel hover:bg-muted",
  ghost: "hover:bg-muted",
  danger: "border border-line text-red-600 dark:text-red-400 hover:bg-red-500/10",
};

export function Button({ variant = "secondary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      className={cx(
        "h-8 w-full rounded-md border border-line bg-panel px-2.5 text-sm placeholder:text-fg-muted focus:border-accent focus:outline-none",
        className,
      )}
    />
  );
}

export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...p}
      className={cx("h-8 w-full rounded-md border border-line bg-panel px-2 text-sm focus:border-accent focus:outline-none", className)}
    >
      {children}
    </select>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx("relative h-5 w-9 shrink-0 rounded-full transition", checked ? "bg-accent" : "bg-line")}
    >
      <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

export function Card({ title, description, children, actions }: { title?: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel">
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-fg-muted">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-fg-muted">{hint}</div>}
      </div>
      <div className="w-full shrink-0 sm:w-72">{children}</div>
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "cloud" | "accent" }) {
  const t = {
    neutral: "bg-muted text-fg-muted",
    cloud: "bg-amber-500/15 text-warn",
    accent: "bg-accent/15 text-accent",
  }[tone];
  return <span className={cx("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium", t)}>{children}</span>;
}

export { cx };
