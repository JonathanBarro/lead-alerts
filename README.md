# Lead Alerts — instant alerts for every new enquiry

Every enquiry from your website or Google Form is saved to a Google Sheet, sent to your phone on Telegram, emailed to you, and answered automatically, in seconds.

**Running cost: €0/month.** It runs on your own free Google account. No servers, no subscriptions, no Zapier.

## What it does

| Step | What happens |
| --- | --- |
| 1. Someone fills in your form | Website form (any builder) or Google Form |
| 2. Saved to your sheet | Name, email, phone, message, source, any extra fields, with a status dropdown (New → Contacted → Won/Lost) |
| 3. Telegram alert | A message on your phone within seconds |
| 4. Email to you | You hit "Reply" and you are answering the customer |
| 5. Auto-reply to the customer | "Thanks, we'll reply within 24h", fully editable |
| Every morning (optional) | A Telegram summary of yesterday's leads |

Built-in protection:

- **Spam filter.** A hidden honeypot field catches bots, and a limit of 30 submissions per minute stops floods.
- **Duplicate detection.** The same person submitting twice in 24 hours is saved but not re-alerted.
- **Private access key.** Random requests to the form URL are rejected.
- **Fault isolation.** If Telegram is down, the lead is still saved and the emails still go out. Every problem is written to a `Log` sheet.

## What you need to do (about 10 minutes, with a video guide)

1. **Open the sheet I share with you and click _File → Make a copy_.** The copy and its script are now 100% yours.
2. Use the **⚡ Lead Alerts** menu:
   1. **Set up sheets.** Google asks you to approve the permissions once.
   2. **Connect Telegram.** Create a bot with @BotFather (1 minute), then paste its token.
   3. **Send a test lead.** Check that your phone buzzes.
3. Connect your form:
   - **Website:** in the sheet, open *Extensions → Apps Script → Deploy → New deployment → Web app* (Execute as: *Me*, Access: *Anyone*). Then use the menu item **Website form: show webhook URL** and paste that URL into your form plugin's webhook setting. For a plain HTML site, use `examples/website-form.html`.
   - **Google Form:** in the form, open *Responses → Link to Sheets* and pick this spreadsheet. Then click **Google Form: start listening** in the menu.

I never need your Google password: the script lives in your copy and runs under your account.

## Settings (the `Settings` sheet, no code needed)

| Setting | Example |
| --- | --- |
| Business name | Academia Sol |
| Owner email | you@yourbusiness.com |
| Send Telegram alert / owner email / auto-reply | TRUE / FALSE |
| Auto-reply subject and body | Supports `{{name}}`, `{{business}}`, `{{email}}`, `{{phone}}`, `{{message}}` |
| Duplicate window (hours) | 24 (0 turns it off) |
| Required fields | email (or `email, phone`) |
| Daily summary hour | 8 (blank = off). Then click *Daily summary: apply schedule* |

## Limits to know

- **Email volume.** Free Gmail accounts can send about 100 emails per day from scripts, and Google Workspace accounts more. Each lead uses up to 2 (one to you, one auto-reply).
- **Google Sheets size.** A sheet handles tens of thousands of leads comfortably.
- **Personal data.** Leads contain personal data. It stays in your Google account and is never copied anywhere else.

## For developers

```
src/Core.js      pure logic (mapping, validation, duplicates, messages), tested in Node
src/Main.js      Apps Script entry points: doPost webhook, form trigger, menu, Telegram, email
appsscript.json  manifest (V8, Europe/Madrid, web app settings)
tests/           21 automated tests with in-memory mocks of Google services
```

Run the tests with `npm test` (Node 18+). Deploy with [clasp](https://github.com/google/clasp) or by pasting both `src` files into the Apps Script editor.
