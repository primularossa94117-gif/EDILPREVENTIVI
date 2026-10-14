
/* =========================================================
   EDILPREVENTIVI - EDIL SALVATORE
   Firebase Authentication + Firestore v8
   Numerazione progressiva e archivio con ricerca
   ========================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyCI4xPxYZR7yu0i18od_I2bYTHgtVDm-KI",
  authDomain: "edilpreventivi-ffca1.firebaseapp.com",
  projectId: "edilpreventivi-ffca1",
  storageBucket: "edilpreventivi-ffca1.firebasestorage.app",
  messagingSenderId: "1060868244476",
  appId: "1:0860868244476:web:15f3a3a16d4bd6bdc56879",
  measurementId: "G-64Q2YDNGYF"
};

const ADMIN_UID = "rRdM9ROJMZShvMxxJiSeumtkPtn1";

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

let listaLavorazioni = [];
let listaClienti = [];
let listaPreventivi = [];
let datiDitta = {
  ragioneSociale: "EDIL SALVATORE",
  indirizzo: "LOCALITA' COSTE CORNAGGIA 84",
  piva: "0000000111111",
  codiceFiscale: "032030303003",
  telefono: "333111333",
  email: "edilsa@edi.it",
  pec: "edilsa@pec.it",
  sito: ""
};
let modalDettaglio = null;
let operazioneInCorso = false;
let avvioCompletato = false;

const $ = id => document.getElementById(id);

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[c]);
}

function numero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function euro(value) {
  return new Intl.NumberFormat("it-IT", {
    style: "currency", currency: "EUR"
  }).format(numero(value));
}

function oggi() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function dataItaliana(value) {
  if (!value) return "";
  const p = String(value).split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : value;
}

function mostraMessaggio(testo, tipo = "successo") {
  const el = $("messaggi");
  if (!el) return;
  const classe = tipo === "errore" ? "danger" :
    tipo === "attenzione" ? "warning" : "success";
  el.innerHTML = `<div class="alert alert-${classe} alert-dismissible fade show" role="alert">
    ${escapeHTML(testo)}
    <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Chiudi"></button>
  </div>`;
}

function erroreFirebase(e) {
  console.error("EdilPreventivi:", e);
  const messaggi = {
    "permission-denied": "Permessi Firebase insufficienti. Controlla le regole Firestore.",
    "unavailable": "Firebase non è momentaneamente raggiungibile.",
    "auth/invalid-credential": "Email o password non corretti.",
    "auth/wrong-password": "Password non corretta.",
    "auth/user-not-found": "Utente non trovato.",
    "auth/invalid-email": "Indirizzo email non valido.",
    "auth/too-many-requests": "Troppi tentativi. Riprova più tardi."
  };
  mostraMessaggio(messaggi[e.code] || e.message || "Si è verificato un errore.", "errore");
}

function ordinatiPerNome(elementi, campo) {
  return [...elementi].sort((a,b) =>
    String(a[campo] || "").localeCompare(String(b[campo] || ""), "it")
  );
}

function impostaCaricamento(attivo) {
  operazioneInCorso = attivo;
  $("salvaPreventivo").disabled = attivo;
  $("salvaPreventivo").textContent = attivo ? "Salvataggio..." :
    ($("preventivoId").value ? "Aggiorna preventivo" : "Salva preventivo");
}

/* =========================================================
   NUMERAZIONE PROGRESSIVA
   Formato: PREV-2026-0001
   Il contatore e il preventivo vengono scritti insieme
   tramite transazione Firestore.
   ========================================================= */

function annoPreventivo(data) {
  const anno = String(data || oggi()).slice(0,4);
  return /^\d{4}$/.test(anno) ? anno : String(new Date().getFullYear());
}

function formatoNumeroPreventivo(anno, progressivo) {
  return `PREV-${anno}-${String(progressivo).padStart(4,"0")}`;
}

function numeroEsistente(p) {
  return String(p.numeroPreventivo || p.numero || "");
}

function analizzaNumero(valore) {
  const match = /^PREV-(\d{4})-(\d+)$/i.exec(String(valore || ""));
  return match ? { anno: match[1], progressivo: Number(match[2]) } : null;
}

/* Allinea il contatore al numero più alto già presente,
   così non sovrascrive la numerazione esistente. */
async function inizializzaContatori() {
  const massimi = {};
  listaPreventivi.forEach(p => {
    const n = analizzaNumero(numeroEsistente(p));
    if (n) massimi[n.anno] = Math.max(massimi[n.anno] || 0, n.progressivo);
  });

  for (const [anno, massimo] of Object.entries(massimi)) {
    const ref = db.collection("contatori").doc(`preventivi-${anno}`);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const attuale = snap.exists ? numero(snap.data().ultimoNumero) : 0;
      if (massimo > attuale) {
        tx.set(ref, {
          anno,
          ultimoNumero: massimo,
          aggiornatoIl: new Date().toISOString()
        }, { merge: true });
      }
    });
  }
}

/* Assegna un numero ai preventivi storici che ne sono sprovvisti.
   I documenti vengono aggiornati, mai ricreati. */
async function migraNumeriStorici() {
  await inizializzaContatori();

  const senzaNumero = listaPreventivi
    .filter(p => !numeroEsistente(p))
    .sort((a,b) => String(a.data || "").localeCompare(String(b.data || "")) ||
      String(a.creatoIl || "").localeCompare(String(b.creatoIl || "")));

  for (const p of senzaNumero) {
    const anno = annoPreventivo(p.data);
    const contatoreRef = db.collection("contatori").doc(`preventivi-${anno}`);
    const preventivoRef = db.collection("preventivi").doc(p.id);

    const nuovoNumero = await db.runTransaction(async tx => {
      const [contatore, documento] = await Promise.all([
        tx.get(contatoreRef),
        tx.get(preventivoRef)
      ]);

      if (!documento.exists) return null;

      const corrente = documento.data();
      if (corrente.numeroPreventivo || corrente.numero) {
        return corrente.numeroPreventivo || corrente.numero;
      }

      const prossimo = numero(contatore.exists ? contatore.data().ultimoNumero : 0) + 1;
      const codice = formatoNumeroPreventivo(anno, prossimo);

      tx.set(contatoreRef, {
        anno,
        ultimoNumero: prossimo,
        aggiornatoIl: new Date().toISOString()
      }, { merge: true });

      tx.update(preventivoRef, {
        numeroPreventivo: codice,
        numeratoIl: new Date().toISOString()
      });

      return codice;
    });

    if (nuovoNumero) p.numeroPreventivo = nuovoNumero;
  }

  if (senzaNumero.length) {
    await caricaPreventivi();
  }
}

