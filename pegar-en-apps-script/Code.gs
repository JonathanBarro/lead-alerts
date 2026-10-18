// ===== Pega TODO este archivo en Extensiones → Apps Script (sustituye el contenido de Código.gs / Code.gs) =====

/**
 * Lead Alerts — pure business logic.
 *
 * Everything in this file is plain JavaScript with no Google services, so it
 * runs both inside Apps Script and in Node (for the automated tests).
 */

var LEAD_FIELDS = ['name', 'email', 'phone', 'message', 'source'];

/** Common names websites and form plugins use for each field. */
var FIELD_ALIASES = {
  name: ['name', 'full name', 'fullname', 'your name', 'nombre', 'nombre completo', 'first name'],
  email: ['email', 'e-mail', 'mail', 'email address', 'your email', 'correo', 'correo electronico'],
  phone: ['phone', 'telephone', 'tel', 'mobile', 'phone number', 'telefono', 'movil', 'whatsapp'],
  message: ['message', 'comments', 'comment', 'details', 'your message', 'mensaje', 'comentarios', 'consulta'],
  source: ['source', 'page', 'form', 'utm source', 'utm_source', 'origen', 'fuente']
};

/**
 * Field names that are never stored: the honeypot, the access key and the
 * timestamp Google Forms adds (the sheet records its own time).
 * Written in normalized form (see normalizeKey).
 */
var RESERVED_FIELDS = ['website hp', 'key', 'timestamp', 'marca temporal'];

/** Lowercase, strip accents and collapse spaces/underscores/dashes. */
function normalizeKey(key) {
  return String(key)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[_\-\s]+/g, ' ')
    .trim();
}

function firstValue(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]) : '';
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Maps any incoming payload (website form, JSON, Google Forms namedValues)
 * to a lead object. Unknown fields are kept in `extra` so nothing is lost.
 */
