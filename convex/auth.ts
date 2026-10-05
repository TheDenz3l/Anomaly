import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * Anonymous sign-in gives every device its own account with zero setup; Password lets the
 * owner sign in from a second device. Swap or add providers here without touching app code.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Anonymous, Password],
});
