# Brickmen Studio integration setup

This is an additive integration layer for the existing static Brickmen portfolio. It adds a separate Studio login page and server-side Google Drive OAuth routes. It does not alter the public portfolio content or read/write any Google Drive file during login.

## 1. Supabase database
Run \`supabase/migrations/20261104_google_drive_connection.sql\` in the SQL Editor of the separate \`brickmen-studio\` Supabase project. It creates one new RLS-protected table for the encrypted Google refresh token and does not modify existing tables or data.

## 2. Create the first Studio administrator
In Supabase Dashboard → Authentication → Users, create the administrator user using the Brickmen administrator email. Set a strong password and confirm the user if Supabase asks. Public sign-up is not provided by the Studio page.

## 3. Vercel Production environment variables
Already configured: \`SUPABASE_URL\`, \`SUPABASE_PUBLISHABLE_KEY\`, and \`SUPABASE_SECRET_KEY\`.

Add the following after the new code deploys:
- \`BRICKMEN_ADMIN_EMAILS\` (Config): \`meticulousdesigncollaberative@gmail.com\`
- \`GOOGLE_CLIENT_ID\` (Config): OAuth Client ID from Google Cloud
- \`GOOGLE_CLIENT_SECRET\` (Secret): OAuth Client Secret from Google Cloud
- \`GOOGLE_REDIRECT_URI\` (Config): \`https://brickmen-website.vercel.app/api/google/callback\`
- \`GOOGLE_TOKEN_ENCRYPTION_KEY\` (Secret): new 32-byte random key, Base64 encoded

Generate the encryption key on Windows PowerShell; never send it in chat or commit it to GitHub:
\`\`\`powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
[Convert]::ToBase64String($bytes)
\`\`\`
Back up this key securely. If it is lost, the stored encrypted Google refresh token cannot be decrypted and Drive must be connected again. Set these variables for Production and redeploy after saving.

## 4. Google OAuth client
In Google Cloud → Google Auth Platform → Clients → the Brickmen Studio Web application, add this exact Authorized redirect URI (not a JavaScript origin):
\`https://brickmen-website.vercel.app/api/google/callback\`

Keep Drive access read-only. The app can remain in Testing while the authorised Brickmen account is listed as a test user.

## 5. Connect
Open \`https://brickmen-website.vercel.app/studio.html\`, sign in with the administrator user created in step 2, then select Connect Google Drive. Confirm the account shown is the account containing the Brickmen project archive.

This first phase establishes and verifies the secure OAuth connection only. The actual Drive catalogue scan is a separate next phase after the connection is confirmed.

## Security
The Supabase secret key, Google client secret, and encryption key stay in Vercel Secrets. The Google refresh token is encrypted with AES-256-GCM in the backend before it is stored in Supabase. The API requires a valid Supabase Auth session and an email listed in \`BRICKMEN_ADMIN_EMAILS\`. The configured Drive permission is read-only; no Drive file mutation operation is implemented.