function extractLead(raw, receivedAtIso) {
  var lead = { receivedAt: receivedAtIso, name: '', email: '', phone: '', message: '', source: '', extra: {} };
  var aliasLookup = {};
  LEAD_FIELDS.forEach(function (field) {
    FIELD_ALIASES[field].forEach(function (alias) { aliasLookup[normalizeKey(alias)] = field; });
  });

  Object.keys(raw || {}).forEach(function (key) {
    var normalized = normalizeKey(key);
    if (RESERVED_FIELDS.indexOf(normalized) !== -1) return;
    var value = firstValue(raw[key]).trim().slice(0, 5000);
    var field = aliasLookup[normalized];
    if (field && !lead[field]) {
      lead[field] = value;
    } else if (value) {
      lead.extra[key] = value;
    }
  });

  lead.email = lead.email.toLowerCase();
  lead.phone = lead.phone.replace(/[^\d+]/g, '');
  return lead;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/** Returns a list of human-readable problems; empty list means valid. */
function validateLead(lead, requiredFields) {
  var errors = [];
  (requiredFields || []).forEach(function (field) {
    if (!lead[field]) errors.push('Missing required field: ' + field);
  });
  if (lead.email && !isValidEmail(lead.email)) errors.push('Invalid email: ' + lead.email);
  if (!lead.email && !lead.phone) errors.push('A lead needs at least an email or a phone');
  return errors;
}

/** Bots fill every input, including the hidden "website_hp" one; people never see it. */
function isSpam(raw) {
  var honeypot = firstValue((raw || {}).website_hp).trim();
  return honeypot.length > 0;
}

/**
 * True when the same email or phone already arrived within `hours`.
 * `recent` is a list of {email, phone, receivedAt} objects.
 */
function isDuplicate(lead, recent, hours, now) {
  if (!hours || hours <= 0) return false;
  var cutoff = now.getTime() - hours * 3600 * 1000;
  return (recent || []).some(function (r) {
    var when = new Date(r.receivedAt).getTime();
    if (isNaN(when) || when < cutoff) return false;
    var sameEmail = lead.email && r.email && lead.email === String(r.email).toLowerCase();
    var samePhone = lead.phone && r.phone && lead.phone === String(r.phone);
    return Boolean(sameEmail || samePhone);
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Telegram message in HTML parse mode, cut to Telegram's 4096-char limit. */
function buildTelegramMessage(lead, businessName) {
  var lines = ['🔔 <b>New lead' + (businessName ? ' — ' + escapeHtml(businessName) : '') + '</b>', ''];
  if (lead.name) lines.push('👤 ' + escapeHtml(lead.name));
  if (lead.email) lines.push('✉️ ' + escapeHtml(lead.email));
  if (lead.phone) lines.push('📞 ' + escapeHtml(lead.phone));
  if (lead.source) lines.push('📍 ' + escapeHtml(lead.source));
  if (lead.message) lines.push('', '💬 ' + escapeHtml(lead.message));
  Object.keys(lead.extra || {}).forEach(function (key) {
    lines.push('• ' + escapeHtml(key) + ': ' + escapeHtml(lead.extra[key]));
  });
  var text = lines.join('\n');
  return text.length > 4000 ? text.slice(0, 3990) + '…' : text;
}

/**
 * Owner notification as an email-safe HTML card (tables + inline styles, which
 * Gmail, Outlook and phone mail apps all render). Plain text is sent alongside.
 */
function buildOwnerEmailHtml(lead, businessName, sheetUrl) {
  var e = escapeHtml;
  var rows = [['Name', lead.name], ['Email', lead.email], ['Phone', lead.phone], ['Source', lead.source]];
  Object.keys(lead.extra || {}).forEach(function (k) { rows.push([k, lead.extra[k]]); });
  var rowHtml = rows.filter(function (r) { return r[1]; }).map(function (r, i) {
    return '<tr><td style="padding:10px 16px;color:#6b6a80;font-size:13px;width:110px;border-top:' + (i ? '1px solid #eceef4' : '0') + ';">' + e(r[0]) +
      '</td><td style="padding:10px 16px;color:#1b1a2e;font-size:15px;font-weight:600;border-top:' + (i ? '1px solid #eceef4' : '0') + ';">' + e(r[1]) + '</td></tr>';
  }).join('');
  var button = function (href, label, primary) {
    return '<td style="padding-right:8px;"><a href="' + e(href) + '" style="display:inline-block;padding:11px 18px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;' +
      (primary ? 'background:#1b1a2e;color:#ffffff;' : 'background:#ffffff;color:#1b1a2e;border:1px solid #d5d8e3;') + '">' + e(label) + '</a></td>';
  };
  var first = lead.name ? lead.name.split(' ')[0] : 'them';
  var buttons = (lead.email ? button('mailto:' + lead.email, 'Reply to ' + first, true) : '') +
    (lead.phone ? button('tel:' + lead.phone, 'Call', !lead.email) : '');
  return '<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f9;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f9;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e8ef;">' +
    '<tr><td style="background:#1b1a2e;padding:18px 20px;">' +
      '<div style="color:#ffc53d;font-size:12px;font-weight:700;letter-spacing:.3px;">NEW LEAD' + (businessName ? ' · ' + e(businessName) : '') + '</div>' +
      '<div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:4px;">' + e(lead.name || lead.email || lead.phone) + '</div>' +
    '</td></tr>' +
    (lead.message ? '<tr><td style="padding:18px 20px 6px;"><div style="background:#f6f7fb;border-left:3px solid #ffc53d;padding:12px 14px;border-radius:6px;color:#1b1a2e;font-size:15px;line-height:1.5;">' + e(lead.message).replace(/\n/g, '<br>') + '</div></td></tr>' : '') +
    '<tr><td style="padding:10px 4px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + rowHtml + '</table></td></tr>' +
    (buttons ? '<tr><td style="padding:14px 20px 4px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>' + buttons + '</tr></table></td></tr>' : '') +
    '<tr><td style="padding:16px 20px 20px;color:#6b6a80;font-size:12px;">' +
      (sheetUrl ? '<a href="' + e(sheetUrl) + '" style="color:#1e4fd1;">Open the sheet</a> · ' : '') + 'Replying to this email writes to the customer.' +
    '</td></tr></table></td></tr></table></body></html>';
}

/** Replaces {{name}}, {{email}}, {{business}}… in a template. Unknown tags become empty. */
function renderTemplate(template, lead, businessName) {
  var values = {
    name: lead.name ? lead.name.split(' ')[0] : 'there',
    full_name: lead.name || '',
    email: lead.email || '',
    phone: lead.phone || '',
    message: lead.message || '',
    business: businessName || ''
  };
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, function (_, tag) {
    return Object.prototype.hasOwnProperty.call(values, tag) ? values[tag] : '';
  });
}

/** Accepts a pasted web app URL (with or without ?key=…) and returns the clean /exec URL, or ''. */
function normalizeWebAppUrl(text) {
  var m = String(text || '').trim().match(/^https:\/\/script\.google\.com\/(?:a\/[^\/]+\/)?macros\/s\/[\w-]+\/exec/);
  return m ? m[0] : '';
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  return ['true', 'yes', 'si', 'sí', '1', 'on'].indexOf(String(value).trim().toLowerCase()) !== -1;
}

var SETTING_DEFAULTS = {
  'Business name': 'My Business',
  'Owner email': '',
  'Telegram chat ID': '',
  'Send Telegram alert': true,
  'Send owner email': true,
  'Send auto-reply to lead': true,
  'Auto-reply subject': 'Thanks for contacting {{business}}',
  'Auto-reply body': 'Hi {{name}},\n\nThanks for getting in touch with {{business}}. We have received your message and will reply within 24 hours.\n\nBest regards,\n{{business}}',
  'Duplicate window (hours)': 24,
  'Required fields': 'email',
  'Daily summary hour (0-23, blank = off)': ''
};

/** Turns the two-column Settings sheet into a typed config object. */
function parseSettings(rows) {
  var map = {};
  Object.keys(SETTING_DEFAULTS).forEach(function (k) { map[k] = SETTING_DEFAULTS[k]; });
  (rows || []).forEach(function (row) {
    if (row && row[0] !== '' && row[0] !== undefined) map[String(row[0]).trim()] = row[1];
  });
  var hour = String(map['Daily summary hour (0-23, blank = off)']).trim();
  return {
    businessName: String(map['Business name']),
    ownerEmail: String(map['Owner email']).trim(),
    telegramChatId: String(map['Telegram chat ID']).trim(),
    sendTelegram: toBool(map['Send Telegram alert']),
    sendOwnerEmail: toBool(map['Send owner email']),
    sendAutoReply: toBool(map['Send auto-reply to lead']),
    autoReplySubject: String(map['Auto-reply subject']),
    autoReplyBody: String(map['Auto-reply body']),
    duplicateHours: Number(map['Duplicate window (hours)']) || 0,
    requiredFields: String(map['Required fields']).split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean),
    dailySummaryHour: hour === '' ? null : Math.min(23, Math.max(0, parseInt(hour, 10)))
  };
}

/** Text for the daily Telegram summary. */
function buildDailySummary(leads, dateLabel, businessName) {
  if (!leads.length) return '📊 <b>' + escapeHtml(dateLabel) + '</b>\nNo new leads yesterday.';
  var lines = ['📊 <b>' + escapeHtml(dateLabel) + (businessName ? ' — ' + escapeHtml(businessName) : '') + '</b>',
    leads.length + (leads.length === 1 ? ' new lead:' : ' new leads:'), ''];
  leads.slice(0, 30).forEach(function (l) {
    lines.push('• ' + escapeHtml(l.name || l.email || l.phone) + (l.source ? ' (' + escapeHtml(l.source) + ')' : ''));
  });
  if (leads.length > 30) lines.push('…and ' + (leads.length - 30) + ' more');
  return lines.join('\n');
}

if (typeof module !== 'undefined') {
  module.exports = {
    normalizeKey: normalizeKey, extractLead: extractLead, isValidEmail: isValidEmail,
    validateLead: validateLead, isSpam: isSpam, isDuplicate: isDuplicate, escapeHtml: escapeHtml,
    buildTelegramMessage: buildTelegramMessage, renderTemplate: renderTemplate, toBool: toBool,
    parseSettings: parseSettings, buildOwnerEmailHtml: buildOwnerEmailHtml, normalizeWebAppUrl: normalizeWebAppUrl, buildDailySummary: buildDailySummary, SETTING_DEFAULTS: SETTING_DEFAULTS
  };
}

/**
 * Lead Alerts — Google Apps Script entry points.
 *
 * Every new lead from a website form or a Google Form is:
 *   1. saved to the "Leads" sheet (with duplicate and spam protection),
 *   2. sent to the owner's phone via Telegram,
 *   3. emailed to the owner, and
 *   4. answered with an automatic reply to the lead.
 *
 * Secrets (Telegram bot token, webhook key) live in Script Properties,
 * never in the sheet or the code.
 */

var SHEET_LEADS = 'Leads';
var SHEET_SETTINGS = 'Settings';
var SHEET_LOG = 'Log';
var LEAD_HEADERS = ['Received at', 'Name', 'Email', 'Phone', 'Message', 'Source', 'Extra fields', 'Status', 'Notes'];
var STATUSES = ['New', 'Contacted', 'Won', 'Lost', 'Duplicate'];
var THEME = {
  font: 'Inter', ink: '#1b1a2e', muted: '#6b6a80', line: '#eceef4', header: '#1b1a2e', band: '#f8f9fc',
  status: {
    New: { bg: '#fff3c4', fg: '#8a5a00' },
    Contacted: { bg: '#e2ebff', fg: '#1e4fd1' },
    Won: { bg: '#dcf5e4', fg: '#157347' },
    Lost: { bg: '#f0f0f4', fg: '#6b6a80' },
    Duplicate: { bg: '#fde7e7', fg: '#b42318' }
  }
};
var LEAD_WIDTHS = [120, 170, 220, 130, 300, 150, 220, 110, 200];
var MAX_LEADS_PER_MINUTE = 30;
var MAX_LOG_ROWS = 1000;

// ───────────────────────── Menu ─────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚡ Lead Alerts')
    .addItem('1. Set up sheets', 'setupSheets')
    .addItem('2. Connect Telegram', 'connectTelegram')
    .addItem('3. Send a test lead', 'sendTestLead')
    .addItem('Apply modern style', 'applyModernStyle')
    .addSeparator()
    .addItem('Website form: show webhook URL & code', 'showWebhookInfo')
    .addItem('Website form: change web app URL', 'resetWebAppUrl')
    .addItem('Google Form: start listening', 'connectGoogleForm')
    .addItem('Daily summary: apply schedule', 'applyDailySummarySchedule')
    .addSeparator()
    .addItem('Turn off all automations', 'removeAllTriggers')
    .addToUi();
}

// ───────────────────────── Webhook (website forms) ─────────────────────────

function doGet() {
  return jsonResponse({ ok: true, service: 'Lead Alerts', status: 'running' });
}

function doPost(e) {
  var raw = parseRequest(e);
  var props = PropertiesService.getScriptProperties();
  var expectedKey = props.getProperty('WEBHOOK_KEY');
  var providedKey = (e && e.parameter && e.parameter.key) || raw.key;

  if (!expectedKey || providedKey !== expectedKey) {
    logEvent('WARN', 'Rejected request with a wrong or missing key');
    return jsonResponse({ ok: false, error: 'unauthorized' });
  }
  if (isSpam(raw)) {
    logEvent('INFO', 'Spam submission dropped (honeypot filled)');
    return jsonResponse({ ok: true }); // look successful so bots don't retry
  }
  if (isRateLimited()) {
    logEvent('WARN', 'Rate limit hit: more than ' + MAX_LEADS_PER_MINUTE + ' requests in a minute');
    return jsonResponse({ ok: false, error: 'too many requests' });
  }
  return jsonResponse(processLead(raw, 'Website'));
}

function parseRequest(e) {
  if (!e) return {};
  var contents = e.postData && e.postData.contents;
  var type = e.postData && e.postData.type;
  if (contents && type && type.indexOf('application/json') !== -1) {
    try { return JSON.parse(contents) || {}; } catch (err) { return {}; }
  }
  return e.parameter || {};
}

function isRateLimited() {
  var cache = CacheService.getScriptCache();
  var bucket = 'rate_' + Math.floor(Date.now() / 60000);
  var count = Number(cache.get(bucket) || 0) + 1;
  cache.put(bucket, String(count), 120);
  return count > MAX_LEADS_PER_MINUTE;
}

// ───────────────────────── Google Forms ─────────────────────────

/** Installable trigger target: runs on every response of a linked Google Form. */
function onFormSubmitHandler(e) {
  processLead((e && e.namedValues) || {}, 'Google Form');
}

// ───────────────────────── Core flow ─────────────────────────

function processLead(raw, defaultSource) {
  var config = getConfig();
  var now = new Date();
  var lead = extractLead(raw, now.toISOString());
  if (!lead.source) lead.source = defaultSource;

  var errors = validateLead(lead, config.requiredFields);
  if (errors.length) {
    logEvent('WARN', 'Lead rejected: ' + errors.join('; '));
    return { ok: false, errors: errors };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var duplicate;
  try {
    var sheet = getSheet(SHEET_LEADS);
    duplicate = isDuplicate(lead, readRecentLeads(sheet, 300), config.duplicateHours, now);
    writeLeadRow(sheet, [
      now, lead.name, lead.email, lead.phone, lead.message, lead.source,
      formatExtra(lead.extra), duplicate ? 'Duplicate' : 'New', ''
    ]);
  } finally {
    lock.releaseLock();
  }

  if (duplicate) {
    logEvent('INFO', 'Duplicate lead saved without alerts: ' + (lead.email || lead.phone));
    return { ok: true, duplicate: true };
  }

  notify(lead, config);
  return { ok: true, duplicate: false };
}

/** Each channel fails independently: a Telegram outage never blocks the email. */
function notify(lead, config) {
  if (config.sendTelegram) {
    tryStep('Telegram alert', function () {
      if (!config.telegramChatId) throw new Error('Telegram chat ID is empty — run "Connect Telegram"');
      sendTelegram(config.telegramChatId, buildTelegramMessage(lead, config.businessName));
    });
  }
  if (config.sendOwnerEmail && config.ownerEmail) {
    tryStep('Owner email', function () {
      var body = buildTelegramMessage(lead, config.businessName).replace(/<\/?b>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      var sheetUrl = '';
      try { sheetUrl = SpreadsheetApp.getActive().getUrl(); } catch (err) { sheetUrl = ''; }
      var options = {
        to: config.ownerEmail, subject: 'New lead: ' + (lead.name || lead.email || lead.phone), body: body,
        htmlBody: buildOwnerEmailHtml(lead, config.businessName, sheetUrl)
      };
      if (lead.email) options.replyTo = lead.email;
      MailApp.sendEmail(options);
    });
  }
  if (config.sendAutoReply && lead.email) {
    tryStep('Auto-reply', function () {
      var options = {
        to: lead.email,
        subject: renderTemplate(config.autoReplySubject, lead, config.businessName),
        body: renderTemplate(config.autoReplyBody, lead, config.businessName),
        name: config.businessName
      };
      if (config.ownerEmail) options.replyTo = config.ownerEmail;
      MailApp.sendEmail(options);
    });
  }
}

function tryStep(label, fn) {
  try {
    fn();
  } catch (err) {
    logEvent('ERROR', label + ' failed: ' + (err && err.message ? err.message : err));
  }
}

/** Newest leads are on top, so the most recent ones are the first rows. */
function readRecentLeads(sheet, limit) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var count = Math.min(limit, last - 1);
  return sheet.getRange(2, 1, count, 4).getValues().map(function (r) {
    return { receivedAt: r[0], email: r[2], phone: r[3] };
  });
}

/** Inserts the lead as row 2 (top of the list) with the row style and a status dropdown. */
function writeLeadRow(sheet, values) {
  sheet.insertRowBefore(2);
  var row = sheet.getRange(2, 1, 1, values.length);
  row.setValues([values]);
  styleLeadRows(sheet, 2, 1);
}

function styleLeadRows(sheet, startRow, count) {
  if (count < 1) return;
  var rows = sheet.getRange(startRow, 1, count, LEAD_HEADERS.length);
  rows.setFontFamily(THEME.font).setFontSize(10).setFontColor(THEME.ink).setFontWeight('normal')
    .setVerticalAlignment('middle').setWrap(false).setBorder(false, false, true, false, false, false, THEME.line, SpreadsheetApp.BorderStyle.SOLID);
  sheet.setRowHeights(startRow, count, 40);
  sheet.getRange(startRow, 1, count, 1).setNumberFormat('dd mmm, HH:mm').setFontColor(THEME.muted);
  sheet.getRange(startRow, 2, count, 1).setFontWeight('bold');
  sheet.getRange(startRow, 5, count, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.getRange(startRow, 6, count, 2).setFontColor(THEME.muted);
  sheet.getRange(startRow, 8, count, 1).setHorizontalAlignment('center').setFontWeight('bold')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build());
}

function formatExtra(extra) {
  return Object.keys(extra || {}).map(function (k) { return k + ': ' + extra[k]; }).join(' · ');
}

// ───────────────────────── Telegram ─────────────────────────

function telegramApi(method, payload) {
  var token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  if (!token) throw new Error('Telegram is not connected — run "Connect Telegram"');
  var response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  });
  var body = JSON.parse(response.getContentText() || '{}');
  if (response.getResponseCode() !== 200 || !body.ok) {
    throw new Error('Telegram ' + method + ' error: ' + (body.description || response.getResponseCode()));
  }
  return body.result;
}

