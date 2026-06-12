// Opslane auth recipe: mint a Twenty session without driving the login UI.
// Twenty is GraphQL + header-auth. The login is a two-step token exchange, and
// the SPA stores the result in a CLIENT-SIDE `tokenPair` cookie (JSON). So this
// recipe runs the GraphQL flow and constructs that cookie itself.
//
//   POST /graphql getLoginTokenFromCredentials(email,password,origin) -> loginToken
//   POST /graphql getAuthTokensFromLoginToken(loginToken,origin)      -> tokens
//   -> set cookie `tokenPair` = JSON({accessOrWorkspaceAgnosticToken, refreshToken})
//
// Eventual home: abhishekray07/twenty  scripts/opslane-session.cjs
//   opslane.yml:  auth: { session_command: node scripts/opslane-session.cjs }

const fs = require('fs');

const BASE = process.env.OPSLANE_BASE_URL || 'http://localhost:3000';
const EMAIL = process.env.OPSLANE_AUTH_EMAIL;
const PASSWORD = process.env.OPSLANE_AUTH_PASSWORD;
const OUT = process.env.OPSLANE_SESSION_OUT || '/home/user/opslane-storage-state.json';

if (!EMAIL || !PASSWORD) {
  console.error('MINT_FAIL: missing OPSLANE_AUTH_EMAIL or OPSLANE_AUTH_PASSWORD');
  process.exit(1);
}

async function gql(query, variables) {
  // Twenty serves its AUTH mutations on /metadata (NOT /graphql, which is the
  // per-workspace object schema). Verified by capturing the frontend's own login.
  const res = await fetch(`${BASE}/metadata`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.errors) throw new Error('GraphQL: ' + JSON.stringify(json.errors).slice(0, 300));
  return json.data;
}

async function main() {
  // Step 1: credentials -> loginToken
  const d1 = await gql(
    `mutation GetLoginToken($email: String!, $password: String!, $origin: String!) {
      getLoginTokenFromCredentials(email: $email, password: $password, origin: $origin) {
        loginToken { token expiresAt }
      }
    }`,
    { email: EMAIL, password: PASSWORD, origin: BASE },
  );
  const loginToken = d1 && d1.getLoginTokenFromCredentials && d1.getLoginTokenFromCredentials.loginToken && d1.getLoginTokenFromCredentials.loginToken.token;
  if (!loginToken) { console.error('MINT_FAIL: no loginToken', JSON.stringify(d1).slice(0, 200)); process.exit(1); }

  // Step 2: loginToken -> auth tokens
  const d2 = await gql(
    `mutation GetAuthTokens($loginToken: String!, $origin: String!) {
      getAuthTokensFromLoginToken(loginToken: $loginToken, origin: $origin) {
        tokens {
          accessOrWorkspaceAgnosticToken { token expiresAt }
          refreshToken { token expiresAt }
        }
      }
    }`,
    { loginToken, origin: BASE },
  );
  const tokens = d2 && d2.getAuthTokensFromLoginToken && d2.getAuthTokensFromLoginToken.tokens;
  if (!tokens || !tokens.accessOrWorkspaceAgnosticToken) { console.error('MINT_FAIL: no tokens', JSON.stringify(d2).slice(0, 200)); process.exit(1); }

  // Reconstruct the SPA's `tokenPair` cookie (the shape we measured live).
  const tokenPair = {
    accessOrWorkspaceAgnosticToken: { token: tokens.accessOrWorkspaceAgnosticToken.token, expiresAt: tokens.accessOrWorkspaceAgnosticToken.expiresAt, __typename: 'AuthToken' },
    refreshToken: { token: tokens.refreshToken.token, expiresAt: tokens.refreshToken.expiresAt, __typename: 'AuthToken' },
    __typename: 'AuthTokenPair',
  };

  const cookies = [{
    name: 'tokenPair',
    value: encodeURIComponent(JSON.stringify(tokenPair)),
    domain: 'localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax',
  }];

  fs.writeFileSync(OUT, JSON.stringify({ cookies, origins: [] }));
  console.log(`MINT_OK cookies=${cookies.length} (tokenPair)`);
}

main().catch((error) => {
  console.error('MINT_ERROR:', error && error.message ? error.message : error);
  process.exit(1);
});
