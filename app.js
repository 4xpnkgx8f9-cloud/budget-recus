/* Budget Reçus — PWA local + OCR local (Tesseract.js)
   - Multi-cartes
   - Budget mensuel éditable (par mois)
   - Report automatique: Disponible(mois)=Budget(mois)+Report(mois-1)
   - Écran de validation après OCR (modal)
*/

const DB_NAME = "budgetRecusDB";
const DB_VER = 1;
const STORE = "data";
const DEFAULT_BUDGET = 2500;

const $ = (id) => document.getElementById(id);

const state = {
  cards: [],
  expenses: [],
  budgets: {},   // budgets[cardId][YYYY-MM] = number
  currentCardId: null,
  currentMonth: null,

  // draft after OCR
  draft: null
};

function euro(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);
}

function nowMonth() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}`;
}

function monthKey(dateISO) {
  const d = new Date(dateISO);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}`;
}

function prevMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  d.setMonth(d.getMonth() - 1);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${mm}`;
}

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

/* ---------------- IndexedDB ---------------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, val) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.put(val, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function persist() {
  await dbSet("cards", state.cards);
  await dbSet("expenses", state.expenses);
  await dbSet("budgets", state.budgets);
  await dbSet("currentCardId", state.currentCardId);
  await dbSet("currentMonth", state.currentMonth);
}

async function hydrate() {
  state.cards = (await dbGet("cards")) || [];
  state.expenses = (await dbGet("expenses")) || [];
  state.budgets = (await dbGet("budgets")) || {};
  state.currentCardId = (await dbGet("currentCardId")) || null;
  state.currentMonth = (await dbGet("currentMonth")) || nowMonth();

  if (state.cards.length === 0) {
    const cardId = uid();
    state.cards = [{ id: cardId, name: "Carte parents" }];
    state.currentCardId = cardId;
    state.budgets[cardId] = {};
    state.budgets[cardId][state.currentMonth] = DEFAULT_BUDGET;
    await persist();
  }

  if (!state.currentCardId) state.currentCardId = state.cards[0].id;
  if (!state.budgets[state.currentCardId]) state.budgets[state.currentCardId] = {};
  if (typeof state.budgets[state.currentCardId][state.currentMonth] !== "number") {
    state.budgets[state.currentCardId][state.currentMonth] = DEFAULT_BUDGET;
    await persist();
  }
}

/* -------------- Budget / Report -------------- */
function getBudget(cardId, ym) {
  if (!state.budgets[cardId]) state.budgets[cardId] = {};
  const v = state.budgets[cardId][ym];
  return typeof v === "number" ? v : DEFAULT_BUDGET;
}

function expensesFor(cardId, ym) {
  return state.expenses.filter(e => e.cardId === cardId && monthKey(e.dateISO) === ym);
}

function sumExpenses(cardId, ym) {
  return expensesFor(cardId, ym).reduce((a, e) => a + (e.amount || 0), 0);
}

// Memoized rollover for performance
function buildRolloverMemo(cardId) {
  const memo = new Map();
  function roll(ym, depth = 0) {
    if (depth > 120) return 0;
    if (memo.has(ym)) return memo.get(ym);
    const pm = prevMonth(ym);
    const avail = getBudget(cardId, ym) + roll(pm, depth + 1);
    const out = avail - sumExpenses(cardId, ym);
    memo.set(ym, out);
    return out;
  }
  return roll;
}

function available(cardId, ym) {
  const roll = buildRolloverMemo(cardId);
  return getBudget(cardId, ym) + roll(prevMonth(ym));
}

/* ---------------- UI ---------------- */
function renderCards() {
  const sel = $("cardSelect");
  sel.innerHTML = "";
  state.cards.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  });
  sel.value = state.currentCardId;
}

function renderKPIs() {
  const cardId = state.currentCardId;
  const ym = state.currentMonth;

  const b = getBudget(cardId, ym);
  const a = available(cardId, ym);
  const s = sumExpenses(cardId, ym);
  const r = a - s;

  $("kpiBudget").textContent = euro(b);
  $("kpiAvailable").textContent = euro(a);
  $("kpiSpent").textContent = euro(s);
  $("kpiRollover").textContent = euro(r);
}

function renderExpenses() {
  const list = $("expensesList");
  list.innerHTML = "";
  const items = expensesFor(state.currentCardId, state.currentMonth)
    .sort((x,y) => new Date(y.dateISO) - new Date(x.dateISO));

  $("emptyState").style.display = items.length ? "none" : "block";

  for (const e of items) {
    const div = document.createElement("div");
    div.className = "item";

    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "itemTitle";
    title.textContent = e.merchant || "Commerçant inconnu";

    const meta = document.createElement("div");
    meta.className = "itemMeta";
    const d = new Date(e.dateISO);
    meta.textContent = `${d.toLocaleDateString("fr-FR")} • ${e.note || "Reçu"}`;

    left.appendChild(title);
    left.appendChild(meta);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.gap = "10px";
    right.style.alignItems = "center";

    const amt = document.createElement("div");
    amt.className = "itemAmt";
    amt.textContent = euro(e.amount);

    const edit = document.createElement("button");
    edit.className = "btn secondary";
    edit.textContent = "Éditer";
    edit.onclick = async () => {
      openModal({
        ...e,
        mode: "edit"
      });
    };

    const del = document.createElement("button");
    del.className = "btn secondary";
    del.textContent = "Suppr.";
    del.onclick = async () => {
      if (!confirm("Supprimer cette dépense ?")) return;
      state.expenses = state.expenses.filter(x => x.id !== e.id);
      await persist();
      refresh();
    };

    right.appendChild(amt);
    right.appendChild(edit);
    right.appendChild(del);

    div.appendChild(left);
    div.appendChild(right);
    list.appendChild(div);
  }
}

function refresh() {
  renderCards();
  $("monthSelect").value = state.currentMonth;
  renderKPIs();
  renderExpenses();
}

/* -------------- OCR + Parsing -------------- */
function showProgress(show, text = "", pct = 0) {
  $("progressWrap").hidden = !show;
  $("progressText").textContent = text;
  $("progressBarFill").style.width = `${Math.round(pct * 100)}%`;
}

// Montant: priorité aux lignes TOTAL, sinon max montant
function parseAmount(text) {
  const moneyRegex = /(\d{1,3}(?:[ .]\d{3})*(?:[.,]\d{2}))/g; // 1 234,56
  const toNumber = (s) => {
    const v = s.replace(/ /g, "").replace(/\./g, "").replace(",", ".");
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (/TOTAL|TTC|MONTANT|A PAYER|À PAYER|A\s*PAYER/i.test(l)) {
      const m = l.match(moneyRegex);
      if (m && m.length) {
        const n = toNumber(m[m.length - 1]);
        if (n) return n;
      }
    }
  }

  const all = [...text.matchAll(moneyRegex)].map(x => toNumber(x[1])).filter(n => n && n < 100000);
  if (!all.length) return null;
  return Math.max(...all);
}

function parseDateISO(text) {
  const m1 = text.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (m1) {
    let [_, d, m, y] = m1;
    if (y.length === 2) y = "20" + y;
    const iso = `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    return iso;
  }
  const m2 = text.match(/(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/);
  if (m2) {
    const [_, y, m, d] = m2;
    const iso = `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    return iso;
  }
  // fallback today
  return new Date().toISOString().slice(0,10);
}

function parseMerchant(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const l of lines.slice(0, 10)) {
    const up = l.toUpperCase();
    if (/TICKET|RECU|REÇU|FACTURE|MERCI|CARTE|CB|TVA|SIRET|RCS|TEL|WWW|HTTP|HTTPS|FR\d{2}|\bTVA\b/.test(up)) continue;
    if (/^\d+$/.test(l.replace(/\s/g, ""))) continue;
    if (l.length < 3) continue;
    // Ignore lines mostly digits/punctuation
    const letters = l.replace(/[^A-Za-zÀ-ÿ]/g, "");
    if (letters.length < 3) continue;
    return l.slice(0, 50);
  }
  return "Commerçant inconnu";
}

async function ocrImage(file) {
  showProgress(true, "Préparation OCR…", 0);
  const { data } = await Tesseract.recognize(file, "fra", {
    logger: (m) => {
      if (m.status === "recognizing text" && typeof m.progress === "number") {
        showProgress(true, "Lecture du reçu…", m.progress);
      }
    }
  });
  showProgress(false);
  return data.text || "";
}

/* -------------- Modal (validation) -------------- */
function openModal(draft) {
  state.draft = draft;

  const isEdit = draft.mode === "edit";
  $("modalTitle").textContent = isEdit ? "Modifier la dépense" : "Valider la dépense";
  $("mMerchant").value = draft.merchant || "";
  $("mAmount").value = (draft.amount ?? "") === 0 && !isEdit ? "" : (draft.amount ?? "");
  $("mDate").value = (draft.dateISO || new Date().toISOString().slice(0,10)).slice(0,10);
  $("mNote").value = draft.note || "";
  $("mRaw").textContent = draft.rawText || "";

  $("btnDiscard").style.display = isEdit ? "none" : "inline-flex";

  $("modalBackdrop").hidden = false;
  $("ocrModal").hidden = false;
}

function closeModal() {
  state.draft = null;
  $("modalBackdrop").hidden = true;
  $("ocrModal").hidden = true;
}

function validateDraftInputs() {
  const amount = Number(String($("mAmount").value).replace(",", "."));
  const date = $("mDate").value;
  const merchant = $("mMerchant").value.trim() || "Commerçant inconnu";
  const note = $("mNote").value.trim();

  if (!Number.isFinite(amount) || amount <= 0) {
    alert("Montant invalide (doit être > 0).");
    return null;
  }
  if (!date) {
    alert("Date invalide.");
    return null;
  }
  return { amount, dateISO: date + "T12:00:00.000Z", merchant, note };
}

/* -------------- Import / Export (JSON) -------------- */
function download(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function exportAll() {
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    cards: state.cards,
    expenses: state.expenses,
    budgets: state.budgets,
    currentCardId: state.currentCardId,
    currentMonth: state.currentMonth
  };
  download(`budget-recus-export-${Date.now()}.json`, JSON.stringify(payload, null, 2));
}

async function importAll() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const txt = await file.text();
    let data = null;
    try { data = JSON.parse(txt); } catch { return alert("JSON invalide."); }

    if (!data || !Array.isArray(data.cards) || !Array.isArray(data.expenses)) {
      return alert("Fichier invalide.");
    }
    if (!confirm("Importer va remplacer tes données locales actuelles. Continuer ?")) return;

    state.cards = data.cards;
    state.expenses = data.expenses;
    state.budgets = data.budgets || {};
    state.currentCardId = data.currentCardId || (state.cards[0]?.id ?? null);
    state.currentMonth = data.currentMonth || nowMonth();

    await persist();
    refresh();
  };
  input.click();
}

/* -------------- Cards / Budgets -------------- */
async function addCard() {
  const name = prompt("Nom de la carte :");
  if (!name) return;
  const id = uid();
  state.cards.push({ id, name: name.trim() });
  state.budgets[id] = {};
  state.budgets[id][state.currentMonth] = DEFAULT_BUDGET;
  state.currentCardId = id;
  await persist();
  refresh();
}

async function editBudget() {
  const ym = state.currentMonth;
  const current = getBudget(state.currentCardId, ym);
  const v = prompt(`Budget du mois (${ym}) en € :`, String(current).replace(".", ",")); 
  if (v === null) return;
  const n = Number(v.replace(",", ".").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n < 0) return alert("Budget invalide.");
  if (!state.budgets[state.currentCardId]) state.budgets[state.currentCardId] = {};
  state.budgets[state.currentCardId][ym] = n;
  await persist();
  refresh();
}

/* ---------------- Init ---------------- */
async function init() {
  await hydrate();

  renderCards();
  $("monthSelect").value = state.currentMonth;

  $("cardSelect").addEventListener("change", async (e) => {
    state.currentCardId = e.target.value;
    await persist();
    refresh();
  });

  $("monthSelect").addEventListener("change", async (e) => {
    state.currentMonth = e.target.value || nowMonth();
    if (!state.budgets[state.currentCardId]) state.budgets[state.currentCardId] = {};
    if (typeof state.budgets[state.currentCardId][state.currentMonth] !== "number") {
      state.budgets[state.currentCardId][state.currentMonth] = getBudget(state.currentCardId, state.currentMonth);
      await persist();
    }
    refresh();
  });

  $("btnAddCard").addEventListener("click", addCard);
  $("btnEditBudget").addEventListener("click", editBudget);
  $("btnExport").addEventListener("click", exportAll);
  $("btnImport").addEventListener("click", importAll);

  // Modal buttons
  $("modalClose").addEventListener("click", closeModal);
  $("modalBackdrop").addEventListener("click", closeModal);
  $("btnCancel").addEventListener("click", closeModal);
  $("btnDiscard").addEventListener("click", () => { closeModal(); });

  $("btnSave").addEventListener("click", async () => {
    const patch = validateDraftInputs();
    if (!patch || !state.draft) return;

    const isEdit = state.draft.mode === "edit";
    if (isEdit) {
      // Update existing
      const idx = state.expenses.findIndex(x => x.id === state.draft.id);
      if (idx >= 0) {
        state.expenses[idx] = {
          ...state.expenses[idx],
          ...patch
        };
      }
    } else {
      // Create new
      const exp = {
        id: uid(),
        cardId: state.currentCardId,
        amount: patch.amount,
        dateISO: patch.dateISO,
        merchant: patch.merchant,
        note: patch.note,
        rawText: state.draft.rawText || ""
      };
      state.expenses.push(exp);

      // Ensure budget exists for that month
      const ym = monthKey(exp.dateISO);
      if (!state.budgets[state.currentCardId]) state.budgets[state.currentCardId] = {};
      if (typeof state.budgets[state.currentCardId][ym] !== "number") {
        state.budgets[state.currentCardId][ym] = getBudget(state.currentCardId, ym);
      }
      // If user scanned a receipt from another month, jump there for clarity
      state.currentMonth = ym;
    }

    await persist();
    closeModal();
    refresh();
  });

  $("receiptInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await ocrImage(file);
      const draft = {
        merchant: parseMerchant(text),
        amount: parseAmount(text) ?? 0,
        dateISO: parseDateISO(text),
        note: "Reçu scanné",
        rawText: text
      };
      openModal(draft);
    } catch (err) {
      console.error(err);
      alert("Erreur OCR. Essaie avec une photo plus nette, bien cadrée, et sans ombre.");
    } finally {
      e.target.value = "";
    }
  });

  refresh();
}

init();
