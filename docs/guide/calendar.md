# Calendar

← [Documentation](README.md)

*Settings → Processing → Appointments & deadlines* turns the calendar on. From then on the AI analysis also asks for dates the recipient has to act on or attend – appointments (with time), payment due dates, deadlines (cancellation, objection, application) and expiry or renewal dates. They appear on the *Calendar* page with a link to the document; dates you hide stay hidden when the document is analysed again.

- **Earlier documents:** *Search documents* asks only for the dates of documents processed before (last 3 or 12 months, 3 years or all) – one small AI request per document, titles and tags in Paperless stay untouched.
- **Subscribe:** *Subscribe* shows a private link (`…/api/calendar/feed/<secret>.ics`). Add it in Google Calendar (*Other calendars → From URL*), Apple Calendar (*File → New Calendar Subscription*) or Outlook (*Subscribe from web*). The calendar app must be able to reach Paperless-AI at that address; anyone with the link can read the dates, so a new link can be created at any time.

Environment variable: `ACTIVATE_CALENDAR=true`.