async function creaPreventivoConNumero(dati) {
  const anno = annoPreventivo(dati.data);
  const contatoreRef = db.collection("contatori").doc(`preventivi-${anno}`);
  const nuovoRef = db.collection("preventivi").doc();

  const codice = await db.runTransaction(async tx => {
    const contatore = await tx.get(contatoreRef);
    const prossimo = numero(contatore.exists ? contatore.data().ultimoNumero : 0) + 1;
    const codiceNumero = formatoNumeroPreventivo(anno, prossimo);

    tx.set(contatoreRef, {
      anno,
      ultimoNumero: prossimo,
      aggiornatoIl: new Date().toISOString()
    }, { merge: true });

    tx.set(nuovoRef, {
      ...dati,
      numeroPreventivo: codiceNumero,
      creatoIl: new Date().toISOString(),
      aggiornatoIl: new Date().toISOString()
    });

    return codiceNumero;
  });

  return { id: nuovoRef.id, numeroPreventivo: codice };
}

/* =========================================================
   NAVIGAZIONE
   ========================================================= */

function mostraPagina(nome) {
  document.querySelectorAll(".app-page").forEach(p =>
    p.classList.toggle("d-none", p.id !== `page-${nome}`)
  );
  document.querySelectorAll(".app-nav [data-page]").forEach(b =>
    b.classList.toggle("active", b.dataset.page === nome)
  );
}

document.querySelectorAll(".app-nav [data-page]").forEach(b =>
  b.addEventListener("click", () => mostraPagina(b.dataset.page))
);

/* =========================================================
   LOGIN E AVVIO
   ========================================================= */

$("formLogin").addEventListener("submit", async e => {
  e.preventDefault();

  const b = $("loginButton");
  const loginInserito = $("loginEmail").value.trim();
  const passwordInserita = $("loginPassword").value;

  $("loginErrore").classList.add("d-none");
  b.disabled = true;
  b.textContent = "Accesso...";

  try {
    const emailFirebase =
      loginInserito.toUpperCase() === "ADMIN"
        ? "admin@edilpreventivi-ffca1.firebaseapp.com"
        : loginInserito;

    await auth.signInWithEmailAndPassword(
      emailFirebase,
      passwordInserita
    );
  } catch (err) {
    $("loginErrore").textContent =
      "Login o password non corretti.";
    $("loginErrore").classList.remove("d-none");
  } finally {
    b.disabled = false;
    b.textContent = "Accedi";
  }
});
/* =========================================================
   CARICAMENTO DATI FIRESTORE
   ========================================================= */

async function caricaListino() {
  const s = await db.collection("listino").get();
  listaLavorazioni = s.docs.map(d => ({ id:d.id, ...d.data() }));
}

async function caricaClienti() {
  const s = await db.collection("clienti").get();
  listaClienti = s.docs.map(d => ({ id:d.id, ...d.data() }));
}

async function caricaPreventivi() {
  const s = await db.collection("preventivi").get();
  listaPreventivi = s.docs.map(d => ({ id:d.id, ...d.data() }));
  listaPreventivi.sort((a,b) =>
    String(b.data || "").localeCompare(String(a.data || "")) ||
    String(numeroEsistente(b)).localeCompare(String(numeroEsistente(a)))
  );
}

async function caricaDitta() {
  const ref = db.collection("impostazioni").doc("ditta");
  const doc = await ref.get();
  if (doc.exists) datiDitta = { ...datiDitta, ...doc.data() };
  else await ref.set(datiDitta);
  riempiFormDitta();
}

function riempiFormDitta() {
  const campi = {
    ragioneSocialeDitta:"ragioneSociale",
    indirizzoDitta:"indirizzo",
    pivaDitta:"piva",
    cfDitta:"codiceFiscale",
    telefonoDitta:"telefono",
    emailDitta:"email",
    pecDitta:"pec",
    sitoDitta:"sito"
  };
  Object.entries(campi).forEach(([id,k]) => $(id).value = datiDitta[k] || "");
}

/* =========================================================
   DATI AZIENDALI
   ========================================================= */

$("formDitta").addEventListener("submit", async e => {
  e.preventDefault();
  const d = {
    ragioneSociale:$("ragioneSocialeDitta").value.trim(),
    indirizzo:$("indirizzoDitta").value.trim(),
    piva:$("pivaDitta").value.trim(),
    codiceFiscale:$("cfDitta").value.trim(),
    telefono:$("telefonoDitta").value.trim(),
    email:$("emailDitta").value.trim(),
    pec:$("pecDitta").value.trim(),
    sito:$("sitoDitta").value.trim()
  };
  try {
    await db.collection("impostazioni").doc("ditta").set(d);
    datiDitta = d;
    mostraMessaggio("Dati aziendali salvati correttamente.");
  } catch (e) { erroreFirebase(e); }
});

/* =========================================================
   LISTINO
   ========================================================= */

function renderListino() {
  const box = $("listaListino");
  const elementi = ordinatiPerNome(listaLavorazioni,"descrizione");
  if (!elementi.length) {
    box.innerHTML = '<div class="empty-state">Nessuna lavorazione nel listino.</div>';
    return;
  }
  box.innerHTML = elementi.map(l => `
    <article class="record-card">
      <div class="record-main">
        <div class="record-title">${escapeHTML(l.descrizione)}</div>
        <div class="record-meta">${escapeHTML(l.categoria || "Senza categoria")} · Unità: ${escapeHTML(l.unita || "cad.")}</div>
        <div class="record-price">Manodopera: ${euro(l.prezzoManodopera)} · Materiali: ${euro(l.prezzoMateriali)}</div>
      </div>
      <div class="record-actions">
        <button class="btn btn-sm btn-outline-primary" data-listino-modifica="${escapeHTML(l.id)}">Modifica</button>
        <button class="btn btn-sm btn-outline-danger" data-listino-elimina="${escapeHTML(l.id)}">Elimina</button>
      </div>
    </article>`).join("");
}

