import { useState } from "react";
import { authClient } from "@/lib/auth/client";

export function EmailAccess() {
  const [mode, setMode] = useState<"in" | "up">("up");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError("");
    setBusy(true);
    try {
      if (mode === "up") {
        const result = await authClient.signUp.email({ email, password, name: name || email });
        if (result.error) setError(result.error.message || "Could not create the account.");
      } else {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) setError(result.error.message || "Could not sign in.");
      }
    } catch {
      setError("Could not reach the account service.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      {mode === "up" ? <Field label="Name" value={name} onChange={setName} placeholder="Your name" /> : null}
      <Field label="Email" value={email} onChange={setEmail} placeholder="you@email.com" />
      <label className="block space-y-2">
        <span className="text-sm text-muted">Password</span>
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="min-h-11 w-full rounded-2xl border border-line bg-surface px-3 text-fg" />
      </label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <button type="submit" disabled={busy} className="min-h-11 w-full rounded-full bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-60">
        {busy ? "Working" : mode === "up" ? "Create account" : "Sign in"}
      </button>
      <button type="button" onClick={() => setMode(mode === "up" ? "in" : "up")} className="min-h-11 w-full text-sm text-muted">
        {mode === "up" ? "I already have an account" : "Create an account"}
      </button>
    </form>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="block space-y-2">
      <span className="text-sm text-muted">{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className="min-h-11 w-full rounded-2xl border border-line bg-surface px-3 text-fg placeholder:text-subtle" />
    </label>
  );
}
