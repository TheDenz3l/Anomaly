# Accounts and sign-ups (decided, on hold)

Status: decided, not built. Waiting on the owner's go-ahead.

## Why it matters

- **Anyone can use the backend.** The deployment URL ships inside the app. Anyone who has it can sign in anonymously and call every public function.
- **Strangers can spend the deployment's own keys.** Every chat turn calls Jev on `JEV_API_KEY`, even when the user's own model provider is fake or broken. Search and movies use `EXA_API_KEY` and `TMDB_API_KEY`, and `FIRECRAWL_API_KEY` is also set.
- **Fetches and uploads are unlimited.** `links.preview` fetches any public URL, and `attachments.generateUploadUrl` has no per-user quota.
- **The owner's phone account can be lost for good.** It is anonymous, and its only session lives in the iOS Keychain. Deleting the app, resetting the device, or rotating `JWT_PRIVATE_KEY`/`JWKS` would sign it out with no way back. The app would then create a new anonymous account, stranding the old account's providers, chats and memories.

## Decision

1. **Add "Set password" in Settings,** using the existing Password provider. A `createOrUpdateUser` callback in `convex/auth.ts` attaches the password to the anonymous user already signed in instead of creating a new user. The `userId` stays the same, so no data has to move.
2. **Then close sign-ups.** Refuse new anonymous sign-ins with an env flag (e.g. `SIGNUPS_CLOSED=1`) or an allowlist. Existing sessions keep working.
3. **Add per-user rate limits** on the calls that cost money or fetch from outside: `messages.send`, `links.preview`, `attachments.generateUploadUrl` and `probes.*`.
4. **Rotate keys only after step 1.**
   - Rotate `JWT_PRIVATE_KEY`/`JWKS` only once the owner can sign back in with the password.
   - Never change `ENCRYPTION_KEY` without re-encrypting the stored provider keys.

**Rejected alternative:** a separate password account plus a data migration. Every table's `userId` would have to be moved, which adds risk for no gain.

## Check before building

- When anonymous sign-ups are refused, can existing anonymous sessions still refresh? Test on a throwaway account first.
- How long do Convex Auth sessions last by default? The phone must not be forced to sign in again before it has a password.

## Until then

- Treat the deployment as reachable by anyone.
- At audit time the web cache held 459 entries, and none contained secret names or the PDF notice that the file-read bug relied on. The cache only keeps 7 days, so anything older can't be ruled out.