function sendTelegram(chatId, html) {
  return telegramApi('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
}

function connectTelegram() {
  ensureAllPermissions();
  var ui = SpreadsheetApp.getUi();
  var answer = ui.prompt('Connect Telegram — step 1 of 2',
    'In Telegram, open @BotFather, send /newbot and follow the steps.\nPaste the bot token it gives you here:',
    ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  var token = answer.getResponseText().trim();
  if (!/^\d+:[\w-]{30,}$/.test(token)) {
    ui.alert('That does not look like a bot token. It should look like 123456789:AAE... ');
    return;
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperty('TELEGRAM_TOKEN', token);

  var bot;
  try {
    bot = telegramApi('getMe', {});
  } catch (err) {
    props.deleteProperty('TELEGRAM_TOKEN');
    if (/UrlFetchApp|external_request|permiso|permission/i.test(err.message)) {
      ui.alert('Google has not allowed this sheet to connect to Telegram yet.\n\nRun "2. Connect Telegram" again and, on the permissions screen, tick "Select all" (or "Connect to an external service").');
    } else {
      ui.alert('Telegram rejected the token: ' + err.message);
    }
    return;
  }

  ui.alert('Connect Telegram — step 2 of 2',
    'Now open your bot @' + bot.username + ' in Telegram, press Start and send it any message (for example "hi").\n\nThen click OK here.',
    ui.ButtonSet.OK);

  var updates = telegramApi('getUpdates', { limit: 20 });
  var withChat = updates.filter(function (u) { return u.message && u.message.chat; });
  if (!withChat.length) {
    ui.alert('No message found yet. Send a message to @' + bot.username + ' and run "Connect Telegram" again.');
    return;
  }
  var chat = withChat[withChat.length - 1].message.chat;
  setSetting('Telegram chat ID', String(chat.id));
  sendTelegram(chat.id, '✅ Lead Alerts is connected. New leads will appear here.');
  ui.alert('Done! Alerts will go to ' + (chat.title || chat.first_name || 'your chat') + '. You should have a confirmation message in Telegram.');
}

// ───────────────────────── Setup & menu actions ─────────────────────────

function setupSheets() {
  ensureAllPermissions();
  var ss = SpreadsheetApp.getActive();

  var leads = ss.getSheetByName(SHEET_LEADS) || ss.insertSheet(SHEET_LEADS, 0);
  if (leads.getLastRow() === 0) leads.getRange(1, 1, 1, LEAD_HEADERS.length).setValues([LEAD_HEADERS]);
  applyLeadsStyle(leads);

  var settings = ss.getSheetByName(SHEET_SETTINGS) || ss.insertSheet(SHEET_SETTINGS);
  if (settings.getLastRow() === 0) {
    settings.getRange(1, 1, 1, 2).setValues([['Setting', 'Value']]).setFontWeight('bold');
    settings.setFrozenRows(1);
  }
  var existing = settings.getLastRow() > 1 ? settings.getRange(2, 1, settings.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  Object.keys(SETTING_DEFAULTS).forEach(function (key) {
    if (existing.indexOf(key) !== -1) return;
    var value = SETTING_DEFAULTS[key];
    if (key === 'Owner email') value = Session.getEffectiveUser().getEmail();
    settings.appendRow([key, value]);
  });
  settings.setColumnWidth(1, 300).setColumnWidth(2, 460);
  settings.getRange('B2:B').setWrap(true);

  var log = ss.getSheetByName(SHEET_LOG) || ss.insertSheet(SHEET_LOG);
  if (log.getLastRow() === 0) {
    log.getRange(1, 1, 1, 3).setValues([['Time', 'Level', 'Message']]).setFontWeight('bold');
    log.setFrozenRows(1);
    log.setColumnWidth(3, 600);
  }

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('WEBHOOK_KEY')) props.setProperty('WEBHOOK_KEY', Utilities.getUuid().replace(/-/g, ''));

  logEvent('INFO', 'Sheets set up');
  SpreadsheetApp.getUi().alert('Sheets are ready. Next: "2. Connect Telegram".');
}

function sendTestLead() {
  ensureAllPermissions();
  var config = getConfig();
  var result = processLead({
    name: 'Test Lead',
    email: config.ownerEmail || Session.getEffectiveUser().getEmail(),
    phone: '+34 600 000 000',
    message: 'This is a test lead sent from the Lead Alerts menu.',
    source: 'Test'
  }, 'Test');
  SpreadsheetApp.getUi().alert(result.ok
    ? (result.duplicate ? 'Saved as duplicate (no alerts). Change "Duplicate window (hours)" to 0 to test again right away.'
      : 'Test lead saved. Check Telegram and your inbox. Any problem appears in the "Log" sheet.')
    : 'Test lead rejected: ' + result.errors.join('; '));
}

/**
 * ScriptApp.getService().getUrl() can return an internal URL instead of the
 * public deployment, so the public URL is pasted once from
 * Deploy → Manage deployments and stored in Script Properties.
 */
function showWebhookInfo() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('WEBHOOK_KEY');
  var ui = SpreadsheetApp.getUi();
  if (!key) { ui.alert('Run "1. Set up sheets" first.'); return; }

  var url = props.getProperty('WEBAPP_URL');
  if (!url) {
    var answer = ui.prompt('Website form connection',
      'In the Apps Script editor open Deploy → Manage deployments (or create one: New deployment → Web app, Execute as: Me, Who has access: Anyone).\n\n' +
      'Click "Copy" under the Web app URL and paste it here:', ui.ButtonSet.OK_CANCEL);
    if (answer.getSelectedButton() !== ui.Button.OK) return;
    url = normalizeWebAppUrl(answer.getResponseText());
    if (!url) {
      ui.alert('That is not a web app URL. It should start with https://script.google.com/macros/s/ and end with /exec');
      return;
    }
    props.setProperty('WEBAPP_URL', url);
  }

  var endpoint = url + '?key=' + key;
  var html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,sans-serif;font-size:13px">' +
    '<p><b>Webhook URL</b> — paste it in your form plugin (WPForms, Elementor, Webflow, Typeform…) as a "webhook" or "POST" URL:</p>' +
    '<textarea style="width:100%;height:60px" readonly>' + endpoint + '</textarea>' +
    '<p><b>Plain HTML website?</b> Copy <code>examples/website-form.html</code> from the delivery and replace <code>WEBHOOK_URL</code> with the URL above.</p>' +
    '<p>Test it: open <a target="_blank" href="' + url + '">this link</a>. You should see <code>"ok":true</code>.</p>' +
    '<p style="color:#666">Keep this URL private: anyone with it can send leads to this sheet. ' +
    'Pasted the wrong deployment? Use "Website form: change web app URL".</p></div>'
  ).setWidth(540).setHeight(300);
  ui.showModalDialog(html, 'Website form connection');
}

function resetWebAppUrl() {
  PropertiesService.getScriptProperties().deleteProperty('WEBAPP_URL');
  showWebhookInfo();
}

function connectGoogleForm() {
  ensureAllPermissions();
  var ss = SpreadsheetApp.getActive();
  deleteTriggersFor('onFormSubmitHandler');
  ScriptApp.newTrigger('onFormSubmitHandler').forSpreadsheet(ss).onFormSubmit().create();
  logEvent('INFO', 'Listening to Google Form submissions');
  SpreadsheetApp.getUi().alert('Done. In your Google Form open Responses → Link to Sheets and choose THIS spreadsheet. Every new response will trigger the alerts.');
}

function applyDailySummarySchedule() {
  ensureAllPermissions();
  var hour = getConfig().dailySummaryHour;
  deleteTriggersFor('sendDailySummary');
  if (hour === null || isNaN(hour)) {
    SpreadsheetApp.getUi().alert('Daily summary is off. Put an hour (0-23) in Settings to turn it on.');
    return;
  }
  ScriptApp.newTrigger('sendDailySummary').timeBased().everyDays(1).atHour(hour).create();
  SpreadsheetApp.getUi().alert('Daily summary scheduled around ' + hour + ':00 every day.');
}

function sendDailySummary() {
  var config = getConfig();
  var sheet = getSheet(SHEET_LEADS);
  var tz = Session.getScriptTimeZone();
  var yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  var dayKey = Utilities.formatDate(yesterday, tz, 'yyyy-MM-dd');
  var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues() : [];
  var leads = rows.filter(function (r) {
    return r[0] instanceof Date && Utilities.formatDate(r[0], tz, 'yyyy-MM-dd') === dayKey && r[7] !== 'Duplicate';
  }).map(function (r) { return { name: r[1], email: r[2], phone: r[3], source: r[5] }; });
  tryStep('Daily summary', function () {
    sendTelegram(config.telegramChatId, buildDailySummary(leads, 'Leads on ' + dayKey, config.businessName));
  });
}

function removeAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  logEvent('INFO', 'All automations turned off');
  SpreadsheetApp.getUi().alert('All automations are off. The website webhook still saves leads until you archive the deployment.');
}

