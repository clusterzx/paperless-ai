# Prompt rules

← [Documentation](README.md)

One prompt rarely fits every document: household papers need a correspondent, a document type and the tax year – teaching material needs a subject, a grade and no correspondent at all. *Prompt library → Prompt rules* analyses matching documents with another prompt from the library and, if wanted, with other settings. The first matching rule wins; all other documents get the system prompt.

- **Conditions** (all that are filled in must match): one of / all of these tags, document type, correspondent, storage path, owner, a custom field (with a value). A rule without conditions applies to every document – useful as the last rule. Paperless can set a routing tag on consumption, e.g. with a workflow or `CONSUMER_SUBDIRS_AS_TAGS`.
- **Settings per rule**: which fields the AI fills (e.g. no correspondent), which of the configured custom fields, only existing tags / correspondents / document types, a fixed list of allowed tags or document types, and another model of the AI provider (e.g. a larger one for difficult documents).
- The manual review and the playground show which rule applies to a document, the history and the library which prompt was used. A prompt sent with the webhook (`prompt`) wins over the rules.
- Rules look at the document as it is when it is analysed: if a trigger tag is a condition and is removed after processing, a later re-run without the tag uses the system prompt.

For Docker deployments the rules can be set with `PROMPT_RULES` – prompts are referred to by their name in the library:

```json
[
  { "name": "Teaching material", "prompt": "Teaching material", "match": { "tagsAny": ["Unterricht"] },
    "overrides": { "functions": { "correspondent": false }, "customFields": ["Subject", "Grade"], "allowedDocumentTypes": ["Worksheet", "Test"] } },
  { "name": "Household", "prompt": "Household", "match": {} }
]
```

Prompt rules are workflows that run before the analysis (see [docs/standalone/workflows.md](../standalone/workflows.md)).
