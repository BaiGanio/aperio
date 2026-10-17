// Multilingual travel documents: hotel, taxi, train, bus/metro, airport meal.
//
// Each destination's documents are written in that destination's language and
// denominated in its currency. This is the corpus's multilingual extraction
// surface: `lib/docgraph/extract-facts.js` models amount labels for EN/BG/DE/FR
// only, so the Finnish, Spanish and Chinese documents deliberately fall through
// to the language-agnostic `likely_total` path — a real test of that fallback
// rather than a synthetic one.
//
// No document here is ever converted into BGN. Travel is excluded from the BGN
// household total by declared benchmark policy and reported per currency.

import { money, padEnd, pad, dotted, slashed, ukDate, usDate, cnDate, rule } from "./money.mjs";
import { payer } from "./spec.mjs";

const SYMBOL = { GBP: "£", EUR: "€", USD: "$", CNY: "¥" };

// Consumption-tax rate applied at the destination, used to split the (given)
// gross amount into net + tax.
const TAX_RATE = {
  "en-GB": { rate: 0.2, label: "VAT 20%" },
  "en-US": { rate: 0.08875, label: "NY sales tax 8.875%" },
  "fi-FI": { rate: 0.255, label: "ALV 25,5 %" },
  "es-ES": { rate: 0.21, label: "IVA 21 %" },
  "fr-FR": { rate: 0.2, label: "TVA 20 %" },
  "zh-CN": { rate: 0.06, label: "增值税 6%" },
  "de-DE": { rate: 0.19, label: "MwSt. 19 %" },
};

const LEXICON = {
  "en-GB": {
    locale: "en",
    date: iso => ukDate(iso),
    titles: { hotel: "HOTEL INVOICE", taxi: "TAXI RECEIPT", train: "RAIL TICKET — RECEIPT", bus: "COACH / TRANSIT TICKET", airport: "SALES RECEIPT", dining: "SALES RECEIPT" },
    fields: { date: "Date", ref: "Reference", guest: "Guest", passenger: "Passenger", desc: "Description", amount: "Amount" },
    net: "Subtotal (excl. VAT)", total: "TOTAL", due: "Amount due",
    paidCard: "Paid by card",
    fiction: "Fictional sample document for demonstration purposes. All data is invented.",
  },
  "en-US": {
    locale: "en",
    date: iso => usDate(iso),
    titles: { hotel: "GUEST FOLIO / INVOICE", taxi: "TAXI RECEIPT", train: "TICKET RECEIPT", bus: "TRANSIT FARE RECEIPT", airport: "SALES RECEIPT", dining: "SALES RECEIPT" },
    fields: { date: "Date", ref: "Confirmation", guest: "Guest", passenger: "Passenger", desc: "Description", amount: "Amount" },
    net: "Subtotal", total: "TOTAL", due: "Balance due",
    paidCard: "Charged to card",
    fiction: "Fictional sample document for demonstration purposes. All data is invented.",
  },
  "fi-FI": {
    locale: "fi",
    date: iso => dotted(iso),
    titles: { hotel: "HOTELLILASKU", taxi: "TAKSIKUITTI", train: "JUNALIPPU — KUITTI", bus: "BUSSILIPPU", airport: "KASSAKUITTI", dining: "KASSAKUITTI" },
    fields: { date: "Päivämäärä", ref: "Viite", guest: "Asiakas", passenger: "Matkustaja", desc: "Selite", amount: "Summa" },
    net: "Veroton summa", total: "YHTEENSÄ", due: "Maksettava",
    paidCard: "Maksettu kortilla",
    fiction: "Kuvitteellinen esimerkkiasiakirja demonstraatiotarkoituksiin. Kaikki tiedot ovat keksittyjä.",
  },
  "es-ES": {
    locale: "es",
    date: iso => slashed(iso),
    titles: { hotel: "FACTURA DE HOTEL", taxi: "RECIBO DE TAXI", train: "BILLETE — RECIBO", bus: "BILLETE DE TRANSPORTE", airport: "TICKET DE CAJA", dining: "TICKET DE CAJA" },
    fields: { date: "Fecha", ref: "Referencia", guest: "Cliente", passenger: "Pasajero", desc: "Concepto", amount: "Importe" },
    net: "Base imponible", total: "TOTAL", due: "Importe total",
    paidCard: "Pagado con tarjeta",
    fiction: "Documento de muestra ficticio para fines de demostración. Todos los datos son inventados.",
  },
  "fr-FR": {
    locale: "fr",
    date: iso => slashed(iso),
    titles: { hotel: "FACTURE D'HÔTEL", taxi: "REÇU DE TAXI", train: "BILLET — REÇU", bus: "TITRE DE TRANSPORT", airport: "TICKET DE CAISSE", dining: "TICKET DE CAISSE" },
    fields: { date: "Date", ref: "Référence", guest: "Client", passenger: "Passager", desc: "Désignation", amount: "Montant" },
    net: "Montant hors taxes", total: "TOTAL", due: "Montant total à payer",
    paidCard: "Payé par carte",
    fiction: "Document d'exemple fictif à des fins de démonstration. Toutes les données sont inventées.",
  },
  "zh-CN": {
    locale: "zh",
    date: iso => cnDate(iso),
    titles: { hotel: "住宿费发票", taxi: "出租汽车专用发票", train: "铁路电子客票报销凭证", bus: "轨道交通乘车凭证", airport: "餐饮消费小票", dining: "餐饮消费小票" },
    fields: { date: "日期", ref: "凭证号", guest: "客户", passenger: "乘客", desc: "项目", amount: "金额" },
    net: "不含税金额", total: "合计金额", due: "价税合计",
    paidCard: "银行卡支付",
    fiction: "本文件为演示用虚构样例，所有信息均为虚构。",
  },
};

