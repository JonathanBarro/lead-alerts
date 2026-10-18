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
var MAX_LEADS_PER_MINUTE = 30;
var MAX_LOG_ROWS = 1000;

// ───────────────────────── Menu ─────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚡ Lead Alerts')
    .addItem('1. Set up sheets', 'setupSheets')
    .addItem('2. Connect Telegram', 'connectTelegram')
    .addItem('3. Send a test lead', 'sendTestLead')
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
    sheet.appendRow([
      now, lead.name, lead.email, lead.phone, lead.message, lead.source,
      Object.keys(lead.extra).length ? JSON.stringify(lead.extra) : '',
      duplicate ? 'Duplicate' : 'New', ''
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
      var options = { to: config.ownerEmail, subject: 'New lead: ' + (lead.name || lead.email || lead.phone), body: body };
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

function readRecentLeads(sheet, limit) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var start = Math.max(2, last - limit + 1);
  return sheet.getRange(start, 1, last - start + 1, 4).getValues().map(function (r) {
    return { receivedAt: r[0], email: r[2], phone: r[3] };
  });
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
  if (leads.getLastRow() === 0) {
    leads.getRange(1, 1, 1, LEAD_HEADERS.length).setValues([LEAD_HEADERS])
      .setFontWeight('bold').setBackground('#1f3a5f').setFontColor('#ffffff');
    leads.setFrozenRows(1);
    leads.setColumnWidths(1, 1, 150);
    leads.setColumnWidths(2, 4, 180);
    leads.setColumnWidth(5, 320);
    leads.getRange('A2:A').setNumberFormat('yyyy-mm-dd hh:mm');
    leads.getRange('E2:E').setWrap(true);
    var statusRange = leads.getRange('H2:H');
    statusRange.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build());
    var colors = { New: '#fff4c2', Contacted: '#dbe9ff', Won: '#d4f5dd', Lost: '#eeeeee', Duplicate: '#f4e1e1' };
    leads.setConditionalFormatRules(Object.keys(colors).map(function (status) {
      return SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$H2="' + status + '"')
        .setBackground(colors[status]).setRanges([leads.getRange('A2:I')]).build();
    }));
  }

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
