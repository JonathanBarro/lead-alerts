const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/Core.js');
const { createGasEnvironment } = require('./gas-mocks.js');

// ───────────── Pure logic ─────────────

test('extractLead maps English, Spanish and plugin-style field names', () => {
  const lead = core.extractLead({
    'Nombre completo': 'Lucía Pérez',
    'E-mail': 'LUCIA@Example.com ',
    'Teléfono': '+34 611 22 33 44',
    'your-message': 'Quiero info del curso',
    'Course': 'Inglés B2',
    key: 'secret',
    website_hp: ''
  }, '2026-10-15T10:00:00.000Z');
  assert.equal(lead.name, 'Lucía Pérez');
  assert.equal(lead.email, 'lucia@example.com');
  assert.equal(lead.phone, '+34611223344');
  assert.equal(lead.message, 'Quiero info del curso');
  assert.deepEqual(lead.extra, { Course: 'Inglés B2' });
});

test('extractLead reads Google Forms namedValues (arrays) and skips the timestamp', () => {
  const lead = core.extractLead({ Timestamp: ['15/10/2026 10:00'], Name: ['Ana'], Email: ['ana@test.es'] }, 'x');
  assert.equal(lead.name, 'Ana');
  assert.equal(lead.email, 'ana@test.es');
  assert.deepEqual(lead.extra, {});
});

test('validateLead enforces required fields and email format', () => {
  assert.deepEqual(core.validateLead({ email: 'a@b.com', phone: '' }, ['email']), []);
  assert.match(core.validateLead({ email: 'not-an-email', phone: '' }, [])[0], /Invalid email/);
  assert.match(core.validateLead({ email: '', phone: '' }, ['email']).join(' '), /Missing required field: email/);
});

test('isDuplicate only looks inside the time window', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const recent = [{ email: 'a@b.com', phone: '', receivedAt: new Date('2026-10-15T02:00:00Z') }];
  assert.equal(core.isDuplicate({ email: 'a@b.com', phone: '' }, recent, 24, now), true);
  assert.equal(core.isDuplicate({ email: 'a@b.com', phone: '' }, recent, 6, now), false);
  assert.equal(core.isDuplicate({ email: 'other@b.com', phone: '' }, recent, 24, now), false);
  assert.equal(core.isDuplicate({ email: 'a@b.com', phone: '' }, recent, 0, now), false);
});

test('Telegram message escapes HTML so a lead cannot break the alert', () => {
  const msg = core.buildTelegramMessage({ name: '<script>', email: 'a@b.com', phone: '', message: 'x & y', source: '', extra: {} }, 'Acme');
  assert.match(msg, /&lt;script&gt;/);
  assert.match(msg, /x &amp; y/);
  assert.doesNotMatch(msg, /<script>/);
});

test('renderTemplate fills known tags and blanks unknown ones', () => {
  const out = core.renderTemplate('Hi {{name}} from {{ business }}{{unknown}}', { name: 'Lucía Pérez' }, 'Academia Sol');
  assert.equal(out, 'Hi Lucía from Academia Sol');
});

test('parseSettings applies defaults and types', () => {
  const cfg = core.parseSettings([['Business name', 'Academia Sol'], ['Send Telegram alert', 'no'], ['Daily summary hour (0-23, blank = off)', 8]]);
  assert.equal(cfg.businessName, 'Academia Sol');
  assert.equal(cfg.sendTelegram, false);
  assert.equal(cfg.sendOwnerEmail, true);
  assert.equal(cfg.dailySummaryHour, 8);
  assert.deepEqual(cfg.requiredFields, ['email']);
});

// ───────────── Full flow with mocked Google services ─────────────

function readyEnv(options) {
  const env = createGasEnvironment(options);
  env.gas.setupSheets();
  env.gas.setSetting('Telegram chat ID', '999');
  env.props.TELEGRAM_TOKEN = '123:abc';
  return env;
}

function post(env, params, key) {
  const res = env.gas.doPost({ parameter: Object.assign({ key: key === undefined ? env.props.WEBHOOK_KEY : key }, params) });
  return JSON.parse(res.getContent());
}

test('setup creates the three sheets, default settings and a webhook key', () => {
  const env = createGasEnvironment();
  env.gas.setupSheets();
  assert.ok(env.sheets.Leads && env.sheets.Settings && env.sheets.Log);
  assert.equal(env.sheets.Leads.rows[0][0], 'Received at');
  assert.equal(env.props.WEBHOOK_KEY, '1234abcd00000000000000000000beef');
  const owner = env.sheets.Settings.rows.find((r) => r[0] === 'Owner email');
  assert.equal(owner[1], 'owner@example.com');
});

test('a website lead is saved and triggers Telegram, owner email and auto-reply', () => {
  const env = readyEnv();
  const res = post(env, { name: 'Lucía Pérez', email: 'lucia@example.com', message: 'Hola' });
  assert.deepEqual(res, { ok: true, duplicate: false });
  const row = env.sheets.Leads.rows[1];
  assert.equal(row[1], 'Lucía Pérez');
  assert.equal(row[5], 'Website');
  assert.equal(row[7], 'New');
  const tg = env.fetchCalls.find((c) => c.url.endsWith('/sendMessage'));
  assert.equal(tg.payload.chat_id, '999');
  assert.match(tg.payload.text, /Lucía Pérez/);
  assert.equal(env.emails.length, 2);
  assert.equal(env.emails[0].to, 'owner@example.com');
  assert.equal(env.emails[0].replyTo, 'lucia@example.com');
  assert.equal(env.emails[1].to, 'lucia@example.com');
  assert.match(env.emails[1].body, /^Hi Lucía,/);
});

