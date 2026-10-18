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
    parseSettings: parseSettings, normalizeWebAppUrl: normalizeWebAppUrl, buildDailySummary: buildDailySummary, SETTING_DEFAULTS: SETTING_DEFAULTS
  };
}
