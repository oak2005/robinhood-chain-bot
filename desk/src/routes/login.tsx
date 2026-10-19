import { createFileRoute } from "@tanstack/react-router";
import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";
import { EmailAccess } from "@/components/desk/email-access";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-sm content-center px-4 py-8">
      <div className="w-full space-y-3">
        <h1 className="font-display text-3xl text-fg">Sign in</h1>
        <EmailAccess />
        {authEnabled
          ? GROK_PROVIDERS.map((provider) => (
              <button key={provider.providerId} type="button" onClick={() => signIn(provider.providerId, { callbackURL: "/" })} className="min-h-11 w-full rounded-full border border-line text-sm text-fg">
                Continue with {provider.label}
              </button>
            ))
          : null}
      </div>
    </main>
  );
}
