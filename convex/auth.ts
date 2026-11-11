import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * Anonymous sign-in gives every device its own account with zero setup; Password lets the
 * owner sign in from a second device. Swap or add providers here without touching app code.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Anonymous, Password],
  // An anonymous account has no way back in once its session ends: the default 30-day session
  // limit signed the owner's phone out on 2026-11-05 and stranded its chats on a fresh account.
  // Sessions now last ten years; the 30-day idle limit on refresh tokens still applies.
  session: { totalDurationMs: 10 * 365 * 24 * 60 * 60 * 1000 },
});
