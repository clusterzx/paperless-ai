# Search, tags and metadata

← [Documentation](README.md)

## Search syntax (Documents)

Words search title and text. Add filters as `key:value`; a `-` in front leaves out (`-tag:erledigt`, `-werbung`), quotes keep words together (`title:"Strom 2024"`). Parts of names are enough. The search box completes keys and names, has a help panel (**?**), and shows below it what was understood – or that a name does not exist (“No tag …”).

```
rechnung tag:steuer -tag:erledigt from:adac type:vertrag title:"Strom 2024" created:2024-03 asn:17
```

| Key (also) | Meaning | Example |
| --- | --- | --- |
| `title:` (`titel:`) | words in the title | `title:"Strom 2024"` |
| `text:` (`content:`, `body:`, `inhalt:`) | words in the text of the document | `text:kündigung` |
| `correspondent:` (`from:`, `sender:`, `von:`, `korrespondent:`) | correspondent, part of the name is enough | `from:adac` |
| `tag:` (`tags:`) | has this tag; several `tag:` must all match | `tag:steuer` |
| `type:` (`doctype:`, `documenttype:`, `typ:`, `dokumenttyp:`) | document type | `type:rechnung` |
| `created:` (`date:`, `datum:`, `erstellt:`) | document date | `created:2024-03` |
| `added:` (`hinzugefügt:`) | added to the archive | `added:>2025-01-01` |
| `asn:` | archive serial number | `asn:17` |
| `id:` | document ids | `id:120,121` |
| `library:` (`lib:`, `bibliothek:`) | library (built-in archive) | `library:familie` |

**Dates:** `2024`, `2024-03`, `2024-03-15`, `15.03.2024`, `03.2024`, with `>`, `>=`, `<`, `<=` in front, ranges `2023..2024`, and `today` / `yesterday` (`heute` / `gestern`).

With Paperless-ngx as the archive, words can only be left out next to words to search for, and leaving out title words (`-title:`) needs the built-in archive.

## Find duplicates

*Tags & metadata → Find duplicates* suggests tags, correspondents and document types that mean the same: case, punctuation, legal forms (GmbH, AG, & Co. KG …), region words (Deutschland, Europe …), typos and plurals – “ADAC Versicherung” / “ADAC Versicherung AG”, “Rechnung” / “Rechnungen”.

- **Merge** joins a group under one name (it can be changed before merging); **Not the same** is remembered.
- **Merge obvious** merges all certain groups at once; suggestions where one name only continues another (“ADAC” → “ADAC Versicherung”) are listed separately to check.
- **Ask the AI for more** sends only the names (no documents) and finds variants such as “1&1” / “1und1”.
- New AI suggestions use an existing correspondent instead of creating a variant of its name.

## Lists

*Tags & metadata* lists tags, correspondents, document types and custom fields with the number of documents. **Name** and **Documents** sort the list (A–Z / Z–A, most / fewest documents first – kept in the browser); the checkbox in the header selects all shown items, e.g. to merge them.

## Custom fields on the document page

Each type has its input: amounts with a currency (shown as `134,89` + `EUR` in the notation of your browser, stored as `EUR134.89`), dates, yes / no, numbers, the options of a choice field and long text.