// ───────────────────────── Look & feel ─────────────────────────

/** Restyles the Leads sheet without touching the data. Safe to run any time. */
function applyModernStyle() {
  var sheet = getSheet(SHEET_LEADS);
  applyLeadsStyle(sheet);
  SpreadsheetApp.getActive().setActiveSheet(sheet);
}

function applyLeadsStyle(sheet) {
  var cols = LEAD_HEADERS.length;
  var last = Math.max(sheet.getLastRow(), 1);
  sheet.setHiddenGridlines(true);
  sheet.setFrozenRows(1);
  LEAD_WIDTHS.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });

  sheet.getBandings().forEach(function (b) { b.remove(); });
  var oldFilter = sheet.getFilter();
  if (oldFilter) oldFilter.remove();
  sheet.getRange(1, 1, sheet.getMaxRows(), cols).clearDataValidations().setBackground(null);

  var header = sheet.getRange(1, 1, 1, cols);
  header.setValues([LEAD_HEADERS]).setBackground(THEME.header).setFontColor('#ffffff').setFontFamily(THEME.font)
    .setFontWeight('bold').setFontSize(10).setVerticalAlignment('middle');
  sheet.getRange(1, 8).setHorizontalAlignment('center');
  sheet.setRowHeight(1, 44);

  if (last > 2) sheet.getRange(2, 1, last - 1, cols).sort({ column: 1, ascending: false }); // newest first
  styleLeadRows(sheet, 2, last - 1);
  var empty = sheet.getMaxRows() - last;
  if (empty > 0) sheet.setRowHeights(last + 1, empty, 40);

  sheet.getRange(1, 1, sheet.getMaxRows(), cols)
    .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false)
    .setHeaderRowColor(THEME.header).setFirstRowColor('#ffffff').setSecondRowColor(THEME.band);
  sheet.getRange(1, 1, Math.max(last, 2), cols).createFilter();

  var statusRange = sheet.getRange(2, 8, sheet.getMaxRows() - 1, 1);
  sheet.setConditionalFormatRules(Object.keys(THEME.status).map(function (status) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(status)
      .setBackground(THEME.status[status].bg).setFontColor(THEME.status[status].fg)
      .setRanges([statusRange]).build();
  }));
}