$("formListino").addEventListener("submit", async e => {
  e.preventDefault();
  const id = $("listinoId").value;
  const d = {
    descrizione:$("descrizioneLavorazione").value.trim(),
    categoria:$("categoriaLavorazione").value.trim(),
    unita:$("unitaLavorazione").value.trim(),
    prezzoManodopera:Math.max(0,numero($("prezzoManodopera").value)),
    prezzoMateriali:Math.max(0,numero($("prezzoMateriali").value)),
    aggiornatoIl:new Date().toISOString()
  };
  if (!d.descrizione || !d.unita) {
    mostraMessaggio("Inserisci descrizione e unità di misura.","attenzione"); return;
  }
  try {
    if (id) await db.collection("listino").doc(id).update(d);
    else await db.collection("listino").add({...d,creatoIl:new Date().toISOString()});
    await caricaListino();
    renderListino();
    aggiornaRigheEsistenti();
    resetFormListino();
    mostraMessaggio("Lavorazione salvata.");
  } catch (e) { erroreFirebase(e); }
});

function resetFormListino() {
  $("formListino").reset();
  $("listinoId").value = "";
  $("unitaLavorazione").value = "cad.";
  $("prezzoManodopera").value = "0";
  $("prezzoMateriali").value = "0";
  $("titoloFormListino").textContent = "Nuova lavorazione";
  $("salvaLavorazione").textContent = "Salva lavorazione";
}

$("annullaModificaListino").addEventListener("click",resetFormListino);

$("listaListino").addEventListener("click",async e => {
  const m = e.target.closest("[data-listino-modifica]");
  const x = e.target.closest("[data-listino-elimina]");
  if (m) {
    const l = listaLavorazioni.find(a => a.id === m.dataset.listinoModifica);
    if (!l) return;
    $("listinoId").value = l.id;
    $("descrizioneLavorazione").value = l.descrizione || "";
    $("categoriaLavorazione").value = l.categoria || "";
    $("unitaLavorazione").value = l.unita || "cad.";
    $("prezzoManodopera").value = numero(l.prezzoManodopera);
    $("prezzoMateriali").value = numero(l.prezzoMateriali);
    $("titoloFormListino").textContent = "Modifica lavorazione";
    $("salvaLavorazione").textContent = "Aggiorna lavorazione";
    $("formListino").scrollIntoView({behavior:"smooth"});
  }
  if (x) {
    const l = listaLavorazioni.find(a => a.id === x.dataset.listinoElimina);
    if (!l || !confirm(`Eliminare "${l.descrizione}" dal listino?`)) return;
    try {
      await db.collection("listino").doc(l.id).delete();
      await caricaListino(); renderListino(); aggiornaRigheEsistenti();
      mostraMessaggio("Lavorazione eliminata dal listino.");
    } catch (e) { erroreFirebase(e); }
  }
});

/* =========================================================
   CLIENTI
   ========================================================= */

function renderClienti() {
  const box = $("listaClienti");
  const elementi = ordinatiPerNome(listaClienti,"nome");
  if (!elementi.length) {
    box.innerHTML = '<div class="empty-state">Nessun cliente registrato.</div>'; return;
  }
  box.innerHTML = elementi.map(c => `
    <article class="record-card">
      <div class="record-main">
        <div class="record-title">${escapeHTML(c.nome)}</div>
        <div class="record-meta">${escapeHTML(c.indirizzo || "")}
          ${c.telefono ? " · "+escapeHTML(c.telefono) : ""}
          ${c.email ? " · "+escapeHTML(c.email) : ""}</div>
      </div>
      <div class="record-actions">
        <button class="btn btn-sm btn-outline-primary" data-cliente-modifica="${escapeHTML(c.id)}">Modifica</button>
        <button class="btn btn-sm btn-outline-danger" data-cliente-elimina="${escapeHTML(c.id)}">Elimina</button>
      </div>
    </article>`).join("");
}

function aggiornaSelectClienti() {
  const s = $("clientePreventivo");
  const precedente = s.value;
  s.innerHTML = '<option value="">Seleziona cliente</option>' +
    ordinatiPerNome(listaClienti,"nome").map(c =>
      `<option value="${escapeHTML(c.id)}">${escapeHTML(c.nome)}</option>`
    ).join("");
  if (listaClienti.some(c => c.id === precedente)) s.value = precedente;
}

$("formCliente").addEventListener("submit",async e => {
  e.preventDefault();
  const id = $("clienteId").value;
  const d = {
    nome:$("nomeCliente").value.trim(),
    telefono:$("telefonoCliente").value.trim(),
    email:$("emailCliente").value.trim(),
    indirizzo:$("indirizzoCliente").value.trim(),
    aggiornatoIl:new Date().toISOString()
  };
  if (!d.nome) { mostraMessaggio("Inserisci il nome del cliente.","attenzione"); return; }
  try {
    if (id) await db.collection("clienti").doc(id).update(d);
    else await db.collection("clienti").add({...d,creatoIl:new Date().toISOString()});
    await caricaClienti(); renderClienti(); aggiornaSelectClienti();
    resetFormCliente();
    mostraMessaggio("Cliente salvato.");
  } catch (e) { erroreFirebase(e); }
});

function resetFormCliente() {
  $("formCliente").reset();
  $("clienteId").value = "";
  $("titoloFormCliente").textContent = "Nuovo cliente";
  $("salvaCliente").textContent = "Salva cliente";
}

$("annullaModificaCliente").addEventListener("click",resetFormCliente);

$("listaClienti").addEventListener("click",async e => {
  const m = e.target.closest("[data-cliente-modifica]");
  const x = e.target.closest("[data-cliente-elimina]");
  if (m) {
    const c = listaClienti.find(a => a.id === m.dataset.clienteModifica);
    if (!c) return;
    $("clienteId").value = c.id;
    $("nomeCliente").value = c.nome || "";
    $("telefonoCliente").value = c.telefono || "";
    $("emailCliente").value = c.email || "";
    $("indirizzoCliente").value = c.indirizzo || "";
    $("titoloFormCliente").textContent = "Modifica cliente";
    $("salvaCliente").textContent = "Aggiorna cliente";
    $("formCliente").scrollIntoView({behavior:"smooth"});
  }
  if (x) {
    const c = listaClienti.find(a => a.id === x.dataset.clienteElimina);
    if (!c || !confirm(`Eliminare il cliente "${c.nome}"?`)) return;
    try {
      await db.collection("clienti").doc(c.id).delete();
      await caricaClienti(); renderClienti(); aggiornaSelectClienti();
      mostraMessaggio("Cliente eliminato.");
    } catch (e) { erroreFirebase(e); }
  }
});