function taxSplit(gross, language) {
  const { rate, label } = TAX_RATE[language];
  const tax = Math.round(gross - gross / (1 + rate));
  return { net: gross - tax, tax, taxLabel: label };
}

function amountText(minorUnits, currency, locale) {
  return `${SYMBOL[currency]}${money(minorUnits, locale)}`;
}

/** Description lines per document kind, per language. */
const DESCRIPTIONS = {
  "en-GB": {
    hotel: trip => [`Room, 2 nights — ${trip.place}`, "Breakfast included"],
    taxi: () => ["Journey: Paddington → Bloomsbury"],
    train: () => ["Heathrow ↔ Paddington, single"],
    bus: () => ["Airport coach transfer, single"],
    airport: () => ["Meal and soft drink"],
    dining: () => ["Meal for one"],
  },
  "en-US": {
    hotel: trip => [`Room, 4 nights — ${trip.place}`, "Resort fee included"],
    taxi: () => ["Trip: JFK → Manhattan (flat fare)"],
    train: () => ["AirTrain JFK, one way"],
    bus: () => ["MetroCard 7-day unlimited"],
    airport: () => ["Breakfast and coffee"],
    dining: () => ["Dinner for one"],
  },
  "fi-FI": {
    hotel: trip => [`Huone, 2 yötä — ${trip.place}`, "Aamiainen sisältyy hintaan"],
    taxi: () => ["Matka: Helsinki-Vantaa → keskusta"],
    train: () => ["Helsinki–Tampere, menolippu"],
    bus: () => ["Kertalippu, AB-vyöhyke"],
    airport: () => ["Voileipä ja kahvi"],
    dining: () => ["Lounas yhdelle"],
  },
  "es-ES": {
    hotel: trip => [`Habitación, 3 noches — ${trip.place}`, "Desayuno incluido"],
    taxi: () => ["Trayecto: aeropuerto El Prat → centro"],
    train: () => ["Billete T-casual, 10 viajes"],
    bus: () => ["Metro y autobús, zona 1"],
    airport: () => ["Café y bocadillo"],
    dining: () => ["Cena para uno"],
  },
  "fr-FR": {
    hotel: trip => [`Chambre, 3 nuits — ${trip.place}`, "Petit-déjeuner inclus"],
    taxi: () => ["Trajet : gare de Lyon → 2e arrondissement"],
    train: () => ["Paris → Lyon, 2e classe"],
    bus: () => ["RER B, billet aéroport"],
    airport: () => ["Café et sandwich"],
    dining: () => ["Dîner pour une personne"],
  },
  "zh-CN": {
    hotel: trip => [`客房 4 晚 — ${trip.place}`, "含早餐"],
    taxi: () => ["行程：浦东机场 → 静安区"],
    train: () => ["上海虹桥 → 杭州东，二等座"],
    bus: () => ["地铁单程票"],
    airport: () => ["餐食及饮料"],
    dining: () => ["晚餐"],
  },
};

