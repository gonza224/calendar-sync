import 'dotenv/config';
import http from 'http';
import open from 'open';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/callback';
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

// Build the authorization URL
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES.join(' '));
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent'); // Force consent to always get refresh token

// Create a simple server to receive the callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:3000`);

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h1>Error</h1><p>${error}</p>`);
      server.close();
      return;
    }

    if (code) {
      try {
        // Exchange code for tokens
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: code,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI,
          }),
        });

        const tokens = await tokenResponse.json();

        if (tokens.error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Error</h1><p>${tokens.error}: ${tokens.error_description}</p>`);
          server.close();
          return;
        }

        console.log('\n========================================');
        console.log('SUCCESS! Add this to your .env file:');
        console.log('========================================\n');
        console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
        console.log('\n========================================\n');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
              <h1 style="color: green;">Success!</h1>
              <p>Your refresh token has been printed to the console.</p>
              <p>Copy it and add it to your <code>.env</code> file as <code>GOOGLE_REFRESH_TOKEN</code>.</p>
              <p>You can close this window now.</p>
            </body>
          </html>
        `);

        setTimeout(() => server.close(), 1000);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h1>Error</h1><p>${err.message}</p>`);
        server.close();
      }
    }
  }
});

server.listen(3000, () => {
  console.log('Opening browser for Google authentication...');
  console.log('If the browser does not open, visit this URL manually:\n');
  console.log(authUrl.toString());
  console.log('');
  open(authUrl.toString());
});