/* =========================================================
   RIGHE DEL PREVENTIVO
   ========================================================= */

function opzioniLavorazioni(id = "") {
  return '<option value="">Seleziona lavorazione</option>' +
    ordinatiPerNome(listaLavorazioni,"descrizione").map(l =>
      `<option value="${escapeHTML(l.id)}" ${l.id===id?"selected":""}>${escapeHTML(l.descrizione)}</option>`
    ).join("");
}

function aggiungiRigaPreventivo(d = {}) {
  const r = document.createElement("div");
  r.className = "quote-line";
  r.innerHTML = `
    <div class="quote-line-top">
      <span class="quote-line-title">Lavorazione</span>
      <button type="button" class="btn btn-sm btn-outline-danger" data-rimuovi-riga>Rimuovi</button>
    </div>
    <div class="quote-line-grid">
      <div class="field-description">
        <label class="form-label">Lavorazione da listino</label>
        <select class="form-select" data-field="lavorazioneId">${opzioniLavorazioni(d.lavorazioneId || "")}</select>
        <label class="form-label mt-2">Descrizione</label>
        <input class="form-control" data-field="descrizione" placeholder="Descrizione personalizzata" value="${escapeHTML(d.descrizione || "")}">
      </div>
      <div><label class="form-label">Quantità</label><input class="form-control" type="number" min="0.001" step="any" data-field="quantita" value="${d.quantita ?? 1}"></div>
      <div><label class="form-label">Manodopera / unità (€)</label><input class="form-control" type="number" min="0" step="0.01" data-field="prezzoManodopera" value="${numero(d.prezzoManodopera)}"></div>
      <div><label class="form-label">Materiali / unità (€)</label><input class="form-control" type="number" min="0" step="0.01" data-field="prezzoMateriali" value="${numero(d.prezzoMateriali)}"></div>
      <div><label class="form-label">Unità</label><input class="form-control" data-field="unita" value="${escapeHTML(d.unita || "cad.")}"></div>
      <div class="field-total"><label class="form-label">Totale riga</label><div class="line-total" data-line-total>€ 0,00</div></div>
    </div>`;
  $("righePreventivo").appendChild(r);
  aggiornaStatoListinoVuoto();
  calcolaTotali();
}

function aggiornaStatoListinoVuoto() {
  $("messaggioListinoVuoto").classList.toggle("d-none",listaLavorazioni.length > 0);
}

$("aggiungiRiga").addEventListener("click",() => aggiungiRigaPreventivo());

$("righePreventivo").addEventListener("change",e => {
  const r = e.target.closest(".quote-line");
  if (!r) return;
  if (e.target.matches('[data-field="lavorazioneId"]')) {
    const l = listaLavorazioni.find(a => a.id === e.target.value);
    if (l) {
      r.querySelector('[data-field="descrizione"]').value = l.descrizione || "";
      r.querySelector('[data-field="unita"]').value = l.unita || "cad.";
      r.querySelector('[data-field="prezzoManodopera"]').value = numero(l.prezzoManodopera);
      r.querySelector('[data-field="prezzoMateriali"]').value = numero(l.prezzoMateriali);
    }
  }
  calcolaTotali();
});

$("righePreventivo").addEventListener("input",e => {
  if (e.target.matches("input")) calcolaTotali();
});

$("righePreventivo").addEventListener("click",e => {
  const b = e.target.closest("[data-rimuovi-riga]");
  if (b) { b.closest(".quote-line").remove(); calcolaTotali(); }
});

function aggiornaRigheEsistenti() {
  document.querySelectorAll("#righePreventivo .quote-line").forEach(r => {
    const s = r.querySelector('[data-field="lavorazioneId"]');
    const valore = s.value;
    s.innerHTML = opzioniLavorazioni(valore);
  });
  aggiornaStatoListinoVuoto();
}

$("scontoPreventivo").addEventListener("input",calcolaTotali);
$("ivaPreventivo").addEventListener("input",calcolaTotali);

function leggiRighePreventivo() {
  return [...document.querySelectorAll("#righePreventivo .quote-line")].map(r => {
    const get = k => r.querySelector(`[data-field="${k}"]`)?.value ?? "";
    const id = get("lavorazioneId");
    const q = Math.max(0,numero(get("quantita")));
    const pm = Math.max(0,numero(get("prezzoManodopera")));
    const pp = Math.max(0,numero(get("prezzoMateriali")));
    const tm = q * pm;
    const tp = q * pp;
    return {
      lavorazioneId:id,
      descrizione:get("descrizione").trim(),
      categoria:listaLavorazioni.find(l => l.id === id)?.categoria || "",
      unita:get("unita").trim() || "cad.",
      quantita:q,
      prezzoManodopera:pm,
      prezzoMateriali:pp,
      totaleManodopera:tm,
      totaleMateriali:tp,
      totale:tm+tp
    };
  }).filter(r => r.descrizione || r.lavorazioneId);
}

function calcolaTotali() {
  const righe = leggiRighePreventivo();
  const tm = righe.reduce((s,r)=>s+r.totaleManodopera,0);
  const tp = righe.reduce((s,r)=>s+r.totaleMateriali,0);
  const lordo = tm + tp;
  const sconto = Math.min(Math.max(0,numero($("scontoPreventivo").value)),lordo);
  const imponibile = Math.max(0,lordo-sconto);
  const aliquota = Math.min(100,Math.max(0,numero($("ivaPreventivo").value)));
  const iva = imponibile * aliquota / 100;
  const totale = imponibile + iva;

  $("totaleManodopera").textContent = euro(tm);
  $("totaleMateriali").textContent = euro(tp);
  $("imponibileLordo").textContent = euro(lordo);
  $("riepilogoSconto").textContent = "− " + euro(sconto);
  $("imponibile").textContent = euro(imponibile);
  $("etichettaIva").textContent = `IVA (${aliquota}%)`;
  $("importoIva").textContent = euro(iva);
  $("totaleFinale").textContent = euro(totale);

  document.querySelectorAll("#righePreventivo .quote-line").forEach(r => {
    const q = Math.max(0,numero(r.querySelector('[data-field="quantita"]').value));
    const m = Math.max(0,numero(r.querySelector('[data-field="prezzoManodopera"]').value));
    const p = Math.max(0,numero(r.querySelector('[data-field="prezzoMateriali"]').value));
    r.querySelector("[data-line-total]").textContent = euro(q*(m+p));
  });

  return {righe,totaleManodopera:tm,totaleMateriali:tp,imponibileLordo:lordo,
    sconto,imponibile,percentualeIva:aliquota,importoIva:iva,totale};
}

