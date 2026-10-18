/**
 * Minimal in-memory stand-ins for the Google Apps Script services used by
 * Main.js, so the full flow (webhook → sheet → Telegram/email) can be tested
 * in Node without a Google account.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** Any formatting call (setFontWeight, setBackground…) is a chainable no-op. */
function chainable(target) {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      return () => chainable(target);
    }
  });
}

function makeSheet(name) {
  const rows = [];
  const sheet = {
    name,
    rows,
    getName: () => name,
    getLastRow: () => rows.length,
    appendRow(values) { rows.push(values.slice()); return sheet; },
    deleteRows(start, count) { rows.splice(start - 1, count); },
    getRange(a, b, c, d) {
      if (typeof a === 'string') return chainable({ setDataValidation: () => {}, setNumberFormat: () => {} });
      const row = a, col = b, numRows = c || 1, numCols = d || 1;
      return chainable({
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const src = rows[row - 1 + r] || [];
            const line = [];
            for (let k = 0; k < numCols; k++) line.push(src[col - 1 + k] === undefined ? '' : src[col - 1 + k]);
            out.push(line);
          }
          return out;
        },
        setValues(values) {
          values.forEach((line, r) => {
            const idx = row - 1 + r;
            while (rows.length <= idx) rows.push([]);
            line.forEach((v, k) => { rows[idx][col - 1 + k] = v; });
          });
          return this;
        },
        setValue(v) {
          while (rows.length < row) rows.push([]);
          rows[row - 1][col - 1] = v;
          return this;
        }
      });
    },
    setConditionalFormatRules: () => {},
  };
  return chainable(sheet);
}

function createGasEnvironment(options = {}) {
  const sheets = {};
  const fetchCalls = [];
  const emails = [];
  const props = {};
  const cache = {};
  const triggers = [];
  const telegramUpdates = options.telegramUpdates || [];

  const spreadsheet = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n))
  };

  const ui = {
    alerts: [],
    alert(...args) { ui.alerts.push(args.join(' | ')); },
    prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => options.promptText || '' }),
    showModalDialog() {},
    createMenu: () => chainable({}),
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' },
    Button: { OK: 'OK' }
  };

  const context = {
    console,
    SpreadsheetApp: {
      getActive: () => spreadsheet,
      getActiveSpreadsheet: () => spreadsheet,
      getUi: () => ui,
      newDataValidation: () => chainable({ build: () => ({}) }),
      newConditionalFormatRule: () => chainable({ build: () => ({}) })
    },
    UrlFetchApp: {
      fetch(url, params) {
        fetchCalls.push({ url, payload: params && params.payload ? JSON.parse(params.payload) : null });
        if (options.telegramDown) {
          return { getResponseCode: () => 502, getContentText: () => '{"ok":false,"description":"Bad Gateway"}' };
        }
        let result = true;
        if (url.endsWith('/getMe')) result = { id: 1, username: 'demo_bot' };
        if (url.endsWith('/getUpdates')) result = telegramUpdates;
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, result }) };
      }
    },
    MailApp: { sendEmail(opts) { emails.push(opts); } },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; },
        deleteProperty: (k) => { delete props[k]; }
      })
    },
    CacheService: {
      getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ setMimeType() { return this; }, getContent: () => s })
    },
    HtmlService: { createHtmlOutput: () => chainable({}) },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }),
      getScriptTimeZone: () => 'Europe/Madrid'
    },
    Utilities: {
      getUuid: () => '1234abcd-0000-0000-0000-00000000beef',
      formatDate: (d) => d.toISOString().slice(0, 10)
    },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/DEMO/exec' }),
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger(handler) {
        const t = { handler, getHandlerFunction: () => handler };
        const builder = chainable({ create() { triggers.push(t); return t; } });
        return builder;
      }
    }
  };

  vm.createContext(context);
  const src = path.join(__dirname, '..', 'src');
  vm.runInContext(fs.readFileSync(path.join(src, 'Core.js'), 'utf8'), context, { filename: 'Core.js' });
  vm.runInContext(fs.readFileSync(path.join(src, 'Main.js'), 'utf8'), context, { filename: 'Main.js' });

  return { gas: context, sheets, fetchCalls, emails, props, triggers, ui };
}

module.exports = { createGasEnvironment };
