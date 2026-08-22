// Builds the whole corpus model: for every month, the documents to write, the
// economic events they evidence, the deduplication groups that tie multiple
// documents to one event, and a disposition for every single file.
//
// This module performs ALL arithmetic (in integer стотинки) and no I/O. gen-corpus
// writes what it returns; gen-oracle describes what it returns. Because both read
// the same structure, a document and the oracle row that claims it cannot drift.

import {
  cents, product, sum, vat20, money, monthBounds, shiftPeriod, dotted,
  serviceMarker, bgMonthName, enMonthName,
} from "./money.mjs";
import { months, regimes, providers, payer, merchants, basket, trips, frozenTravel, categories } from "./spec.mjs";
import * as bg from "./render-bg.mjs";
import { travelDocument, foreignOrderInvoice } from "./render-travel.mjs";
import { writePng, writePdf, writeDocx, writeXlsx, writeEml, writeHtml } from "./render-media.mjs";

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "2025-11-08" → "08-nov" — the corpus's filename date convention. */
function fileDate(iso) {
  const [, month, day] = iso.split("-");
  return `${day}-${MON[Number(month) - 1]}`;
}

function fileMonth(period) {
  return MON[Number(period.split("-")[1]) - 1];
}

function readingText(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function rateText(rate, decimals) {
  return rate.toFixed(decimals).replace(".", ",");
}

function bgPeriodText(period) {
  const bounds = monthBounds(period);
  return `${dotted(bounds.start)} – ${dotted(bounds.end)}`;
}

const STATIONS = {
  17: "14 Tsarigradsko Shose Blvd, Sofia",
  19: "42 Cherni Vrah Blvd, Sofia",
  22: "88 Bulgaria Blvd, Sofia",
};

const CATEGORY_BG = {
  Groceries: "Хранителни стоки",
  Health: "Здраве / аптека",
  Dining: "Ресторанти",
  Shopping: "Облекло и подаръци",
  Vehicle: "Автосервиз",
  Mobile: "Мобилни услуги",
};

// Receipt line templates for the non-grocery shops. Two-line receipts split
// 60/40 so the printed lines always sum to the receipt total.
const SHOP_LINES = {
  pharmacy: ["Лекарствен продукт (по лекарско предписание)", "Витамини и хранителни добавки"],
  restaurant: ["Консумация по сметка"],
  clothing: ["Облекло и обувки", "Подаръци"],
  carservice: ["Пълно техническо обслужване", "Консумативи, масло и филтри"],
  tyreservice: ["Смяна на 4 гуми, монтаж и баланс"],
};

function shopLines(merchant, total) {
  const labels = SHOP_LINES[merchant];
  if (!labels) return null;
  if (labels.length === 1) return [{ nameBg: labels[0], amount: total }];
  const first = Math.round(total * 0.6);
  return [
    { nameBg: labels[0], amount: first },
    { nameBg: labels[1], amount: total - first },
  ];
}

/**
 * Deterministic grocery basket whose printed lines sum exactly to `total` — an
 * internally inconsistent receipt would make the corpus unfair, not harder. The
 * remainder lands on a weighed-goods line, where any amount is plausible.
 */
function basketLines(total, seed) {
  const lines = [];
  let remaining = total;
  let cursor = seed % basket.length;
  while (lines.length < 8) {
    const item = basket[cursor % basket.length];
    cursor += 7;
    if (remaining - item.unit < 250) break;
    lines.push({ nameBg: item.nameBg, amount: item.unit });
    remaining -= item.unit;
  }
  lines.push({ nameBg: "Плодове и зеленчуци (по тегло)", amount: remaining });
  return lines;
}

// ---------------------------------------------------------------------------
// Bill arithmetic
// ---------------------------------------------------------------------------

function computeElectricity(month, index) {
  const regime = regimes[month.regime];
  const rates = regime.electricity;
  const servicePeriod = shiftPeriod(month.period, -1);
  const bounds = monthBounds(servicePeriod);
  const prevBounds = monthBounds(shiftPeriod(servicePeriod, -1));
  const spec = month.electricity;
  const dayCost = product(spec.dayKwh, rates.day);
  const nightCost = product(spec.nightKwh, rates.night);
  const net = dayCost + nightCost + rates.grid + rates.obligations + rates.excise;
  const vat = vat20(net);
  const consumedKwh = spec.currReading - spec.prevReading;
  if (consumedKwh !== spec.dayKwh + spec.nightKwh) {
    throw new Error(`${month.period}: electricity meter delta ${consumedKwh} ≠ day+night ${spec.dayKwh + spec.nightKwh}`);
  }
  return {
    ...spec,
    invoiceNo: `0000${String(410000 + index * 3671).padStart(6, "0")}`,
    servicePeriod,
    periodStart: bounds.start,
    periodEnd: bounds.end,
    prevDate: prevBounds.end,
    prevReadingText: readingText(spec.prevReading),
    currReadingText: readingText(spec.currReading),
    consumedKwh,
    dayRateText: rateText(rates.day, 5),
    nightRateText: rateText(rates.night, 5),
    dayCost, nightCost,
    grid: rates.grid, obligations: rates.obligations, excise: rates.excise,
    net, vat, total: net + vat,
  };
}

function computeWater(month, index) {
  const regime = regimes[month.regime];
  const rates = regime.water;
  const servicePeriod = shiftPeriod(month.period, -1);
  const bounds = monthBounds(servicePeriod);
  const prevBounds = monthBounds(shiftPeriod(servicePeriod, -1));
  const spec = month.water;
  const deliverCost = product(spec.cubic, rates.deliver);
  const sewerCost = product(spec.cubic, rates.sewer);
  const treatCost = product(spec.cubic, rates.treat);
  const extras = spec.extras ?? [];
  const net = deliverCost + sewerCost + treatCost + sum(extras.map(extra => extra.amount));
  const vat = vat20(net);
  const consumed = spec.currReading - spec.prevReading;
  if (consumed !== spec.cubic) {
    throw new Error(`${month.period}: water meter delta ${consumed} ≠ ${spec.cubic} m³`);
  }
  return {
    ...spec,
    invoiceNo: `0000${String(700000 + index * 2917).padStart(6, "0")}`,
    servicePeriod,
    periodStart: bounds.start,
    periodEnd: bounds.end,
    prevDate: prevBounds.end,
    prevReadingText: String(spec.prevReading).padStart(4, "0"),
    currReadingText: String(spec.currReading).padStart(4, "0"),
    rates, deliverCost, sewerCost, treatCost, extras,
    net, vat, total: net + vat,
  };
}

function computeHeating(month, index) {
  const regime = regimes[month.regime];
  const servicePeriod = shiftPeriod(month.period, -1);
  const bounds = monthBounds(servicePeriod);
  const spec = month.heating;
  const perMwh = cents(regime.heating.perMwh);
  const heatCost = product(spec.mwh, regime.heating.perMwh);
  const net = heatCost + spec.hotWater + spec.distribution;
  const vat = vat20(net);
  return {
    ...spec,
    invoiceNo: `0000${String(900000 + index * 2411).padStart(6, "0")}`,
    servicePeriod,
    periodStart: bounds.start,
    periodEnd: bounds.end,
    mwhText: spec.mwh.toFixed(3).replace(".", ","),
    perMwh, heatCost,
    net, vat, total: net + vat,
  };
}

function computeFuel(month, receipt, index, ordinal) {
  const total = receipt.total;
  const net = Math.round(total / 1.2);
  const vat = total - net;
  const liters = (total / 100) / receipt.unitPrice;
  return {
    ...receipt,
    receiptNo: receipt.receiptNo ?? `04${receipt.station}-${String(200 + index * 61 + ordinal * 17).padStart(6, "0")}`,
    stationAddress: STATIONS[receipt.station],
    litersText: liters.toFixed(2),
    unitPriceText: receipt.unitPrice.toFixed(3),
    net, vat, total,
  };
}

// ---------------------------------------------------------------------------
// Artifact + event assembly
// ---------------------------------------------------------------------------

class MonthBuilder {
  constructor(month, index) {
    this.month = month;
    this.index = index;
    this.period = month.period;
    this.dir = month.dir;
    this.artifacts = [];
    this.events = [];
    this.groups = [];
  }

  /** Register a document. `write` absent ⇒ frozen (declared, never rewritten). */
  add(entry) {
    const artifact = {
      relPath: entry.relPath,
      format: entry.relPath.split(".").pop(),
      period: entry.period ?? this.period,
      frozen: Boolean(entry.frozen),
      write: entry.write ?? null,
      disposition: entry.disposition,
      reason: entry.reason,
      eventId: entry.eventId ?? null,
      duplicatesDocument: entry.duplicatesDocument ?? null,
      role: entry.role ?? null,
      locators: entry.locators ?? {},
      language: entry.language ?? "bg",
      indexable: !entry.relPath.endsWith(".png"),
    };
    this.artifacts.push(artifact);
    return artifact;
  }

  event(entry) {
    this.events.push({
      period: this.period,
      currency: "BGN",
      verification_status: "verified",
      payment_status: "documented",
      ...entry,
    });
    return entry.id;
  }

  group(entry) {
    this.groups.push({ period: this.period, ...entry });
  }

  path(name) {
    return `${this.dir}/${name}`;
  }
}

function buildUtilityBill(builder, kind, model, renderer, options) {
  const { period } = builder;
  const provider = providers[kind];
  const relPath = builder.path(`${options.slug}.txt`);
  const eventId = `${period}-utilities-${kind}`;
  builder.add({
    relPath,
    write: () => renderer(model),
    disposition: "included",
    reason: `${options.labelEn} charge for ${period}, assigned by issue date ${model.issue}`,
    eventId,
    role: "primary",
    locators: { invoice_no: model.invoiceNo, issue_date: model.issue, due_date: model.due },
  });
  builder.event({
    id: eventId,
    category: "Utilities",
    amount: model.total,
    transaction_date: model.issue,
    document_date: model.issue,
    due_date: model.due,
    service_period: model.servicePeriod,
    merchant_or_provider: provider.nameBg,
    evidence_kind: "invoice",
    payment_status: "amount_due_documented",
    primary_document: relPath,
    source_documents: [relPath],
    source_locators: { invoice_no: model.invoiceNo },
    classification_reason: `${options.labelEn} is a household utility under this benchmark's taxonomy`,
  });
  return { eventId, relPath };
}

/** Attach an extra document to an existing event as a duplicate representation. */
function attachRepresentation(builder, { eventId, relPath, write, matchBasis, kindLabel, locators, language, groupId, frozen }) {
  builder.add({
    relPath,
    write,
    frozen,
    disposition: "duplicate_representation",
    reason: kindLabel,
    eventId,
    role: "duplicate_representation",
    locators: locators ?? {},
    language: language ?? "bg",
  });
  const event = builder.events.find(candidate => candidate.id === eventId);
  event.source_documents.push(relPath);
  const id = groupId ?? `${eventId}-representations`;
  event.deduplication_group = id;
  const existing = builder.groups.find(group => group.id === id);
  if (existing) {
    existing.records.push(relPath);
  } else {
    builder.group({
      id,
      kind: "representation",
      canonical_event: eventId,
      count_once_bgn: event.amount / 100,
      records: [event.primary_document, relPath],
      match_basis: matchBasis,
      role: "duplicate representations of one source document — never two events",
    });
  }
}

function buildMonth(month, index) {
  const builder = new MonthBuilder(month, index);
  if (month.frozen) return builder; // June 2026 is declared separately
  const monthTag = fileMonth(month.period);
  const bounds = monthBounds(month.period);

  // --- Electricity -------------------------------------------------------
  let electricity = null;
  if (month.electricity?.frozen) {
    const spec = month.electricity;
    const eventId = `${month.period}-utilities-electricity`;
    builder.add({
      relPath: spec.path, frozen: true, disposition: "included",
      reason: `frozen hand-authored bill; electricity charge for ${month.period}`,
      eventId, role: "primary", locators: { invoice_no: spec.invoiceNo },
    });
    builder.event({
      id: eventId, category: "Utilities", amount: spec.amount,
      transaction_date: spec.issue, document_date: spec.issue, due_date: spec.due,
      service_period: spec.servicePeriod, merchant_or_provider: providers.electricity.nameBg,
      evidence_kind: "invoice", payment_status: "amount_due_documented",
      primary_document: spec.path, source_documents: [spec.path],
      source_locators: { invoice_no: spec.invoiceNo },
      classification_reason: "electricity is a household utility under this benchmark's taxonomy",
      verification_status: "verified-frozen",
    });
    electricity = { eventId, relPath: spec.path, model: { invoiceNo: spec.invoiceNo, issue: spec.issue, due: spec.due, total: spec.amount, servicePeriod: spec.servicePeriod } };
  } else if (month.electricity) {
    const model = computeElectricity(month, index);
    const built = buildUtilityBill(builder, "electricity", model, bg.electricityBill, {
      slug: `electricity-bill-${fileDate(model.issue)}`, labelEn: "Electricity",
    });
    electricity = { ...built, model };
  }

  // --- Water -------------------------------------------------------------
  let water = null;
  if (month.water?.frozen) {
    const spec = month.water;
    const eventId = `${month.period}-utilities-water`;
    builder.add({
      relPath: spec.path, frozen: true, disposition: "included",
      reason: `frozen hand-authored bill; water charge for ${month.period}`,
      eventId, role: "primary", locators: { invoice_no: spec.invoiceNo },
    });
    builder.event({
      id: eventId, category: "Utilities", amount: spec.amount,
      transaction_date: spec.issue, document_date: spec.issue, due_date: spec.due,
      service_period: spec.servicePeriod, merchant_or_provider: providers.water.nameBg,
      evidence_kind: "invoice", payment_status: "amount_due_documented",
      primary_document: spec.path, source_documents: [spec.path],
      source_locators: { invoice_no: spec.invoiceNo },
      classification_reason: "water supply is a household utility under this benchmark's taxonomy",
      verification_status: "verified-frozen",
    });
    water = { eventId, relPath: spec.path, model: { invoiceNo: spec.invoiceNo, issue: spec.issue, due: spec.due, total: spec.amount, servicePeriod: spec.servicePeriod } };
  } else if (month.water) {
    const model = computeWater(month, index);
    const built = buildUtilityBill(builder, "water", model, bg.waterBill, {
      slug: `water-bill-${fileDate(model.issue)}`, labelEn: "Water supply",
    });
    water = { ...built, model };
    // The frozen May payment form settles this exact bill.
    if (month.water.frozenPayment) {
      const settlement = month.water.frozenPayment;
      if (settlement.amount !== model.total) {
        throw new Error(`${month.period}: frozen water payment ${settlement.amount} ≠ computed bill ${model.total}`);
      }
      attachRepresentation(builder, {
        eventId: built.eventId,
        relPath: settlement.path,
        frozen: true,
        kindLabel: "frozen completed payment order settling this water invoice — the payment and the invoice are one event",
        matchBasis: ["same provider (ВодаСофия ЕАД)", "same client number", `same amount (${money(model.total)} BGN)`, "payment reason names the invoice's service month"],
        locators: { payment_date: settlement.date, client_no: providers.water.clientNo },
      });
    }
  }

  // --- Heating -----------------------------------------------------------
  let heating = null;
  if (month.heating) {
    const model = computeHeating(month, index);
    const built = buildUtilityBill(builder, "heating", model, bg.heatingBill, {
      slug: `heating-bill-${fileDate(model.issue)}`, labelEn: "Central heating",
    });
    heating = { ...built, model };
  }

  // --- Municipal waste fee ----------------------------------------------
  if (month.waste) {
    const spec = month.waste;
    const amount = regimes[month.regime].waste;
    const quarterShort = spec.quarter.replace(/Тримесечие\s*(\d)\s*\/\s*(\d{4})/, "Q$1/$2");
    const relPath = builder.path(`waste-fee-${fileDate(spec.date)}.txt`);
    const eventId = `${month.period}-utilities-waste`;
    builder.add({
      relPath,
      write: () => bg.wasteNotice({ ...spec, amount, quarterShort }),
      disposition: "included",
      reason: `municipal waste fee instalment ${quarterShort}, notice dated ${spec.date}`,
      eventId, role: "primary",
      locators: { notice_no: spec.noticeNo, instalment: quarterShort },
    });
    builder.event({
      id: eventId, category: "Utilities", amount,
      transaction_date: spec.date, document_date: spec.date, due_date: spec.due,
      service_period: null, merchant_or_provider: providers.waste.nameBg,
      evidence_kind: "notice", payment_status: "amount_due_documented",
      primary_document: relPath, source_documents: [relPath],
      source_locators: { notice_no: spec.noticeNo },
      classification_reason: "municipal waste fee is folded into Utilities by benchmark policy rather than reported as its own category",
      verification_status: "benchmark-policy",
    });
  }

  // --- Credit note (negative Utilities amount) ---------------------------
  if (month.creditNote) {
    const spec = month.creditNote;
    const total = spec.amount; // negative
    const net = Math.round(total / 1.2);
    const relPath = builder.path(`${spec.slug}.txt`);
    const eventId = `${month.period}-utilities-credit-note`;
    const referenced = spec.referencesInvoiceOf;
    const referencedInvoiceNo = `0000${String(410000 + months.findIndex(m => m.period === referenced) * 3671).padStart(6, "0")}`;
    const referencedIssue = months.find(m => m.period === referenced).electricity.issue;
    builder.add({
      relPath,
      write: () => bg.creditNote({
        ...spec,
        noticeNo: `КИ-${spec.date.slice(0, 4)}-${String(1170 + index).padStart(7, "0")}`,
        referencesInvoiceNo: referencedInvoiceNo,
        referencesInvoiceDate: referencedIssue,
        net, vat: total - net, total,
      }),
      disposition: "included",
      reason: "credit note; a negative Utilities amount that must reduce the category total",
      eventId, role: "primary",
      locators: { references_invoice_no: referencedInvoiceNo },
    });
    builder.event({
      id: eventId, category: "Utilities", amount: total,
      transaction_date: spec.date, document_date: spec.date, due_date: null,
      service_period: referenced, merchant_or_provider: providers[spec.provider].nameBg,
      evidence_kind: "credit_note", payment_status: "credit_documented",
      primary_document: relPath, source_documents: [relPath],
      source_locators: { references_invoice_no: referencedInvoiceNo },
      classification_reason: "a credit note reduces the category it corrects; treating it as a positive charge overstates Utilities by twice its value",
      verification_status: "verified",
    });
  }

  // --- Internet payment --------------------------------------------------
  if (month.internet) {
    const spec = month.internet;
    const amount = regimes[month.regime].internet;
    const servicePeriod = shiftPeriod(month.period, -1);
    const relPath = builder.path(`internet-payment-${fileDate(spec.date)}.txt`);
    const eventId = `${month.period}-internet`;
    builder.add({
      relPath,
      write: () => bg.paymentForm({
        subjectEn: "internet bill",
        payeeName: providers.internet.nameBg,
        payeeIban: providers.internet.iban,
        payeeBank: providers.internet.bankBg,
        payeeBic: providers.internet.bic,
        amount,
        reason: `Интернет ${serviceMarker(servicePeriod)}, кл. № ${providers.internet.clientNo}`,
        clientNo: providers.internet.clientNo,
        date: spec.date,
      }),
      disposition: "included",
      reason: "completed payment order for the fixed internet service",
      eventId, role: "primary",
      locators: { client_no: providers.internet.clientNo, payment_date: spec.date },
    });
    builder.event({
      id: eventId, category: "Internet", amount,
      transaction_date: spec.date, document_date: spec.date, due_date: null,
      service_period: servicePeriod, merchant_or_provider: providers.internet.nameBg,
      evidence_kind: "completed_payment_order", payment_status: "paid",
      primary_document: relPath, source_documents: [relPath],
      source_locators: { client_no: providers.internet.clientNo },
      classification_reason: "Internet is kept separate from Utilities by benchmark policy",
      verification_status: "benchmark-policy",
    });
  }

  // --- Fuel --------------------------------------------------------------
  const fuelEvents = [];
  for (const [ordinal, receipt] of (month.fuel ?? []).entries()) {
    if (receipt.frozen) {
      const eventId = `${month.period}-fuel-${fileDate(receipt.date)}`;
      builder.add({
        relPath: receipt.path, frozen: true, disposition: "included",
        reason: "frozen hand-authored fuel receipt",
        eventId, role: "primary", locators: { receipt_no: receipt.receiptNo },
        language: "en",
      });
      builder.event({
        id: eventId, category: "Fuel", amount: receipt.total,
        transaction_date: receipt.date, document_date: receipt.date, due_date: null,
        service_period: null, merchant_or_provider: "PetrolMax",
        evidence_kind: "fiscal_receipt", payment_status: "paid",
        primary_document: receipt.path, source_documents: [receipt.path],
        source_locators: { receipt_no: receipt.receiptNo },
        classification_reason: "vehicle fuel",
        verification_status: "verified-frozen",
      });
      fuelEvents.push({ eventId, date: receipt.date, amount: receipt.total, description: "PetrolMax fuel station", category: "Fuel", card: true, relPath: receipt.path });
      continue;
    }
    const model = computeFuel(month, receipt, index, ordinal);
    const relPath = builder.path(`fuel-receipt-${fileDate(receipt.date)}.txt`);
    const eventId = `${month.period}-fuel-${fileDate(receipt.date)}`;
    builder.add({
      relPath,
      write: () => bg.fuelReceipt(model),
      disposition: "included",
      reason: "fuel purchase receipt",
      eventId, role: "primary", language: "en",
      locators: { receipt_no: model.receiptNo, auth: model.auth },
    });
    builder.event({
      id: eventId, category: "Fuel", amount: model.total,
      transaction_date: receipt.date, document_date: receipt.date, due_date: null,
      service_period: null, merchant_or_provider: `PetrolMax, Fuel Station #${receipt.station}`,
      evidence_kind: "fiscal_receipt", payment_status: "paid",
      primary_document: relPath, source_documents: [relPath],
      source_locators: { receipt_no: model.receiptNo, card_suffix: payer.cardSuffix, auth: model.auth },
      classification_reason: "vehicle fuel",
    });
    fuelEvents.push({ eventId, date: receipt.date, amount: model.total, description: "PetrolMax fuel station", category: "Fuel", card: true, relPath });
  }

  // --- Groceries ---------------------------------------------------------
  const cardEvents = [...fuelEvents];
  for (const [ordinal, receipt] of (month.groceries ?? []).entries()) {
    const total = receipt.total;
    const net = Math.round(total / 1.2);
    const receiptNo = String(200000 + index * 137 + ordinal * 29).padStart(6, "0");
    const relPath = builder.path(`grocery-receipt-${fileDate(receipt.date)}.txt`);
    const eventId = `${month.period}-groceries-${fileDate(receipt.date)}`;
    const model = {
      ...receipt, receiptNo, net, vat: total - net, total, card: true,
      categoryBg: CATEGORY_BG.Groceries,
      auth: String(10000 + index * 311 + ordinal * 7).padStart(6, "0"),
      lines: basketLines(total, index * 3 + ordinal),
      operatorLine: `Каса: ${1 + (ordinal % 4)}   Оператор: ${10 + ordinal}`,
    };
    builder.add({
      relPath,
      write: () => bg.shopReceipt(model),
      disposition: "included",
      reason: "supermarket purchase receipt",
      eventId, role: "primary",
      locators: { receipt_no: receiptNo },
    });
    builder.event({
      id: eventId, category: "Groceries", amount: total,
      transaction_date: receipt.date, document_date: receipt.date, due_date: null,
      service_period: null, merchant_or_provider: merchants[receipt.merchant].nameBg,
      evidence_kind: "fiscal_receipt", payment_status: "paid",
      primary_document: relPath, source_documents: [relPath],
      source_locators: { receipt_no: receiptNo, card_suffix: payer.cardSuffix },
      classification_reason: "supermarket food purchase",
    });
    cardEvents.push({ eventId, date: receipt.date, amount: total, description: merchants[receipt.merchant].nameEn, category: "Groceries", card: true, relPath });
    if (receipt.scan) {
      attachRepresentation(builder, {
        eventId,
        relPath: builder.path(`grocery-receipt-${fileDate(receipt.date)}.png`),
        write: () => writePng(bg.shopReceipt(model)),
        kindLabel: "scanned image of the same receipt; NOT docgraph-indexable, reachable only through the vision path",
        matchBasis: [`same receipt number (${receiptNo})`, "same merchant, date and amount", "identical printed content"],
        locators: { receipt_no: receiptNo },
      });
    }
  }

  // --- Occasional extras -------------------------------------------------
  for (const extra of month.extras ?? []) {
    if (extra.currency && extra.currency !== "BGN") {
      // Foreign-currency purchase: excluded from the BGN total, never converted.
      const relPath = builder.path(`${extra.id === "eur-order-apr" ? "elektroshop-order-14-apr" : extra.id}.pdf`);
      builder.add({
        relPath,
        write: async () => writePdf(foreignOrderInvoice({
          merchantName: "ElektroShop GmbH",
          merchantAddress: "Hauptstraße 44, 10827 Berlin, Deutschland",
          vatId: "DE811223344",
          invoiceNo: `ES-2026-${String(40120 + index).padStart(6, "0")}`,
          orderNo: `BST-${String(778100 + index).padStart(7, "0")}`,
          date: extra.date,
          itemDe: "Kabellose Kopfhörer, Modell EH-350",
          total: extra.total,
        }), { title: "ElektroShop GmbH — Rechnung (fictional sample)" }),
        disposition: "excluded_foreign_currency",
        reason: extra.excluded.reason,
        language: "de",
        locators: { currency: extra.currency },
      });
      builder.event({
        id: `${month.period}-eur-order`, category: "Shopping", amount: extra.total,
        currency: extra.currency,
        transaction_date: extra.date, document_date: extra.date, due_date: null,
        service_period: null, merchant_or_provider: "ElektroShop GmbH",
        evidence_kind: "invoice", payment_status: "paid",
        primary_document: relPath, source_documents: [relPath],
        source_locators: {},
        excluded_from_bgn_total: true,
        classification_reason: extra.excluded.reason,
        verification_status: "benchmark-policy",
      });
      continue;
    }
    if (extra.kind === "insurance-premium") {
      const relPath = builder.path(`insurance-premium-${fileDate(extra.date)}.txt`);
      const eventId = `${month.period}-insurance`;
      builder.add({
        relPath,
        write: () => bg.insuranceInvoice({ date: extra.date, coverage: extra.coverage, total: extra.total }),
        disposition: "included",
        reason: "annual insurance premium, charged once in this month",
        eventId, role: "primary",
        locators: { policy_no: providers.insurance.policyNo },
      });
      builder.event({
        id: eventId, category: "Insurance", amount: extra.total,
        transaction_date: extra.date, document_date: extra.date, due_date: null,
        service_period: `${extra.coverage.start}/${extra.coverage.end}`,
        merchant_or_provider: providers.insurance.nameBg,
        evidence_kind: "invoice", payment_status: "amount_due_documented",
        primary_document: relPath, source_documents: [relPath],
        source_locators: { policy_no: providers.insurance.policyNo },
        classification_reason: "the whole annual premium falls in its issue month by benchmark policy; the amortised reading (20.00 BGN/month) is reported separately and must not be mixed in",
        verification_status: "benchmark-policy",
        amortised_monthly_bgn: extra.total / 12 / 100,
      });
      continue;
    }
    if (extra.kind === "prepaid-topup") {
      const relPath = builder.path(`mobile-topup-${fileDate(extra.date)}.txt`);
      const eventId = `${month.period}-mobile`;
      const model = {
        date: extra.date, time: extra.time, total: extra.total,
        receiptNo: String(700000 + index * 53).padStart(6, "0"),
        auth: String(20000 + index * 91).padStart(6, "0"),
      };
      builder.add({
        relPath, write: () => bg.mobileTopup(model),
        disposition: "included", reason: "prepaid mobile top-up",
        eventId, role: "primary", locators: { receipt_no: model.receiptNo },
      });
      builder.event({
        id: eventId, category: "Mobile", amount: extra.total,
        transaction_date: extra.date, document_date: extra.date, due_date: null,
        service_period: null, merchant_or_provider: providers.mobile.nameBg,
        evidence_kind: "fiscal_receipt", payment_status: "paid",
        primary_document: relPath, source_documents: [relPath],
        source_locators: { receipt_no: model.receiptNo },
        classification_reason: "occasional prepaid top-up, not a monthly subscription",
      });
      cardEvents.push({ eventId, date: extra.date, amount: extra.total, description: "MobiTel prepaid top-up", category: "Mobile", card: true, relPath });
      continue;
    }
    // Ordinary card purchase: pharmacy, restaurant, retail, vehicle service.
    const total = extra.total;
    const net = Math.round(total / 1.2);
    const receiptNo = String(300000 + index * 211 + extra.id.length).padStart(6, "0");
    const slug = `${extra.merchant.replace(/[^a-z]/g, "")}-receipt-${fileDate(extra.date)}`;
    const relPath = builder.path(`${slug}.txt`);
    const eventId = `${month.period}-${extra.id}`;
    const model = {
      ...extra, receiptNo, net, vat: total - net, total,
      categoryBg: CATEGORY_BG[extra.category] ?? extra.category,
      auth: String(30000 + index * 137).padStart(6, "0"),
      lines: shopLines(extra.merchant, total),
    };
    builder.add({
      relPath, write: () => bg.shopReceipt(model),
      disposition: "included", reason: `${extra.category} purchase receipt`,
      eventId, role: "primary", locators: { receipt_no: receiptNo },
    });
    builder.event({
      id: eventId, category: extra.category, amount: total,
      transaction_date: extra.date, document_date: extra.date, due_date: null,
      service_period: null, merchant_or_provider: merchants[extra.merchant].nameBg,
      evidence_kind: "fiscal_receipt", payment_status: "paid",
      primary_document: relPath, source_documents: [relPath],
      source_locators: { receipt_no: receiptNo, card_suffix: payer.cardSuffix },
      classification_reason: categories[extra.category],
    });
    if (extra.card) {
      cardEvents.push({ eventId, date: extra.date, amount: total, description: merchants[extra.merchant].nameEn, category: extra.category, card: true, relPath });
    }
  }

  // --- Public transport top-up ------------------------------------------
  if (month.transport) {
    const spec = month.transport;
    const relPath = builder.path(`transport-topup-${fileDate(spec.date)}.txt`);
    const eventId = `${month.period}-transport`;
    const model = {
      ...spec, period: month.period,
      receiptNo: String(15000 + index * 47).padStart(9, "0"),
      machine: "Автомат М2 - Сердика",
    };
    builder.add({
      relPath, write: () => bg.transportTopup(model),
      disposition: "included", reason: "monthly public-transport card top-up",
      eventId, role: "primary", locators: { receipt_no: model.receiptNo },
    });
    builder.event({
      id: eventId, category: "Transport", amount: spec.amount,
      transaction_date: spec.date, document_date: spec.date, due_date: null,
      service_period: month.period, merchant_or_provider: providers.transport.nameBg,
      evidence_kind: "fiscal_receipt", payment_status: "paid",
      primary_document: relPath, source_documents: [relPath],
      source_locators: { receipt_no: model.receiptNo, card_no: providers.transport.cardNo },
      classification_reason: "public-transport card top-up",
    });
  }

  // --- Cross-month settlement of this month's heating bill ---------------
  if (month.heating?.paidBy && heating) {
    const settlement = month.heating.paidBy;
    const relPath = `${settlement.dir}/${settlement.slug}.${settlement.format}`;
    const body = bg.paymentForm({
      subjectEn: "central heating bill",
      payeeName: providers.heating.nameBg,
      payeeIban: providers.heating.iban,
      payeeBank: "Банка ДСК",
      payeeBic: providers.heating.bic,
      amount: heating.model.total,
      reason: `Парно ${serviceMarker(heating.model.servicePeriod)}, аб. № ${providers.heating.clientNo}`,
      clientNo: providers.heating.clientNo,
      date: settlement.date,
    });
    attachRepresentation(builder, {
      eventId: heating.eventId,
      relPath,
      write: async () => writeDocx(body, { title: "Платежно нареждане — парно" }),
      kindLabel: `completed payment order settling the ${month.period} heating invoice; FILED under ${settlement.dir} but belongs to ${month.period} — the charge month, not the payment month`,
      matchBasis: [
        "same provider (ТоплоСофия ЕАД)",
        `same subscriber number (${providers.heating.clientNo})`,
        `same amount (${money(heating.model.total)} BGN)`,
        `payment reason names the invoice's service month (${serviceMarker(heating.model.servicePeriod)})`,
      ],
      locators: { payment_date: settlement.date, client_no: providers.heating.clientNo },
    });
  }

  // --- Bank statement (txt + PDF twin) -----------------------------------
  if (month.statement) {
    const spec = month.statement;
    const cutoff = spec.coverEnd ? `${month.period}-${String(spec.coverEnd).padStart(2, "0")}` : null;
    const rows = cardEvents
      .filter(entry => entry.card)
      .filter(entry => !cutoff || entry.date <= cutoff)
      .sort((left, right) => left.date.localeCompare(right.date));
    const totalDebits = sum(rows.map(row => row.amount));
    const opening = 397500 + index * 11250;
    const model = {
      rows, totalDebits, opening, closing: opening - totalDebits,
      periodStart: bounds.start, periodEnd: bounds.end,
      coverEnd: spec.coverEnd ?? null, cutoff,
    };
    const relPath = builder.path(`bank-statement-${monthTag}.txt`);
    const text = bg.bankStatement(model);
    builder.add({
      relPath, write: () => text,
      disposition: "supporting_evidence",
      reason: spec.coverEnd
        ? `interim statement covering card payments to ${cutoff} only; partial evidence of the month`
        : "full-month statement of card payments only; partial evidence of the month",
      role: "statement", language: "en",
      locators: { iban: payer.iban, total_debits: totalDebits / 100 },
    });
    builder.add({
      relPath: builder.path(`bank-statement-${monthTag}.pdf`),
      write: async () => writePdf(text, { title: `First Digital Bank statement ${month.period} (fictional)` }),
      disposition: "duplicate_representation",
      reason: "PDF export of the same statement; the same rows must not be counted twice",
      role: "duplicate_representation", language: "en",
      // Duplicates a supporting-evidence DOCUMENT, not an event: a statement is
      // not itself an economic event, so this link points at the .txt statement.
      duplicatesDocument: relPath,
      locators: { iban: payer.iban },
    });
    builder.group({
      id: `${month.period}-statement-representations`,
      kind: "representation",
      canonical_event: null,
      records: [relPath, builder.path(`bank-statement-${monthTag}.pdf`)],
      match_basis: ["same IBAN", "same statement period", "identical row set and total debits"],
      role: "the .txt and .pdf statement are one document in two formats",
    });
    // Statement rows overlap receipts already counted: adjudicated transaction dedup.
    for (const row of rows) {
      const event = builder.events.find(candidate => candidate.id === row.eventId);
      event.on_bank_statement = relPath;
      builder.group({
        id: `${row.eventId}-statement-overlap`,
        kind: "transaction",
        canonical_event: row.eventId,
        count_once_bgn: row.amount / 100,
        records: [row.relPath, `${relPath}:${row.date}:${money(row.amount, "en")}`],
        match_basis: ["same merchant", `same transaction date (${row.date})`, "same amount and currency", "compatible card-payment document role"],
        role: "adjudicated duplicate evidence for one economic event: no shared transaction identifier exists, so the match is a benchmark adjudication rather than a joined identity",
        verification_status: "adjudicated",
      });
    }
    builder.statement = {
      document: relPath,
      style: spec.coverEnd ? "interim" : "full-month",
      cutoff,
      total_debits_bgn: totalDebits / 100,
      on_statement: rows.map(row => row.relPath),
      off_statement: builder.events
        .filter(event => !event.excluded_from_bgn_total && !rows.some(row => row.eventId === event.id))
        .map(event => event.primary_document),
    };
  }

  // --- HTML e-invoice twin ----------------------------------------------
  if (month.einvoiceHtml) {
    const target = { electricity, water, heating }[month.einvoiceHtml];
    if (target) {
      const provider = providers[month.einvoiceHtml];
      const titles = {
        electricity: "Електронна фактура за електроенергия",
        water: "Електронна фактура за водоснабдяване",
        heating: "Електронна фактура за топлинна енергия",
      };
      const rows = month.einvoiceHtml === "electricity" && target.model.net !== undefined
        ? [
            { label: "Дневна тарифа", amount: target.model.dayCost },
            { label: "Нощна тарифа", amount: target.model.nightCost },
            { label: "Мрежови услуги", amount: target.model.grid },
            { label: "Задължения към обществото", amount: target.model.obligations },
            { label: "Акциз", amount: target.model.excise },
            { label: "ДДС 20%", amount: target.model.vat },
          ]
        : [
            { label: "Стойност без ДДС", amount: target.model.net ?? target.model.total },
            { label: "ДДС 20%", amount: target.model.vat ?? 0 },
          ];
      attachRepresentation(builder, {
        eventId: target.eventId,
        relPath: builder.path(`${month.einvoiceHtml}-einvoice-${fileDate(target.model.issue)}.html`),
        write: () => writeHtml({
          titleBg: titles[month.einvoiceHtml],
          providerBg: provider.nameBg,
          invoiceNo: target.model.invoiceNo,
          issue: dotted(target.model.issue),
          servicePeriodBg: bgPeriodText(target.model.servicePeriod),
          dueDate: dotted(target.model.due),
          rows,
          total: target.model.total,
          footerBg: "Фиктивен примерен документ за демонстрационни цели. Всички данни са измислени.",
        }),
        kindLabel: "provider's web copy (e-invoice) of the same invoice",
        matchBasis: [`same invoice number (${target.model.invoiceNo})`, "same issue date, service period and total"],
        locators: { invoice_no: target.model.invoiceNo },
      });
    }
  }

  // --- Provider notification e-mail -------------------------------------
  if (month.notificationEml) {
    const target = { electricity, water, heating, internet: null }[month.notificationEml];
    const provider = providers[month.notificationEml];
    if (target) {
      const subjects = {
        electricity: "Фактура за електроенергия",
        water: "Фактура за водоснабдяване",
        heating: "Фактура за топлинна енергия",
      };
      const body = `Уважаеми ${payer.nameBg},

Издадена е нова фактура по Вашия клиентски номер.

Фактура №: ${target.model.invoiceNo}
Дата на издаване: ${dotted(target.model.issue)}
Период на отчитане: ${bgPeriodText(target.model.servicePeriod)}
Сума за плащане: ${money(target.model.total)} лв
Краен срок за плащане: ${dotted(target.model.due)}

Може да платите по банков път на IBAN ${provider.iban}.

Настоящото писмо е известие. Оригиналната фактура е приложена
към Вашия профил.

Фиктивно примерно съобщение за демонстрационни цели.`;
      attachRepresentation(builder, {
        eventId: target.eventId,
        relPath: builder.path(`${month.notificationEml}-notification-${fileDate(target.model.issue)}.eml`),
        write: () => writeEml({
          from: `billing@${provider.domain}`,
          fromName: provider.nameBg,
          to: "ivan.petrov@example.com",
          toName: payer.nameBg,
          subject: `${subjects[month.notificationEml]} № ${target.model.invoiceNo}`,
          date: new Date(`${target.model.issue}T09:12:00Z`).toUTCString(),
          messageId: `${target.model.invoiceNo}.${month.period}@${provider.domain}`,
          body,
        }),
        kindLabel: "provider e-mail notification announcing the same invoice",
        matchBasis: [`same invoice number (${target.model.invoiceNo})`, "same amount and due date"],
        locators: { invoice_no: target.model.invoiceNo },
      });
    } else if (month.notificationEml === "internet") {
      // The internet event has no invoice document, only a payment order; the
      // e-mail is the provider's own notice for the same service month.
      const eventId = `${month.period}-internet`;
      const event = builder.events.find(candidate => candidate.id === eventId);
      const servicePeriod = shiftPeriod(month.period, -1);
      const body = `Уважаеми ${payer.nameBg},

Вашата месечна такса за интернет услуга е начислена.

Клиентски номер: ${providers.internet.clientNo}
Услуга: Интернет ${serviceMarker(servicePeriod)}
Сума: ${money(event.amount)} лв
IBAN за плащане: ${providers.internet.iban}

Благодарим Ви, че сте наш клиент.

Фиктивно примерно съобщение за демонстрационни цели.`;
      attachRepresentation(builder, {
        eventId,
        relPath: builder.path(`internet-notification-${fileDate(event.transaction_date)}.eml`),
        write: () => writeEml({
          from: `billing@${providers.internet.domain}`,
          fromName: providers.internet.nameBg,
          to: "ivan.petrov@example.com",
          toName: payer.nameBg,
          subject: `Месечна такса интернет ${serviceMarker(servicePeriod)}`,
          date: new Date(`${event.transaction_date}T08:40:00Z`).toUTCString(),
          messageId: `netlink.${month.period}@${providers.internet.domain}`,
          body,
        }),
        kindLabel: "provider e-mail notice for the same internet service month",
        matchBasis: [`same client number (${providers.internet.clientNo})`, "same service month and amount"],
        locators: { client_no: providers.internet.clientNo },
      });
    }
  }

  // --- Duplicate invoice resend (dedup trap) -----------------------------
  if (month.electricity?.resendEml && electricity) {
    const resend = month.electricity.resendEml;
    const model = electricity.model;
    const body = `Уважаеми ${payer.nameBg},

НАПОМНЯНЕ: към момента не е регистрирано плащане по посочената
по-долу фактура. Изпращаме я повторно.

Фактура №: ${model.invoiceNo}
Дата на издаване: ${dotted(model.issue)}
Сума за плащане: ${money(model.total)} лв
Краен срок за плащане: ${dotted(model.due)}

Ако вече сте платили, моля не се съобразявайте с това напомняне.

Фиктивно примерно съобщение за демонстрационни цели.`;
    attachRepresentation(builder, {
      eventId: electricity.eventId,
      relPath: builder.path(`${resend.slug}.eml`),
      write: () => writeEml({
        from: `billing@${providers.electricity.domain}`,
        fromName: providers.electricity.nameBg,
        to: "ivan.petrov@example.com",
        toName: payer.nameBg,
        subject: `Напомняне: неплатена фактура № ${model.invoiceNo}`,
        date: new Date(`${resend.date}T07:30:00Z`).toUTCString(),
        messageId: `resend.${model.invoiceNo}@${providers.electricity.domain}`,
        body,
      }),
      kindLabel: "reminder resend of an invoice already present in the corpus; a THIRD representation of one charge, not a second charge",
      matchBasis: [`same invoice number (${model.invoiceNo})`, "same amount and due date", "explicitly labelled a resend"],
      locators: { invoice_no: model.invoiceNo },
    });
  }

  // --- Payment form as .docx --------------------------------------------
  if (month.paymentFormDocx) {
    const target = { electricity, water, heating }[month.paymentFormDocx];
    if (target) {
      const provider = providers[month.paymentFormDocx];
      const reasons = {
        electricity: `Ел. енергия ${serviceMarker(target.model.servicePeriod)}, кл. № ${provider.clientNo}`,
        water: `Вода ${serviceMarker(target.model.servicePeriod)}, кл. № ${provider.clientNo}`,
        heating: `Парно ${serviceMarker(target.model.servicePeriod)}, аб. № ${provider.clientNo}`,
      };
      const payDate = `${month.period}-${String(Math.min(28, Number(target.model.due.slice(-2)) - 2)).padStart(2, "0")}`;
      const body = bg.paymentForm({
        subjectEn: `${month.paymentFormDocx} bill`,
        payeeName: provider.nameBg,
        payeeIban: provider.iban,
        payeeBank: month.paymentFormDocx === "heating" ? "Банка ДСК" : "УниКредит",
        payeeBic: provider.bic,
        amount: target.model.total,
        reason: reasons[month.paymentFormDocx],
        clientNo: provider.clientNo,
        date: payDate,
      });
      attachRepresentation(builder, {
        eventId: target.eventId,
        relPath: builder.path(`${month.paymentFormDocx}-payment-${fileDate(payDate)}.docx`),
        write: async () => writeDocx(body, { title: `Платежно нареждане — ${month.paymentFormDocx}` }),
        kindLabel: "completed payment order settling the same invoice; the payment and the invoice are one event",
        matchBasis: [
          `same provider (${provider.nameBg})`,
          `same client number (${provider.clientNo})`,
          `same amount (${money(target.model.total)} BGN)`,
          "payment reason names the invoice's service month",
        ],
        locators: { payment_date: payDate, client_no: provider.clientNo },
      });
      const event = builder.events.find(candidate => candidate.id === target.eventId);
      event.payment_status = "paid";
    }
  }

  // --- Regulatory notice (informational) --------------------------------
  if (month.regulatoryNotice) {
    const notice = month.regulatoryNotice;
    builder.add({
      relPath: builder.path(`${notice.slug}.txt`),
      write: () => bg.regulatoryNotice({
        ...notice,
        rateWords: "четири цяло и осем десети процента",
      }),
      disposition: "informational",
      reason: `regulator's tariff-change notice effective ${notice.effective}; announces a future price change and is not a transaction`,
      role: "informational",
      locators: { ref: notice.ref, effective: notice.effective, rate_percent: notice.ratePercent },
    });
  }

  // --- Planned budget sheet (distractor) --------------------------------
  if (month.budget) {
    const rows = Object.entries(month.budget).map(([category, planned]) => ({ category, planned }));
    builder.add({
      relPath: builder.path(`budget-plan-${monthTag}.xlsx`),
      write: async () => writeXlsx({
        period: month.period,
        titleBg: `Планиран бюджет — ${bgMonthName(Number(month.period.slice(5)))} ${month.period.slice(0, 4)} г.`,
        rows,
        noteBg: "Плановите суми са прогнозни и се различават от действително платените.",
      }),
      disposition: "informational",
      reason: "PLANNED budget, not actuals — the figures deliberately differ from what was spent, so a model that reports this sheet's total is reporting an intention, not a fact",
      role: "informational",
      locators: { planned_total_bgn: sum(rows.map(row => row.planned)) / 100 },
    });
  }

  // --- Travel (foreign language, foreign currency, excluded) ------------
  if (month.trip) {
    const trip = trips[month.trip];
    for (const doc of trip.docs) {
      const usePdf = doc.format === "pdf";
      const text = travelDocument(trip, doc);
      const relPath = builder.path(`${doc.slug}.${usePdf ? "pdf" : "txt"}`);
      builder.add({
        relPath,
        write: usePdf
          ? async () => writePdf(text, { title: `${doc.merchant} — ${trip.place} (fictional sample)` })
          : () => text,
        disposition: "excluded_travel",
        reason: `personal travel in ${trip.country} (${trip.language}), denominated in ${trip.currency}; excluded from the BGN household total by declared benchmark policy and never converted`,
        role: "travel",
        language: trip.language,
        locators: { ref: doc.ref, currency: trip.currency, kind: doc.kind },
      });
      builder.event({
        id: `${month.period}-travel-${doc.id}`,
        category: "Travel",
        amount: doc.amount,
        currency: trip.currency,
        transaction_date: doc.date, document_date: doc.date, due_date: null,
        service_period: null,
        merchant_or_provider: doc.merchant,
        evidence_kind: doc.kind === "hotel" ? "invoice" : "receipt",
        payment_status: "paid",
        primary_document: relPath,
        source_documents: [relPath],
        source_locators: { ref: doc.ref },
        excluded_from_bgn_total: true,
        trip: month.trip,
        language: trip.language,
        classification_reason: "travel spending, excluded from the household BGN total by benchmark policy",
        verification_status: "benchmark-policy",
      });
      // Chinese documents cannot be rendered by pdf-lib's WinAnsi fonts, so the
      // CJK hotel invoice gets a PNG scan instead of a PDF.
      if (trip.language === "zh-CN" && doc.kind === "hotel") {
        builder.add({
          relPath: builder.path(`${doc.slug}.png`),
          write: () => writePng(text, { fontSize: 16 }),
          disposition: "duplicate_representation",
          reason: "scanned image of the same Chinese hotel invoice; vision path only (PNG is not docgraph-indexable)",
          eventId: `${month.period}-travel-${doc.id}`,
          role: "duplicate_representation",
          language: trip.language,
          locators: { ref: doc.ref },
        });
        builder.group({
          id: `${month.period}-travel-${doc.id}-representations`,
          kind: "representation",
          canonical_event: `${month.period}-travel-${doc.id}`,
          records: [relPath, builder.path(`${doc.slug}.png`)],
          match_basis: [`same voucher number (${doc.ref})`, "identical printed content"],
          role: "duplicate representations of one travel invoice",
        });
      }
    }
  }

  return builder;
}

/** The frozen June 2026 slice, declared for the oracle only. */
function buildFrozenJune() {
  const period = "2026-06";
  const dir = "2026/June";
  const builder = new MonthBuilder({ period, dir }, 7);
  const utilities = [
    { key: "electricity", file: "electricity-bill-03-jun.txt", scan: "electricity-bill-03-jun.png", amount: 14250, issue: "2026-06-03", due: "2026-06-20", invoiceNo: "0000451287", provider: providers.electricity.nameBg, label: "electricity" },
    { key: "water", file: "water-bill-05-jun.txt", amount: 3820, issue: "2026-06-05", due: "2026-06-25", invoiceNo: "0000778341", provider: providers.water.nameBg, label: "water supply" },
    { key: "heating", file: "heating-bill-15-jun.txt", amount: 6480, issue: "2026-06-15", due: "2026-06-30", invoiceNo: "0000934512", provider: providers.heating.nameBg, label: "central heating" },
  ];
  for (const utility of utilities) {
    const relPath = `${dir}/${utility.file}`;
    const eventId = `${period}-utilities-${utility.key}`;
    builder.add({
      relPath, frozen: true, disposition: "included",
      reason: `${utility.label} charge for June 2026, assigned by issue date ${utility.issue}`,
      eventId, role: "primary", locators: { invoice_no: utility.invoiceNo },
    });
    builder.event({
      id: eventId, category: "Utilities", amount: utility.amount,
      transaction_date: utility.issue, document_date: utility.issue, due_date: utility.due,
      service_period: "2026-05", merchant_or_provider: utility.provider,
      evidence_kind: "invoice", payment_status: "amount_due_documented",
      primary_document: relPath, source_documents: [relPath],
      source_locators: { invoice_no: utility.invoiceNo },
      classification_reason: `${utility.label} is a household utility under this benchmark's taxonomy`,
      verification_status: "verified-frozen",
    });
    if (utility.scan) {
      attachRepresentation(builder, {
        eventId,
        relPath: `${dir}/${utility.scan}`,
        frozen: true,
        kindLabel: "scanned image of the same invoice; NOT docgraph-indexable, reachable only through the vision path",
        matchBasis: [`same invoice number (${utility.invoiceNo})`, "identical printed content"],
        locators: { invoice_no: utility.invoiceNo },
      });
    }
  }

  const waste = `${dir}/waste-fee-22-jun.txt`;
  builder.add({
    relPath: waste, frozen: true, disposition: "included",
    reason: "municipal waste fee instalment Q2/2026, notice dated 2026-06-22",
    eventId: `${period}-utilities-waste`, role: "primary",
    locators: { notice_no: "ТБО-2026-0455120", instalment: "Q2/2026" },
  });
  builder.event({
    id: `${period}-utilities-waste`, category: "Utilities", amount: 1500,
    transaction_date: "2026-06-22", document_date: "2026-06-22", due_date: "2026-06-30",
    service_period: null, merchant_or_provider: providers.waste.nameBg,
    evidence_kind: "notice", payment_status: "amount_due_documented",
    primary_document: waste, source_documents: [waste],
    source_locators: { notice_no: "ТБО-2026-0455120" },
    classification_reason: "municipal waste fee is folded into Utilities by benchmark policy rather than reported as its own category",
    verification_status: "benchmark-policy",
  });

  const statement = `${dir}/bank-statement-jun.txt`;
  builder.add({
    relPath: statement, frozen: true, disposition: "supporting_evidence",
    reason: "complete June 2026 statement for one account, intentionally limited to three card-payment rows; partial evidence of total household activity. Its own total debits (260.75) sit 0.25 BGN from the true Utilities total (260.50) BY DESIGN — an answer of exactly 260.75 means the model read only the statement",
    role: "statement", language: "en",
    locators: { iban: payer.iban, total_debits: 260.75 },
  });

  const fuelOne = `${dir}/fuel-receipt-09-jun.txt`;
  builder.add({
    relPath: fuelOne, frozen: true, disposition: "included",
    reason: "fuel purchase receipt; the same payment also appears as a bank-statement row",
    eventId: `${period}-fuel-09-jun`, role: "primary", language: "en",
    locators: { receipt_no: "0417-000239", auth: "004521" },
  });
  builder.event({
    id: `${period}-fuel-09-jun`, category: "Fuel", amount: 12000,
    transaction_date: "2026-06-09", document_date: "2026-06-09", due_date: null,
    service_period: null, merchant_or_provider: "PetrolMax, Fuel Station #17",
    evidence_kind: "fiscal_receipt", payment_status: "paid",
    primary_document: fuelOne, source_documents: [fuelOne],
    source_locators: { receipt_no: "0417-000239", card_suffix: "4417", auth: "004521" },
    on_bank_statement: statement,
    classification_reason: "vehicle fuel",
    verification_status: "verified-frozen",
  });
  attachRepresentation(builder, {
    eventId: `${period}-fuel-09-jun`,
    relPath: `${dir}/fuel-receipt-09-jun.png`,
    frozen: true,
    kindLabel: "scanned image of the same fuel receipt; vision path only (PNG is not docgraph-indexable)",
    matchBasis: ["same receipt number (0417-000239)", "identical printed content"],
    locators: { receipt_no: "0417-000239" },
  });
  builder.group({
    id: `${period}-fuel-09-jun-statement-overlap`,
    kind: "transaction",
    canonical_event: `${period}-fuel-09-jun`,
    count_once_bgn: 120.0,
    records: [fuelOne, `${statement}:2026-06-09:120.00`],
    match_basis: ["same merchant (PetrolMax)", "same transaction date (2026-06-09)", "same amount and currency", "compatible card-payment document role"],
    role: "adjudicated duplicate evidence for one economic event. The statement exposes neither the receipt's authorisation code nor its card suffix, so this is a benchmark adjudication, NOT a joined identity",
    verification_status: "adjudicated",
  });

  const fuelTwo = `${dir}/fuel-receipt-25-jun.txt`;
  builder.add({
    relPath: fuelTwo, frozen: true, disposition: "included",
    reason: "second fuel purchase; receipt-only, deliberately absent from the statement",
    eventId: `${period}-fuel-25-jun`, role: "primary", language: "en",
    locators: { receipt_no: "0422-000817", auth: "007213" },
  });
  builder.event({
    id: `${period}-fuel-25-jun`, category: "Fuel", amount: 9560,
    transaction_date: "2026-06-25", document_date: "2026-06-25", due_date: null,
    service_period: null, merchant_or_provider: "PetrolMax, Fuel Station #22",
    evidence_kind: "fiscal_receipt", payment_status: "paid",
    primary_document: fuelTwo, source_documents: [fuelTwo],
    source_locators: { receipt_no: "0422-000817", card_suffix: "4417", auth: "007213" },
    classification_reason: "vehicle fuel; a SEPARATE event from 09 June despite the same merchant and card suffix — merchant+card overlap is not identity",
    verification_status: "verified-frozen",
  });

  const groceries = [
    { id: "07-jun", date: "2026-06-07", amount: 8745, scan: "grocery-receipt-07-jun.png", merchant: "FreshMarket #218", receiptNo: "000218" },
    { id: "18-jun", date: "2026-06-18", amount: 5330, scan: "market-receipt-jun.png", merchant: "EuroMarket", receiptNo: "000842" },
  ];
  for (const grocery of groceries) {
    const eventId = `${period}-groceries-${grocery.id}`;
    const scanPath = `${dir}/${grocery.scan}`;
    builder.add({
      relPath: scanPath, frozen: true, disposition: "included",
      reason: "scanned grocery receipt; the same purchase also appears as a bank-statement row. PNG is not docgraph-indexable, so retrieval reaches this purchase through the statement and the scan only through vision",
      eventId, role: "primary",
      locators: { receipt_no: grocery.receiptNo },
    });
    builder.event({
      id: eventId, category: "Groceries", amount: grocery.amount,
      transaction_date: grocery.date, document_date: grocery.date, due_date: null,
      service_period: null, merchant_or_provider: grocery.merchant,
      evidence_kind: "fiscal_receipt", payment_status: "paid",
      primary_document: scanPath, source_documents: [scanPath],
      source_locators: { receipt_no: grocery.receiptNo, card_suffix: "4417" },
      on_bank_statement: statement,
      classification_reason: "supermarket food purchase",
      verification_status: "verified-frozen",
    });
    builder.group({
      id: `${eventId}-statement-overlap`,
      kind: "transaction",
      canonical_event: eventId,
      count_once_bgn: grocery.amount / 100,
      records: [scanPath, `${statement}:${grocery.date}:${money(grocery.amount, "en")}`],
      match_basis: ["same merchant/store", `same transaction date (${grocery.date})`, "same amount and currency", "card-payment role in both documents"],
      role: "one grocery event evidenced twice: a scan and a statement row",
      verification_status: "adjudicated",
    });
  }

  const transport = `${dir}/transport-topup-28-jun.txt`;
  builder.add({
    relPath: transport, frozen: true, disposition: "included",
    reason: "monthly public-transport card top-up",
    eventId: `${period}-transport`, role: "primary",
    locators: { receipt_no: "000015542" },
  });
  builder.event({
    id: `${period}-transport`, category: "Transport", amount: 5000,
    transaction_date: "2026-06-28", document_date: "2026-06-28", due_date: null,
    service_period: "2026-06", merchant_or_provider: providers.transport.nameBg,
    evidence_kind: "fiscal_receipt", payment_status: "paid",
    primary_document: transport, source_documents: [transport],
    source_locators: { receipt_no: "000015542", card_no: providers.transport.cardNo },
    classification_reason: "public-transport card top-up",
    verification_status: "verified-frozen",
  });

  const internet = `${dir}/internet-payment-12-jun.txt`;
  builder.add({
    relPath: internet, frozen: true, disposition: "included",
    reason: "completed payment order for the internet service. This is the corpus's missing-row trap: 29.99 exists ONLY here, in a filled payment form rather than an obvious 'bill' — a documented baseline probe missed it and reported 666.85 instead of 696.84",
    eventId: `${period}-internet`, role: "primary",
    locators: { client_no: "N-4821", payment_date: "2026-06-12" },
  });
  builder.event({
    id: `${period}-internet`, category: "Internet", amount: 2999,
    transaction_date: "2026-06-12", document_date: "2026-06-12", due_date: null,
    service_period: "2026-05", merchant_or_provider: providers.internet.nameBg,
    evidence_kind: "completed_payment_order", payment_status: "paid",
    primary_document: internet, source_documents: [internet],
    source_locators: { client_no: "N-4821" },
    classification_reason: "Internet is kept separate from Utilities by benchmark policy",
    verification_status: "benchmark-policy",
  });

  for (const notice of ["tax-increase-notice-bg-30-jun.txt", "tax-increase-notice-en-30-jun.txt"]) {
    builder.add({
      relPath: `${dir}/${notice}`, frozen: true, disposition: "informational",
      reason: "regulator's notice of a +7.4% utility tariff increase effective 2026-07-01; informational, not a transaction",
      role: "informational", language: notice.includes("-en-") ? "en" : "bg",
      locators: { ref: "REG-2026-0742", effective: "2026-07-01", rate_percent: 7.4 },
    });
  }

  for (const travel of frozenTravel) {
    builder.add({
      relPath: travel.path, frozen: true, disposition: "excluded_travel",
      reason: `personal travel (${travel.language}), denominated in ${travel.currency}; excluded from the BGN household total by declared benchmark policy and never converted`,
      role: "travel", language: travel.language,
      locators: { ref: travel.ref, currency: travel.currency, kind: travel.kind },
    });
    builder.event({
      id: `${period}-travel-${travel.ref}`, category: "Travel", amount: travel.amount,
      currency: travel.currency,
      transaction_date: travel.date, document_date: travel.date, due_date: null,
      service_period: null, merchant_or_provider: travel.merchant,
      evidence_kind: travel.kind === "hotel" ? "invoice" : "receipt",
      payment_status: "paid",
      primary_document: travel.path, source_documents: [travel.path],
      source_locators: { ref: travel.ref },
      excluded_from_bgn_total: true,
      language: travel.language,
      classification_reason: "travel spending, excluded from the household BGN total by benchmark policy",
      verification_status: "benchmark-policy",
    });
  }

  builder.statement = {
    document: statement,
    style: "full-month, card payments only",
    cutoff: null,
    total_debits_bgn: 260.75,
    on_statement: [
      `${dir}/grocery-receipt-07-jun.png`,
      `${dir}/fuel-receipt-09-jun.txt`,
      `${dir}/market-receipt-jun.png`,
    ],
    off_statement: [
      `${dir}/electricity-bill-03-jun.txt`,
      `${dir}/water-bill-05-jun.txt`,
      `${dir}/heating-bill-15-jun.txt`,
      `${dir}/waste-fee-22-jun.txt`,
      `${dir}/internet-payment-12-jun.txt`,
      `${dir}/fuel-receipt-25-jun.txt`,
      `${dir}/transport-topup-28-jun.txt`,
    ],
    off_statement_total_bgn: 436.09,
    reconciliation: "260.75 on-statement + 436.09 off-statement = 696.84 monthly total",
  };
  return builder;
}

/** Corpus-wide documents that belong to no single month. */
function buildSharedArtifacts() {
  return [
    {
      relPath: "templates/payment-form-blank.txt", frozen: true, format: "txt",
      period: null, disposition: "template",
      reason: "blank payment-order template; carries no amount and evidences no transaction",
      role: "template", language: "bg", indexable: true, locators: {}, eventId: null,
    },
    {
      relPath: "templates/payment-form-blank.docx", frozen: true, format: "docx",
      period: null, disposition: "template",
      reason: "blank payment-order template in DOCX; the fill-the-form scenario's input, not spending",
      role: "template", language: "bg", indexable: true, locators: {}, eventId: null,
    },
    {
      relPath: "trade-docs/commercial-invoice.txt", frozen: true, format: "txt",
      period: null, disposition: "excluded_commercial",
      reason: "B2B trade-finance invoice (Deutsche Edelstahl GmbH → Scandinavian Steel Importers AB, ~EUR 1.27M steel/freight): work material, not household spending. A recorded T-R5.2 run ranked this document inside the retrieval cap and reported it as a household spending category — a worse false positive than the travel leak that tier was designed to catch, so the fixture is kept deliberately",
      role: "commercial", language: "en", indexable: true, locators: { currency: "EUR", invoice_no: "INV-2026-06-5021" }, eventId: null,
    },
    {
      relPath: "trade-docs/swift-mt700.txt", frozen: true, format: "txt",
      period: null, disposition: "excluded_commercial",
      reason: "SWIFT MT700 letter-of-credit message accompanying the commercial invoice; B2B, not household spending",
      role: "commercial", language: "en", indexable: true, locators: {}, eventId: null,
    },
  ];
}

export function buildCorpus() {
  const builders = months.map((month, index) => month.frozen ? buildFrozenJune() : buildMonth(month, index));
  const artifacts = [];
  const events = [];
  const groups = [];
  const statements = {};
  for (const builder of builders) {
    artifacts.push(...builder.artifacts);
    events.push(...builder.events);
    groups.push(...builder.groups);
    if (builder.statement) statements[builder.period] = builder.statement;
  }
  artifacts.push(...buildSharedArtifacts());

  // Documents filed under a month they do not belong to (the cross-month trap)
  // are re-homed onto the period of the charge they evidence.
  for (const artifact of artifacts) {
    if (!artifact.eventId) continue;
    const event = events.find(candidate => candidate.id === artifact.eventId);
    if (event) artifact.period = event.period;
  }

  const periods = {};
  for (const builder of builders) {
    const periodEvents = events.filter(event => event.period === builder.period);
    const bgnEvents = periodEvents.filter(event => event.currency === "BGN" && !event.excluded_from_bgn_total);
    const categoryTotals = {};
    for (const event of bgnEvents) {
      categoryTotals[event.category] = (categoryTotals[event.category] ?? 0) + event.amount;
    }
    const otherCurrency = {};
    for (const event of periodEvents.filter(candidate => candidate.currency !== "BGN")) {
      otherCurrency[event.currency] = (otherCurrency[event.currency] ?? 0) + event.amount;
    }
    periods[builder.period] = {
      events: periodEvents,
      categoryTotals,
      monthlyTotal: sum(Object.values(categoryTotals)),
      otherCurrency,
      groups: groups.filter(group => group.period === builder.period),
      statement: statements[builder.period] ?? null,
    };
  }

  return { artifacts, events, groups, periods };
}

export { fileDate, fileMonth };