/* =========================================================
   RESET E NUOVO PREVENTIVO
   ========================================================= */

function aggiornaNumeroVisibile(p = null) {
  $("numeroPreventivoVisibile").textContent = p
    ? (numeroEsistente(p) || "Numero non assegnato")
    : "Assegnato al salvataggio";
}

function resetFormPreventivo() {
  $("formPreventivo").reset();
  $("preventivoId").value = "";
  $("dataPreventivo").value = oggi();
  $("statoPreventivo").value = "Bozza";
  $("ivaPreventivo").value = "22";
  $("scontoPreventivo").value = "0";
  $("righePreventivo").innerHTML = "";
  aggiornaSelectClienti();
  aggiornaNumeroVisibile();
  $("salvaPreventivo").textContent = "Salva preventivo";
  aggiungiRigaPreventivo();
  calcolaTotali();
}

$("nuovoPreventivo").addEventListener("click",() => {
  resetFormPreventivo();
  mostraPagina("creaPreventivo");
  $("formPreventivo").scrollIntoView({behavior:"smooth"});
});

$("annullaPreventivo").addEventListener("click",resetFormPreventivo);

/* =========================================================
   SALVATAGGIO PREVENTIVO
   ========================================================= */

$("formPreventivo").addEventListener("submit",async e => {
  e.preventDefault();
  if (operazioneInCorso) return;

  const cliente = listaClienti.find(c => c.id === $("clientePreventivo").value);
  if (!cliente) { mostraMessaggio("Seleziona un cliente prima di salvare.","attenzione"); return; }

  const t = calcolaTotali();
  if (!t.righe.length) { mostraMessaggio("Aggiungi almeno una lavorazione.","attenzione"); return; }
  if (t.righe.some(r => !r.descrizione || r.quantita <= 0)) {
    mostraMessaggio("Controlla descrizioni e quantità delle lavorazioni.","attenzione"); return;
  }
  if (numero($("scontoPreventivo").value) > t.imponibileLordo) {
    mostraMessaggio("Lo sconto non può superare l'imponibile lordo.","attenzione"); return;
  }

  const id = $("preventivoId").value;
  const precedente = listaPreventivi.find(p => p.id === id);
  const dati = {
    titolo:$("titoloPreventivo").value.trim(),
    data:$("dataPreventivo").value,
    stato:$("statoPreventivo").value,
    note:$("notePreventivo").value.trim(),
    clienteId:cliente.id,
    clienteNome:cliente.nome || "",
    clienteTelefono:cliente.telefono || "",
    clienteEmail:cliente.email || "",
    clienteIndirizzo:cliente.indirizzo || "",
    righe:t.righe,
    totaleManodopera:t.totaleManodopera,
    totaleMateriali:t.totaleMateriali,
    imponibileLordo:t.imponibileLordo,
    sconto:t.sconto,
    imponibile:t.imponibile,
    percentualeIva:t.percentualeIva,
    importoIva:t.importoIva,
    totale:t.totale,
    datiDitta:{...datiDitta},
    aggiornatoIl:new Date().toISOString(),
    creatoIl:precedente?.creatoIl || new Date().toISOString()
  };

  impostaCaricamento(true);
  try {
    if (id) {
      /* Mantiene il numero già assegnato. Se un vecchio documento
         fosse ancora senza numero, ne assegna uno in modo atomico. */
      const ref = db.collection("preventivi").doc(id);
      const doc = await ref.get();
      const esistente = doc.exists ? doc.data() : {};
      const codice = esistente.numeroPreventivo || esistente.numero;

      if (codice) {
        await ref.update({...dati,numeroPreventivo:codice});
      } else {
        const anno = annoPreventivo(dati.data);
        const contatoreRef = db.collection("contatori").doc(`preventivi-${anno}`);
        await db.runTransaction(async tx => {
          const [counter, quote] = await Promise.all([tx.get(contatoreRef),tx.get(ref)]);
          if (!quote.exists) throw new Error("Preventivo non trovato.");
          const old = quote.data();
          const già = old.numeroPreventivo || old.numero;
          if (già) {
            tx.update(ref,{...dati,numeroPreventivo:già});
          } else {
            const next = numero(counter.exists ? counter.data().ultimoNumero : 0)+1;
            const code = formatoNumeroPreventivo(anno,next);
            tx.set(contatoreRef,{anno,ultimoNumero:next,aggiornatoIl:new Date().toISOString()},{merge:true});
            tx.update(ref,{...dati,numeroPreventivo:code});
          }
        });
      }
    } else {
      const nuovo = await creaPreventivoConNumero(dati);
      $("preventivoId").value = nuovo.id;
      aggiornaNumeroVisibile({numeroPreventivo:nuovo.numeroPreventivo});
    }

    await caricaPreventivi();
    renderPreventivi();
    const salvato = listaPreventivi.find(p => p.id === $("preventivoId").value);
    aggiornaNumeroVisibile(salvato);
    mostraMessaggio(`Preventivo ${numeroEsistente(salvato || {})} salvato correttamente.`);
    $("salvaPreventivo").textContent = "Aggiorna preventivo";
  } catch (e) {
    erroreFirebase(e);
  } finally {
    impostaCaricamento(false);
  }
});

/* =========================================================
   ARCHIVIO E RICERCA
   ========================================================= */

