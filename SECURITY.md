# Security and privacy

This is a public static-site repository. Treat everything committed here as public.

## Never commit

- Esri API keys, OAuth tokens, passwords, private keys, cookies, or `.env` files.
- Real client names, addresses, phone numbers, email addresses, logos, project records, source imagery, exports, or other personally identifiable information.
- Local Windows paths or screenshots containing account details.

The `.gitignore` file blocks common credential and private-artifact paths, but it is not a security boundary. Review `git diff --cached` before every push.

## Esri credentials

For a static GitHub Pages deployment, an API key entered by a user is visible to that user's browser. If a key is used client-side, restrict it in ArcGIS to the exact production referrer and the minimum services, and rotate it if it is ever exposed. Do not place it in source code, build output, URL parameters, issues, or chat.

For production use with stronger protection, route ArcGIS requests through a server-side proxy and store the key as a deployment secret.

## If a secret was committed

Revoke or rotate it immediately in the provider console. Removing the current file is not enough because Git history and forks may retain it; contact the repository administrator before rewriting public history.

Report suspected exposure privately to the repository owner rather than opening a public issue.
