# Mobile apps (Paperless-ngx compatible API)

← [Documentation](README.md)

With the [built-in archive](built-in-archive.md), Paperless-AI offers a second API that speaks the REST API of Paperless-ngx (version 9, as Paperless-ngx 2.17). Apps made for Paperless-ngx work with it – browse, search, view, edit, upload. Paperless-AI's own API (`/api/`) is not affected.

## Connecting an app

Enter as the server address:

```
https://paperless-ai.example.com/ngx
```

and sign in with your Paperless-AI user name and password.

- **Two-factor authentication:** the app asks for the code, as with Paperless-ngx.
- **Single sign-on only, or the password login switched off:** create an API key in *Settings → API keys* (permissions *Read documents*, *Change documents*, *Upload documents*) and enter it as the token, if the app offers token login.
- Each sign-in creates a personal API key named “Paperless-ngx app (…)”. It shows in *Settings → API keys*; revoke it there to sign a phone out.

Use HTTPS (the apps send the password and the token), and a reverse proxy that passes `X-Forwarded-Proto` / `X-Forwarded-Host` (with `TRUST_PROXY` set, see [Installation](installation.md#behind-a-reverse-proxy)) – the apps follow the page links the API sends.

## Apps

Built against the source code of these apps:

| App | Platform | Notes |
| --- | --- | --- |
| [Swift Paperless](https://apps.apple.com/app/swift-paperless/id6448698521) | iOS | password, code and token login |
| [Paperless Mobile](https://f-droid.org/packages/de.astubenbord.paperless_mobile) | Android, iOS | password and code login |
| [Paperless Native](https://f-droid.org/packages/com.paperlessnative.mobile/) | Android | password and code login |
| [Paperparrot](https://apps.apple.com/app/paperparrot/id1663665267) | iOS, iPadOS, macOS | password and code login (built against its open API library; the app itself is not open source) |
| Scanner and upload apps | – | use only the upload (`post_document`) |

Other clients of the Paperless-ngx API should work as far as they use the parts below.

## What maps to what

| Paperless-ngx | Paperless-AI |
| --- | --- |
| Documents, tags, correspondents, document types, custom fields | the same – from every library you can read |
| Upload | into your default library (*Settings → Account*) or the library of the API key; the upload shows as a task |
| Trash | the trash of the built-in archive (restore, delete for good) |
| Full text search, “more like this”, autocomplete, global search | the search of the built-in archive |
| Permissions | your roles in the libraries: viewers see, editors change |
| New tags, correspondents, types, custom fields | created in your default library |

Not available (empty lists or a clear message in the app): storage paths, saved views, notes, inbox tags, mail accounts and rules, workflows of Paperless-ngx, share links, owners and permissions per document, suggestions of the Paperless-ngx classifier. The AI analysis of Paperless-AI runs as usual for uploaded documents.

## Behind the scenes

- Paths: `/ngx/api/…` with the trailing slash of Paperless-ngx; answers carry `X-Api-Version: 9` and `X-Version: 2.17.1`; versions above 9 are answered with 406, so apps fall back to 9.
- As in Paperless-ngx, the API root (`/ngx/api/`) and the version check (`/ngx/api/remote_version/`) answer without signing in – apps test the server address with them. Everything else needs the token.
- Errors in the format of Paperless-ngx (`{"detail": …}`, `{"non_field_errors": […]}`).
- A document without a document date shows the day it was added (Paperless-ngx always has a date, and the apps need one). That date is not saved when the app sends the document back; a date picked in the app is.
- Changes made through the apps appear in the change log of the document with “ngx-api” as their source and can be undone in Paperless-AI.
- With Paperless-ngx as the archive the compatible API is not there – connect the app to Paperless-ngx itself.