function renderPreventivi() {
  const box = $("listaPreventivi");
  const query = ($("ricercaPreventivi")?.value || "").trim().toLocaleLowerCase("it-IT");
  const qNumeri = query.replace(/\D/g,"");

  const risultati = listaPreventivi.filter(p => {
    const codice = numeroEsistente(p).toLocaleLowerCase("it-IT");
    const nome = String(p.clienteNome || "").toLocaleLowerCase("it-IT");
    const telefono = String(p.clienteTelefono || "").toLocaleLowerCase("it-IT");
    const titolo = String(p.titolo || "").toLocaleLowerCase("it-IT");
    const telefonoNumerico = telefono.replace(/\D/g,"");
    return !query || codice.includes(query) || nome.includes(query) ||
      titolo.includes(query) || telefono.includes(query) ||
      (qNumeri && telefonoNumerico.includes(qNumeri));
  });

  $("conteggioPreventivi").textContent =
    `${risultati.length} preventiv${risultati.length===1?"o":"i"} trovati`;

  if (!risultati.length) {
    box.innerHTML = '<div class="empty-state">Nessun preventivo trovato. Prova con un altro nome, numero o telefono.</div>';
    return;
  }

  box.innerHTML = risultati.map(p => `
    <article class="record-card">
      <div class="record-main">
        <div class="record-title">${escapeHTML(numeroEsistente(p) || "Senza numero")} — ${escapeHTML(p.titolo || "Preventivo senza titolo")}</div>
        <div class="record-meta">${escapeHTML(p.clienteNome || "Cliente non indicato")} · ${escapeHTML(p.clienteTelefono || "Telefono non indicato")} · ${escapeHTML(dataItaliana(p.data))} · <span class="status-pill">${escapeHTML(p.stato || "Bozza")}</span></div>
        <div class="record-price">${euro(p.totale)}</div>
      </div>
      <div class="record-actions">
        <button class="btn btn-sm btn-outline-primary" data-preventivo-dettaglio="${escapeHTML(p.id)}">Dettaglio</button>
        <button class="btn btn-sm btn-outline-primary" data-preventivo-modifica="${escapeHTML(p.id)}">Modifica</button>
        <button class="btn btn-sm btn-outline-secondary" data-preventivo-stampa="${escapeHTML(p.id)}">PDF / Stampa</button>
        <button class="btn btn-sm btn-outline-secondary" data-preventivo-email="${escapeHTML(p.id)}">Email</button>
        <button class="btn btn-sm btn-outline-danger" data-preventivo-elimina="${escapeHTML(p.id)}">Elimina</button>
      </div>
    </article>`).join("");
}

$("ricercaPreventivi").addEventListener("input",renderPreventivi);
$("pulisciRicercaPreventivi").addEventListener("click",() => {
  $("ricercaPreventivi").value = "";
  renderPreventivi();
});

$("aggiornaPreventivi").addEventListener("click",async () => {
  try {
    await caricaPreventivi();
    await migraNumeriStorici();
    renderPreventivi();
    mostraMessaggio("Archivio aggiornato.");
  } catch (e) { erroreFirebase(e); }
});

$("listaPreventivi").addEventListener("click",async e => {
  const dettaglio = e.target.closest("[data-preventivo-dettaglio]");
  const modifica = e.target.closest("[data-preventivo-modifica]");
  const stampa = e.target.closest("[data-preventivo-stampa]");
  const email = e.target.closest("[data-preventivo-email]");
  const elimina = e.target.closest("[data-preventivo-elimina]");

  if (dettaglio) {
    const p = listaPreventivi.find(a => a.id === dettaglio.dataset.preventivoDettaglio);
    if (p) mostraDettaglioPreventivo(p);
  }
  if (modifica) {
    const p = listaPreventivi.find(a => a.id === modifica.dataset.preventivoModifica);
    if (p) caricaPreventivoNelForm(p);
  }
  if (stampa) {
    const p = listaPreventivi.find(a => a.id === stampa.dataset.preventivoStampa);
    if (p) stampaPreventivo(p);
  }
  if (email) {
    const p = listaPreventivi.find(a => a.id === email.dataset.preventivoEmail);
    if (p) preparaEmailPreventivo(p);
  }
  if (elimina) {
    const p = listaPreventivi.find(a => a.id === elimina.dataset.preventivoElimina);
    if (!p || !confirm(`Eliminare il preventivo ${numeroEsistente(p)} - "${p.titolo}"?`)) return;
    try {
      await db.collection("preventivi").doc(p.id).delete();
      await caricaPreventivi();
      renderPreventivi();
      mostraMessaggio("Preventivo eliminato. Il suo numero non verrà riutilizzato.");
    } catch (e) { erroreFirebase(e); }
  }
});

function caricaPreventivoNelForm(p) {
  $("preventivoId").value = p.id;
  $("titoloPreventivo").value = p.titolo || "";
  $("dataPreventivo").value = p.data || oggi();
  $("statoPreventivo").value = p.stato || "Bozza";
  $("notePreventivo").value = p.note || "";
  $("ivaPreventivo").value = numero(p.percentualeIva ?? 22);
  $("scontoPreventivo").value = numero(p.sconto);
  aggiornaSelectClienti();
  $("clientePreventivo").value = p.clienteId || "";
  $("righePreventivo").innerHTML = "";
  (p.righe || []).forEach(r => aggiungiRigaPreventivo(r));
  if (!(p.righe || []).length) aggiungiRigaPreventivo();
  $("salvaPreventivo").textContent = "Aggiorna preventivo";
  aggiornaNumeroVisibile(p);
  mostraPagina("creaPreventivo");
  calcolaTotali();
  $("formPreventivo").scrollIntoView({behavior:"smooth"});
}

/* =========================================================
   DETTAGLIO PREVENTIVO
   ========================================================= */

function mostraDettaglioPreventivo(p) {
  $("titoloDettaglio").textContent = `${numeroEsistente(p)} - ${p.titolo || "Dettaglio preventivo"}`;
  $("contenutoDettaglio").innerHTML = `
    ${htmlIntestazioneDitta(p.datiDitta || datiDitta)}
    <h4 class="mt-4">Preventivo ${escapeHTML(numeroEsistente(p))}: ${escapeHTML(p.titolo || "")}</h4>
    <p><strong>Data:</strong> ${escapeHTML(dataItaliana(p.data))}</p>
    <p><strong>Cliente:</strong> ${escapeHTML(p.clienteNome || "")}</p>
    <p><strong>Indirizzo:</strong> ${escapeHTML(p.clienteIndirizzo || "")}</p>
    <p><strong>Telefono:</strong> ${escapeHTML(p.clienteTelefono || "")}</p>
    <p><strong>Email:</strong> ${escapeHTML(p.clienteEmail || "")}</p>
    ${htmlTabellaRighe(p.righe || [])}
    ${htmlRiepilogo(p)}
    <p><strong>Stato:</strong> ${escapeHTML(p.stato || "Bozza")}</p>
    <p><strong>Note:</strong><br>${escapeHTML(p.note || "").replace(/\n/g,"<br>")}</p>
    <div class="no-print mt-3">
      <button type="button" class="btn btn-primary" id="stampaDaDettaglio">Stampa / PDF</button>
      <button type="button" class="btn btn-outline-primary" id="emailDaDettaglio">Prepara email</button>
    </div>`;

  modalDettaglio = modalDettaglio || new bootstrap.Modal($("modalDettaglio"));
  modalDettaglio.show();
  $("stampaDaDettaglio").addEventListener("click",() => stampaPreventivo(p));
  $("emailDaDettaglio").addEventListener("click",() => preparaEmailPreventivo(p));
}

