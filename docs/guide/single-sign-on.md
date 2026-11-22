# Single sign-on (OpenID Connect)

← [Documentation](README.md)

*Settings → Sign-in* connects Paperless-AI to your identity provider (or use the `OIDC_*` variables in [Configuration](configuration.md)). Register Paperless-AI there as a web application (*confidential* client, authorization code flow):

- **Redirect URI:** `https://paperless-ai.example.com/api/auth/oidc/callback` – shown in the settings, together with the **post-logout redirect URI** `https://paperless-ai.example.com/login`
- **Issuer URL:** the address in front of `/.well-known/openid-configuration` – *Test provider* checks it
- **Behind a reverse proxy** the address comes from the proxy's `X-Forwarded-Proto` / `X-Forwarded-Host` headers (Traefik, Caddy and most others send them). If the settings warn that Paperless-AI sees another address than your browser, set `PAPERLESS_AI_URL` (or *Public address* in the settings) to the address your browser uses

Who may sign in: everyone the provider lets through for this application, or – with *Allowed groups* – only members of these groups.

What they may do: accounts are *administrators* (settings, users, everything) or *members* (their libraries, with the role there). Accounts created by single sign-on start as members – the very first account of an installation as administrator. With `OIDC_ADMIN_GROUPS` the provider decides: members of these groups are administrators, everyone else members, checked at every sign-in (the last administrator is never demoted). The groups of the provider become groups of Paperless-AI (`OIDC_SYNC_GROUPS`, on by default), so a group can be member of a [library](built-in-archive.md#libraries-users-and-roles).

New accounts are created on the first sign-in; with *Create accounts automatically* off, an existing user signs in with the password once and links the account in *Settings → Account*. Once your account is linked you can switch off the password login – on a fresh installation (`PASSWORD_LOGIN=false`) the first single sign-on creates the first account.

| Provider | Notes |
| --- | --- |
| Authentik | *Applications → Providers → OAuth2/OpenID Provider*, redirect URI *strict*; issuer `https://authentik.example.com/application/o/<slug>/`. Groups come with the `profile` scope; bind the application to a group or policy to limit access. |
| Keycloak | Client with *Client authentication* on and *Standard flow*; issuer `https://keycloak.example.com/realms/<realm>`. For groups add a *Group Membership* mapper (claim `groups`, *Full group path* off) to the client's dedicated scope. |
| Authelia | Client with `redirect_uris`, `require_pkce: true`, `pkce_challenge_method: S256`, `token_endpoint_auth_method: client_secret_basic` and the scopes `openid profile email groups`; set *Scopes* (`OIDC_SCOPES`) to `openid profile email groups`. Issuer `https://auth.example.com`. |
| Others | Zitadel, Pocket ID, Kanidm, Entra ID, Google … work the same way. Without a client secret the client is treated as a public client (PKCE only). |

Signing in with single sign-on skips the two-factor code of Paperless-AI – use the multi-factor authentication of your provider. Provider down and the password login switched off? Start with `PASSWORD_LOGIN=true` and sign in with an account that has a password.