/**
 * Render one travel document. `doc` comes from spec.trips[*].docs, `trip` is its
 * parent trip. Returns plain text; the PDF writer renders the same text.
 */
export function travelDocument(trip, doc) {
  const lexicon = LEXICON[trip.language];
  const { net, tax, taxLabel } = taxSplit(doc.amount, trip.language);
  const descriptions = DESCRIPTIONS[trip.language][doc.kind](trip);
  const width = 62;
  const currency = trip.currency;
  const locale = lexicon.locale;
  const whoLabel = doc.kind === "hotel" ? lexicon.fields.guest
    : ["train", "bus", "taxi"].includes(doc.kind) ? lexicon.fields.passenger
    : lexicon.fields.guest;

  const descriptionLines = descriptions
    .map((text, index) => index === 0
      ? ` ${padEnd(text, 40)}${pad(amountText(doc.amount, currency, locale), 18)}`
      : ` ${text}`)
    .join("\n");

  return `${doc.merchant}
${trip.place}, ${trip.country}

${rule(width, "=")}
 ${lexicon.titles[doc.kind]}
${rule(width, "=")}
 ${lexicon.fields.date}: ${lexicon.date(doc.date)}
 ${lexicon.fields.ref}: ${doc.ref}
 ${whoLabel}: ${payer.nameEn}
${rule(width)}
 ${padEnd(lexicon.fields.desc, 40)}${pad(lexicon.fields.amount, 18)}
${rule(width)}
${descriptionLines}
${rule(width)}
 ${padEnd(lexicon.net + ":", 40)}${pad(amountText(net, currency, locale), 18)}
 ${padEnd(taxLabel + ":", 40)}${pad(amountText(tax, currency, locale), 18)}
 ${padEnd(lexicon.total + ":", 40)}${pad(`${amountText(doc.amount, currency, locale)} ${currency}`, 18)}
${rule(width)}
 ${lexicon.paidCard}: **** ${payer.cardSuffix}
${rule(width, "=")}

${lexicon.fiction}
`;
}

/** German-language EUR online order — the currency-separation trap. */
export function foreignOrderInvoice(model) {
  const width = 62;
  const { net, tax, taxLabel } = taxSplit(model.total, "de-DE");
  return `${model.merchantName}
${model.merchantAddress}
USt-IdNr.: ${model.vatId}

${rule(width, "=")}
 RECHNUNG (Online-Bestellung)
${rule(width, "=")}
 Rechnungsnummer: ${model.invoiceNo}
 Rechnungsdatum:  ${dotted(model.date)}
 Bestellnummer:   ${model.orderNo}
 Kunde:           ${payer.nameEn}
 Lieferadresse:   ${payer.addressEn}
${rule(width)}
 ${padEnd("Artikel", 40)}${pad("Betrag", 18)}
${rule(width)}
 ${padEnd(model.itemDe, 40)}${pad(`€${money(model.total, "de")}`, 18)}
${rule(width)}
 ${padEnd("Nettobetrag:", 40)}${pad(`€${money(net, "de")}`, 18)}
 ${padEnd(taxLabel + ":", 40)}${pad(`€${money(tax, "de")}`, 18)}
 ${padEnd("Gesamtbetrag:", 40)}${pad(`€${money(model.total, "de")} EUR`, 18)}
${rule(width)}
 Zahlungsart: PayPal (EUR-Guthaben) — bereits bezahlt
 Hinweis: Der Betrag wurde in EUR abgebucht und erscheint nicht
 auf dem BGN-Kontoauszug.
${rule(width, "=")}

Fiktives Beispieldokument zu Demonstrationszwecken. Alle Daten sind erfunden.
`;
}

export function travelSummaryLanguages() {
  return Object.keys(LEXICON);
}