function htmlIntestazioneDitta(d) {
  return `<div class="quote-company">
    <h2>${escapeHTML(d.ragioneSociale || "EDIL SALVATORE")}</h2>
    <div>${escapeHTML(d.indirizzo || "")}</div>
    <div>P. IVA: ${escapeHTML(d.piva || "")} · C.F.: ${escapeHTML(d.codiceFiscale || "")}</div>
    <div>Tel. ${escapeHTML(d.telefono || "")} · ${escapeHTML(d.email || "")}</div>
    <div>PEC: ${escapeHTML(d.pec || "")}</div>
    ${d.sito ? `<div>${escapeHTML(d.sito)}</div>` : ""}
  </div>`;
}

function htmlTabellaRighe(righe) {
  return `<div class="table-responsive"><table class="detail-table">
    <thead><tr><th>Lavorazione</th><th>Q.tà</th><th>Unità</th><th>Manodopera/unità</th><th>Materiali/unità</th><th>Totale</th></tr></thead>
    <tbody>${righe.map(r => `<tr>
      <td>${escapeHTML(r.descrizione || "")}</td><td>${numero(r.quantita)}</td>
      <td>${escapeHTML(r.unita || "")}</td><td>${euro(r.prezzoManodopera)}</td>
      <td>${euro(r.prezzoMateriali)}</td><td>${euro(r.totale ?? (numero(r.totaleManodopera)+numero(r.totaleMateriali)))}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

function htmlRiepilogo(p) {
  const lordo = numero(p.imponibileLordo ?? (numero(p.totaleManodopera)+numero(p.totaleMateriali)));
  const sconto = numero(p.sconto);
  const imponibile = numero(p.imponibile ?? lordo-sconto);
  const iva = numero(p.importoIva);
  const aliquota = numero(p.percentualeIva);
  return `<div class="detail-summary">
    <div class="total-row"><span>Manodopera</span><strong>${euro(p.totaleManodopera)}</strong></div>
    <div class="total-row"><span>Materiali</span><strong>${euro(p.totaleMateriali)}</strong></div>
    <div class="total-row"><span>Imponibile lordo</span><strong>${euro(lordo)}</strong></div>
    <div class="total-row"><span>Sconto</span><strong>− ${euro(sconto)}</strong></div>
    <div class="total-row"><span>Imponibile</span><strong>${euro(imponibile)}</strong></div>
    <div class="total-row"><span>IVA (${aliquota}%)</span><strong>${euro(iva)}</strong></div>
    <div class="total-row grand-total"><span>TOTALE</span><strong>${euro(p.totale)}</strong></div>
  </div>`;
}

/* =========================================================
   STAMPA E SALVATAGGIO PDF
   ========================================================= */

function creaHTMLStampa(p) {
  const d = p.datiDitta || datiDitta;
  const lordo = numero(p.imponibileLordo ?? (numero(p.totaleManodopera)+numero(p.totaleMateriali)));
  const imponibile = numero(p.imponibile ?? lordo-numero(p.sconto));

  return `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
  <title>${escapeHTML(numeroEsistente(p))} - ${escapeHTML(p.titolo || "Preventivo")}</title>
  <style>
  body{font-family:Arial,sans-serif;color:#263548;margin:30px;font-size:12px}
  h1,h2,h3{color:#244b73}h1{font-size:24px;margin-bottom:5px}h2{font-size:18px;margin-top:24px}
  .azienda{border-bottom:3px solid #244b73;padding-bottom:15px}
  .meta{margin:18px 0;line-height:1.8}
  table{width:100%;border-collapse:collapse;margin:20px 0}
  th,td{border-bottom:1px solid #ddd;padding:8px 5px;text-align:left}
  th{background:#edf3f9}.num{text-align:right;white-space:nowrap}
  .totali{width:340px;max-width:100%;margin-left:auto}
  .riga{display:flex;justify-content:space-between;gap:20px;padding:7px 0;border-bottom:1px solid #eee}
  .finale{font-size:17px;font-weight:bold;color:#244b73}
  .note{margin-top:25px;white-space:pre-wrap}
  .firma{margin-top:45px;display:flex;justify-content:space-between;gap:30px}
  .firma div{width:42%;border-top:1px solid #777;padding-top:8px}
  @media print{body{margin:12mm}}
  </style></head><body>
  <header class="azienda"><h1>${escapeHTML(d.ragioneSociale || "EDIL SALVATORE")}</h1>
  <div>${escapeHTML(d.indirizzo || "")}</div>
  <div>P. IVA: ${escapeHTML(d.piva || "")} · C.F.: ${escapeHTML(d.codiceFiscale || "")}</div>
  <div>Telefono: ${escapeHTML(d.telefono || "")} · Email: ${escapeHTML(d.email || "")}</div>
  <div>PEC: ${escapeHTML(d.pec || "")} ${d.sito ? " · "+escapeHTML(d.sito) : ""}</div></header>
  <h2>PREVENTIVO ${escapeHTML(numeroEsistente(p))}</h2>
  <div class="meta"><strong>Oggetto:</strong> ${escapeHTML(p.titolo || "")}<br>
  <strong>Numero:</strong> ${escapeHTML(numeroEsistente(p))}<br>
  <strong>Data:</strong> ${escapeHTML(dataItaliana(p.data))}<br>
  <strong>Cliente:</strong> ${escapeHTML(p.clienteNome || "")}<br>
  <strong>Indirizzo:</strong> ${escapeHTML(p.clienteIndirizzo || "")}<br>
  <strong>Telefono:</strong> ${escapeHTML(p.clienteTelefono || "")}<br>
  <strong>Email:</strong> ${escapeHTML(p.clienteEmail || "")}</div>
  <table><thead><tr><th>Lavorazione</th><th>Q.tà</th><th>Unità</th>
  <th class="num">Manodopera/unità</th><th class="num">Materiali/unità</th><th class="num">Totale</th></tr></thead>
  <tbody>${(p.righe || []).map(r => `<tr>
  <td>${escapeHTML(r.descrizione || "")}</td><td>${numero(r.quantita)}</td>
  <td>${escapeHTML(r.unita || "")}</td><td class="num">${euro(r.prezzoManodopera)}</td>
  <td class="num">${euro(r.prezzoMateriali)}</td><td class="num">${euro(r.totale ?? (numero(r.totaleManodopera)+numero(r.totaleMateriali)))}</td>
  </tr>`).join("")}</tbody></table>
  <div class="totali">
  <div class="riga"><span>Manodopera</span><strong>${euro(p.totaleManodopera)}</strong></div>
  <div class="riga"><span>Materiali</span><strong>${euro(p.totaleMateriali)}</strong></div>
  <div class="riga"><span>Imponibile lordo</span><strong>${euro(lordo)}</strong></div>
  <div class="riga"><span>Sconto</span><strong>− ${euro(p.sconto)}</strong></div>
  <div class="riga"><span>Imponibile</span><strong>${euro(imponibile)}</strong></div>
  <div class="riga"><span>IVA (${numero(p.percentualeIva)}%)</span><strong>${euro(p.importoIva)}</strong></div>
  <div class="riga finale"><span>TOTALE</span><strong>${euro(p.totale)}</strong></div></div>
  <div class="note"><strong>Note e condizioni</strong><br>${escapeHTML(p.note || "Nessuna nota inserita.")}</div>
  <div class="firma"><div>Firma del cliente per accettazione</div><div>Firma dell'impresa</div></div>
  <p style="margin-top:35px">Stato preventivo: ${escapeHTML(p.stato || "Bozza")}</p>
  <script>window.onload=function(){window.focus();window.print();};<\/script>
  </body></html>`;
}

function raccogliPreventivoDalForm() {
  const c = listaClienti.find(a => a.id === $("clientePreventivo").value);
  const t = calcolaTotali();
  return {
    id:$("preventivoId").value || "",
    numeroPreventivo:listaPreventivi.find(p=>p.id===$("preventivoId").value)?.numeroPreventivo || "",
    titolo:$("titoloPreventivo").value.trim(),
    data:$("dataPreventivo").value,
    stato:$("statoPreventivo").value,
    note:$("notePreventivo").value.trim(),
    clienteId:c?.id || "",
    clienteNome:c?.nome || "",
    clienteTelefono:c?.telefono || "",
    clienteEmail:c?.email || "",
    clienteIndirizzo:c?.indirizzo || "",
    righe:t.righe,
    totaleManodopera:t.totaleManodopera,
    totaleMateriali:t.totaleMateriali,
    imponibileLordo:t.imponibileLordo,
    sconto:t.sconto,
    imponibile:t.imponibile,
    percentualeIva:t.percentualeIva,
    importoIva:t.importoIva,
    totale:t.totale,
    datiDitta:{...datiDitta}
  };
}

function stampaPreventivo(p) {
  if (!p || !(p.righe || []).length) {
    mostraMessaggio("Il preventivo non contiene lavorazioni da stampare.","attenzione"); return;
  }
  const w = window.open("","_blank");
  if (!w) {
    mostraMessaggio("Popup bloccato: consenti le finestre di stampa per CodePen.","attenzione"); return;
  }
  w.document.open();
  w.document.write(creaHTMLStampa(p));
  w.document.close();
}

$("stampaPreventivoCorrente").addEventListener("click",() => {
  const p = raccogliPreventivoDalForm();
  if (!p.titolo || !p.clienteId || !p.righe.length) {
    mostraMessaggio("Inserisci titolo, cliente e almeno una lavorazione prima di stampare.","attenzione"); return;
  }
  stampaPreventivo(p);
});

/* =========================================================
   EMAIL
   ========================================================= */

function preparaEmailPreventivo(p) {
  if (!p || !(p.righe || []).length) {
    mostraMessaggio("Il preventivo non contiene lavorazioni.","attenzione"); return;
  }
  const oggetto = `Preventivo ${numeroEsistente(p)} - ${p.titolo || "EDIL SALVATORE"}`;
  const corpo = [
    `Gentile ${p.clienteNome || "Cliente"},`,
    "",
    "in allegato troverà il preventivo.",
    `Numero preventivo: ${numeroEsistente(p)}`,
    `Oggetto: ${p.titolo || ""}`,
    `Data: ${dataItaliana(p.data)}`,
    "",
    ...(p.righe || []).map(r => `- ${r.descrizione}: ${r.quantita} ${r.unita}, totale ${euro(r.totale)}`),
    "",
    `Manodopera: ${euro(p.totaleManodopera)}`,
    `Materiali: ${euro(p.totaleMateriali)}`,
    `Imponibile lordo: ${euro(p.imponibileLordo ?? (numero(p.totaleManodopera)+numero(p.totaleMateriali)))}`,
    `Sconto: ${euro(p.sconto)}`,
    `Imponibile: ${euro(p.imponibile)}`,
    `IVA (${numero(p.percentualeIva)}%): ${euro(p.importoIva)}`,
    `TOTALE: ${euro(p.totale)}`,
    "",
    "Cordiali saluti,",
    p.datiDitta?.ragioneSociale || datiDitta.ragioneSociale,
    p.datiDitta?.telefono || datiDitta.telefono,
    p.datiDitta?.email || datiDitta.email
  ].join("\n");

  window.location.href = `mailto:${encodeURIComponent(p.clienteEmail || "")}?subject=${encodeURIComponent(oggetto)}&body=${encodeURIComponent(corpo)}`;
}

$("emailPreventivoCorrente").addEventListener("click",() => {
  const p = raccogliPreventivoDalForm();
  if (!p.titolo || !p.clienteId || !p.righe.length) {
    mostraMessaggio("Inserisci titolo, cliente e almeno una lavorazione.","attenzione"); return;
  }
  preparaEmailPreventivo(p);
});

/* =========================================================
   AGGIORNAMENTO MANUALE
   ========================================================= */

window.aggiornaDatiEdilPreventivi = async function() {
  try {
    await Promise.all([caricaListino(),caricaClienti(),caricaPreventivi()]);
    await migraNumeriStorici();
    aggiornaSelectClienti();
    renderListino();
    renderClienti();
    renderPreventivi();
    aggiornaRigheEsistenti();
    calcolaTotali();
    mostraMessaggio("Dati aggiornati.");
  } catch (e) { erroreFirebase(e); }
};