// ───────────────────────── Helpers ─────────────────────────

/**
 * Google lets people untick individual permissions on the consent screen.
 * If one is missing (e.g. "connect to an external service"), ask for it again
 * instead of failing later with a confusing error.
 */
function ensureAllPermissions() {
  if (typeof ScriptApp.requireAllScopes === 'function') {
    ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  }
}

function getConfig() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_SETTINGS);
  var rows = sheet && sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues() : [];
  return parseSettings(rows);
}

function setSetting(key, value) {
  var sheet = getSheet(SHEET_SETTINGS);
  var keys = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues() : [];
  for (var i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) { sheet.getRange(i + 2, 2).setValue(value); return; }
  }
  sheet.appendRow([key, value]);
}

function getSheet(name) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error('Sheet "' + name + '" not found — run "1. Set up sheets"');
  return sheet;
}

function deleteTriggersFor(handler) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

function logEvent(level, message) {
  try {
    var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_LOG);
    if (!sheet) { console.log(level + ': ' + message); return; }
    sheet.appendRow([new Date(), level, message]);
    var extra = sheet.getLastRow() - 1 - MAX_LOG_ROWS;
    if (extra > 0) sheet.deleteRows(2, extra);
  } catch (err) {
    console.log(level + ': ' + message);
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