test('wrong key is rejected and nothing is saved', () => {
  const env = readyEnv();
  assert.deepEqual(post(env, { email: 'a@b.com' }, 'wrong'), { ok: false, error: 'unauthorized' });
  assert.equal(env.sheets.Leads.rows.length, 1);
});

test('honeypot spam is dropped silently', () => {
  const env = readyEnv();
  assert.deepEqual(post(env, { email: 'bot@spam.com', website_hp: 'http://spam' }), { ok: true });
  assert.equal(env.sheets.Leads.rows.length, 1);
  assert.equal(env.emails.length, 0);
});

test('a repeated lead is saved as Duplicate with no alerts', () => {
  const env = readyEnv();
  post(env, { email: 'lucia@example.com' });
  const before = env.emails.length;
  const res = post(env, { email: 'lucia@example.com' });
  assert.equal(res.duplicate, true);
  assert.equal(env.sheets.Leads.rows[2][7], 'Duplicate');
  assert.equal(env.emails.length, before);
});

test('invalid lead is rejected and logged', () => {
  const env = readyEnv();
  const res = post(env, { name: 'No contact' });
  assert.equal(res.ok, false);
  assert.ok(env.sheets.Log.rows.some((r) => /Lead rejected/.test(r[2])));
});

test('if Telegram is down the lead is still saved and emails still go out', () => {
  const env = readyEnv({ telegramDown: true });
  const res = post(env, { email: 'lucia@example.com' });
  assert.equal(res.ok, true);
  assert.equal(env.sheets.Leads.rows.length, 2);
  assert.equal(env.emails.length, 2);
  assert.ok(env.sheets.Log.rows.some((r) => /Telegram alert failed/.test(r[2])));
});

test('rate limit blocks floods', () => {
  const env = readyEnv();
  let last;
  for (let i = 0; i < 31; i++) last = post(env, { email: `user${i}@example.com` });
  assert.deepEqual(last, { ok: false, error: 'too many requests' });
});

test('JSON payloads are accepted too', () => {
  const env = readyEnv();
  const res = env.gas.doPost({
    parameter: { key: env.props.WEBHOOK_KEY },
    postData: { type: 'application/json', contents: JSON.stringify({ name: 'Json Lead', email: 'j@example.com' }) }
  });
  assert.equal(JSON.parse(res.getContent()).ok, true);
  assert.equal(env.sheets.Leads.rows[1][1], 'Json Lead');
});

test('Google Form submissions go through the same flow', () => {
  const env = readyEnv();
  env.gas.onFormSubmitHandler({ namedValues: { Timestamp: ['x'], Nombre: ['Ana'], Correo: ['ana@test.es'] } });
  assert.equal(env.sheets.Leads.rows[1][1], 'Ana');
  assert.equal(env.sheets.Leads.rows[1][5], 'Google Form');
});

// Built at runtime so no token-shaped string sits in the source (it only needs to match /^\d+:[\w-]{30,}$/).
const FAKE_BOT_TOKEN = ['123456789', 'x'.repeat(35)].join(':');

test('Connect Telegram stores the token and detects the chat ID', () => {
  const env = createGasEnvironment({
    promptText: FAKE_BOT_TOKEN,
    telegramUpdates: [{ message: { chat: { id: 4242, first_name: 'Lucía' } } }]
  });
  env.gas.setupSheets();
  env.gas.connectTelegram();
  assert.equal(env.props.TELEGRAM_TOKEN, FAKE_BOT_TOKEN);
  assert.equal(env.sheets.Settings.rows.find((r) => r[0] === 'Telegram chat ID')[1], '4242');
});

test('daily summary trigger is created from the Settings hour', () => {
  const env = readyEnv();
  env.gas.setSetting('Daily summary hour (0-23, blank = off)', 8);
  env.gas.applyDailySummarySchedule();
  assert.deepEqual(env.triggers.map((t) => t.handler), ['sendDailySummary']);
  env.gas.applyDailySummarySchedule();
  assert.equal(env.triggers.length, 1, 'no duplicate triggers');
});

test('normalizeWebAppUrl keeps only the public /exec URL', () => {
  const base = 'https://script.google.com/macros/s/AKfyc-b_123/exec';
  assert.equal(core.normalizeWebAppUrl('  ' + base + '?key=abc '), base);
  assert.equal(core.normalizeWebAppUrl('https://script.google.com/a/midominio.es/macros/s/AKf/exec'), 'https://script.google.com/a/midominio.es/macros/s/AKf/exec');
  assert.equal(core.normalizeWebAppUrl('https://example.com/exec'), '');
  assert.equal(core.normalizeWebAppUrl('https://script.google.com/macros/s/AKf/dev'), '');
});

test('webhook info asks for the deployment URL once and stores it', () => {
  const env = createGasEnvironment({ promptText: 'https://script.google.com/macros/s/AKfycbREAL/exec' });
  env.gas.setupSheets();
  env.gas.showWebhookInfo();
  assert.equal(env.props.WEBAPP_URL, 'https://script.google.com/macros/s/AKfycbREAL/exec');
});
