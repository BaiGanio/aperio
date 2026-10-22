import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCategory, categoryByName, isCommercialDocument, detectEvidenceKind,
  extractLocators, extractMerchant, resolveAssignmentDate, createFact,
  settledServicePeriod, settledChargePeriod, shiftPeriod, extractBeneficiary,
  transliterate, merchantTokens, sharedMerchantTokens, withinOneEdit,
} from "../../../../lib/docgraph/facts/contract.js";
import { toMinor, fromMinor, sumMinor, formatMinor } from "../../../../lib/docgraph/facts/money.js";

describe("money in integer minor units", () => {
  test("adds without floating-point drift", () => {
    const values = [0.1, 0.2, 87.45, 53.30, 142.50, 38.20, 64.80, 15.00].map(v => toMinor(v, "BGN"));
    assert.equal(sumMinor(values), 40155);
    assert.equal(fromMinor(sumMinor(values), "BGN"), 401.55);
  });

  test("rounds half away from zero so credits and charges are symmetric", () => {
    assert.equal(toMinor(1.005, "BGN"), 101);
    assert.equal(toMinor(-1.005, "BGN"), -101);
    assert.equal(toMinor(1.15, "BGN"), 115);
    assert.equal(toMinor(-34.20, "BGN"), -3420);
  });

  test("honours zero-decimal and three-decimal currencies", () => {
    assert.equal(toMinor(1200, "JPY"), 1200);
    assert.equal(formatMinor(1200, "JPY"), "1200");
    assert.equal(toMinor(1.234, "KWD"), 1234);
    assert.equal(formatMinor(1234, "KWD"), "1.234");
  });

  test("rejects non-numeric input rather than coercing it", () => {
    assert.equal(toMinor(null, "BGN"), null);
    assert.equal(toMinor(NaN, "BGN"), null);
    assert.equal(toMinor("120.00", "BGN"), null);
  });
});

describe("category classification", () => {
  test("resolves Bulgarian and English household categories", () => {
    assert.equal(classifyCategory({ text: "ФАКТУРА ЗА ЕЛЕКТРОЕНЕРГИЯ\nСофияЕнерго ЕАД" }).category, "Utilities");
    assert.equal(classifyCategory({ text: "СЪОБЩЕНИЕ ЗА ТАКСА БИТОВИ ОТПАДЪЦИ" }).category, "Utilities");
    assert.equal(classifyCategory({ text: "PETROLMAX\nFuel Station #17" }).category, "Fuel");
    assert.equal(classifyCategory({ description: "FreshMarket #218 groceries" }).category, "Groceries");
    assert.equal(classifyCategory({ text: "ГРАДСКИ ТРАНСПОРТ СОФИЯ" }).category, "Transport");
  });

  test("prefers the specific category over the general one", () => {
    // An internet payment order names both "интернет" and generic bill words;
    // Internet must win over Utilities.
    const result = classifyCategory({ text: "ПЛАТЕЖНО НАРЕЖДАНЕ\nОснование: Интернет 05/2026, кл. № N-4821" });
    assert.equal(result.category, "Internet");
  });

  test("scores by pattern hits, not by which rule is listed first", () => {
    const result = classifyCategory({
      text: "PETROLMAX Fuel Station — бензин\nNote: near the supermarket",
    });
    assert.equal(result.category, "Fuel");
    assert.ok(result.runnersUp.includes("Groceries"));
  });

  test("matches an accented word like 'café' as Dining (regression: \\b is ASCII-only)", () => {
    // \bcafé\b previously could never match "café" itself — \b treats the
    // accented "é" as a non-word character, so the trailing \b demanded a
    // word character right after it, matching only "cafés" instead.
    assert.equal(classifyCategory({ text: "Café du Terminal — receipt" }).category, "Dining");
    assert.equal(classifyCategory({ text: "le café." }).category, "Dining");
    assert.equal(classifyCategory({ text: "CAFÉ CENTRAL" }).category, "Dining");
  });

  test("resolves foreign-language travel documents as Travel (regression: EUR docs used to land in Uncategorized)", () => {
    // Real fixture text from tests/fixtures/household-gen's frozen June travel
    // slice — a German train ticket, a German hotel bill, a French airport
    // receipt. All three used to score 0 (or, for the café, wrongly tie into
    // Dining) — see id/reference/tech-debt.md, "The EUR row lands as
    // Uncategorized".
    assert.equal(classifyCategory({
      text: "BahnReise AG\nFahrkarte / Ticket\nReisedatum: 14.06.2026\nKategorie: Reise / Transport",
      merchant: "BahnReise AG",
    }).category, "Travel");
    assert.equal(classifyCategory({
      text: "Hotel Lindenhof Berlin\nZimmer: 214 (Einzelzimmer) Nächte: 1\nKategorie: Reise / Unterkunft",
      merchant: "Hotel Lindenhof Berlin",
    }).category, "Travel");
    const cafeResult = classifyCategory({
      text: "Café du Terminal\nAéroport de Paris-Roissy CDG, Terminal 2E\nCatégorie: Voyage / Restauration",
      merchant: "Café du Terminal",
    });
    assert.equal(cafeResult.category, "Travel");
    assert.ok(cafeResult.runnersUp.includes("Dining"));
  });

  test("a local transit top-up still resolves as Transport, not Travel", () => {
    // Transport's own "travel card" pattern must keep winning this tie —
    // Travel's patterns deliberately exclude the bare word "travel" so it
    // never competes with a Sofia metro card top-up.
    const result = classifyCategory({ text: "ГРАДСКИ ТРАНСПОРТ СОФИЯ\nзареждане на карта\ntravel card top-up" });
    assert.equal(result.category, "Transport");
  });

  test("returns null rather than guessing when nothing matches", () => {
    assert.equal(classifyCategory({ text: "Notice of scheduled building maintenance" }).category, null);
    assert.equal(classifyCategory({}).category, null);
  });

  test("resolves a category named directly by a structured column", () => {
    assert.equal(categoryByName("Groceries"), "Groceries");
    assert.equal(categoryByName(" utilities "), "Utilities");
    assert.equal(categoryByName("Kittens"), null);
    assert.equal(categoryByName(null), null);
  });
});

describe("commercial-document detection", () => {
  test("flags trade finance on two independent signals", () => {
    assert.equal(isCommercialDocument("COMMERCIAL INVOICE\nIncoterms: CIF Göteborg"), true);
    assert.equal(isCommercialDocument("SWIFT MT700 — ISSUE OF A DOCUMENTARY CREDIT\nConsignee: ..."), true);
  });

  test("does not flag a household invoice that merely says 'invoice'", () => {
    assert.equal(isCommercialDocument("ФАКТУРА ЗА ЕЛЕКТРОЕНЕРГИЯ\nФактура №: 0000451287"), false);
    assert.equal(isCommercialDocument("Invoice for water supply\nAmount due: 38.20"), false);
  });
});

describe("document metadata", () => {
  test("detects evidence kind, most specific first", () => {
    assert.equal(detectEvidenceKind("ПЛАТЕЖНО НАРЕЖДАНЕ / ВНОСНА БЕЛЕЖКА\nФактура № 12"), "payment_order");
    assert.equal(detectEvidenceKind("FISCAL RECEIPT\nPump: 4"), "receipt");
    assert.equal(detectEvidenceKind("ФАКТУРА ЗА ВОДОСНАБДЯВАНЕ"), "invoice");
    assert.equal(detectEvidenceKind("СЪОБЩЕНИЕ ЗА ТАКСА"), "notice");
    assert.equal(detectEvidenceKind("hello"), "unknown");
  });

  test("extracts shared identifiers in both languages", () => {
    assert.deepEqual(extractLocators("Фактура №:  0000451287"), { invoice_no: "0000451287" });
    assert.deepEqual(extractLocators("Receipt No: 0417-000239"), { receipt_no: "0417-000239" });
    assert.deepEqual(extractLocators("nothing here"), {});
  });

  test("reads the provider from the header and un-spaces receipt titles", () => {
    assert.equal(extractMerchant("СофияЕнерго ЕАД\nПродажба на..."), "СофияЕнерго ЕАД");
    assert.equal(extractMerchant("=====\n   P E T R O L M A X\n  Fuel Station"), "PETROLMAX");
    assert.equal(extractMerchant(""), null);
  });
});

describe("merchant matching across scripts", () => {
  test("transliterates Bulgarian Cyrillic to Latin", () => {
    assert.equal(transliterate("МобиТел"), "mobitel");
    assert.equal(transliterate("ТоплоСофия"), "toplosofiya");
    assert.equal(transliterate("ЩЖЦЧШЮЯ"), "shtzhtschshyuya");
    assert.equal(transliterate("FreshMarket"), "freshmarket");
  });

  test("matches the same provider written in either script", () => {
    // The statement prints "MobiTel prepaid top-up"; the till receipt prints
    // "МобиТел ЕАД". Without this the top-up is counted twice.
    const shared = sharedMerchantTokens(
      merchantTokens("MobiTel prepaid top-up"), merchantTokens("МобиТел ЕАД (примерен)"));
    assert.deepEqual(shared.map(s => s.token), ["mobitel"]);
    assert.equal(shared[0].exact, true);
  });

  test("tolerates one character, because transliteration is not one-to-one", () => {
    // "ЕВРОМАРКЕТ" → "evromarket"; the statement says "EuroMarket".
    const shared = sharedMerchantTokens(
      merchantTokens("EuroMarket groceries"), merchantTokens("ЕВРОМАРКЕТ #41"));
    assert.equal(shared.length, 1);
    assert.equal(shared[0].exact, false);
    assert.equal(shared[0].other, "evromarket");
  });

  test("keeps short tokens exact — one edit is too much of a short word", () => {
    assert.deepEqual(sharedMerchantTokens(["shop"], ["chop"]), []);
    assert.deepEqual(sharedMerchantTokens(["shop"], ["shop"]).map(s => s.token), ["shop"]);
  });

  test("finds no overlap between genuinely different merchants", () => {
    assert.deepEqual(sharedMerchantTokens(merchantTokens("PetrolMax"), merchantTokens("FreshMarket")), []);
  });

  test("counts insertions, deletions and substitutions alike", () => {
    assert.equal(withinOneEdit("evromarket", "euromarket"), true);  // substitution
    assert.equal(withinOneEdit("market", "markets"), true);         // insertion
    assert.equal(withinOneEdit("markets", "market"), true);         // deletion
    assert.equal(withinOneEdit("market", "market"), true);
    assert.equal(withinOneEdit("market", "basket"), false);         // two edits
    assert.equal(withinOneEdit("abc", "abcde"), false);             // length gap
  });
});

describe("period assignment", () => {
  const high = (role, value) => ({ role, value, confidence: "high" });

  test("uses the issue date, never the service period it bills", () => {
    // The electricity bill is issued 2026-06-03 for May consumption. Keying
    // on the service period would file every utility bill a month early.
    const dates = [
      high("service_period_start", "2026-05-01"),
      high("invoice_date", "2026-06-03"),
      high("due_date", "2026-06-20"),
      high("service_period_end", "2026-05-31"),
    ];
    const resolved = resolveAssignmentDate(dates);
    assert.equal(resolved.date, "2026-06-03");
    assert.equal(resolved.source, "invoice_date");
    assert.equal(resolved.confidence, "high");
  });

  test("prefers a receipt's own transaction date above every other role", () => {
    const resolved = resolveAssignmentDate([high("invoice_date", "2026-06-03"), high("receipt_date", "2026-06-25")]);
    assert.equal(resolved.date, "2026-06-25");
    assert.equal(resolved.source, "receipt_date");
  });

  test("prefers the specific issue date over a generic document date", () => {
    const resolved = resolveAssignmentDate([high("document_date", "2026-06-22"), high("invoice_date", "2026-06-03")]);
    assert.equal(resolved.date, "2026-06-03");
  });

  test("does not let a payment date move the charge it settles", () => {
    // A January heating bill paid on 04.02.2026 belongs to January.
    const resolved = resolveAssignmentDate([high("payment_date", "2026-02-04"), high("invoice_date", "2026-01-18")]);
    assert.equal(resolved.date, "2026-01-18");
  });

  test("accepts unlabelled receipt dates when they agree on one month", () => {
    const resolved = resolveAssignmentDate([
      { role: "unlabeled_date", value: "2026-06-09", confidence: "low" },
      { role: "unlabeled_date", value: "2026-06-09", confidence: "low" },
    ]);
    assert.equal(resolved.date, "2026-06-09");
    assert.equal(resolved.confidence, "low");
  });

  test("falls back to the due date only as a last resort", () => {
    const resolved = resolveAssignmentDate([high("due_date", "2026-06-30")]);
    assert.equal(resolved.date, "2026-06-30");
    assert.equal(resolved.source, "due_date");
    assert.equal(resolved.confidence, "low");
  });

  test("reports ambiguity instead of picking one of two issue dates", () => {
    const resolved = resolveAssignmentDate([high("invoice_date", "2026-06-03"), high("invoice_date", "2026-06-19")]);
    assert.equal(resolved.date, null);
    assert.match(resolved.issue, /multiple distinct invoice_date/);
  });

  test("disambiguates conflicting unlabelled dates with the filename", () => {
    const resolved = resolveAssignmentDate([
      { role: "unlabeled_date", value: "2026-05-31", confidence: "low" },
      { role: "unlabeled_date", value: "2026-06-09", confidence: "low" },
    ], { filenameHint: "2026-06" });
    assert.equal(resolved.date, "2026-06-09");
  });

  test("reports no usable date rather than inventing one", () => {
    assert.equal(resolveAssignmentDate([]).date, null);
    assert.match(resolveAssignmentDate([]).issue, /no usable date/);
  });
});

describe("payment orders settle a charge rather than creating one", () => {
  const HEATING_PAYMENT = [
    "ПЛАТЕЖНО НАРЕЖДАНЕ / ВНОСНА БЕЛЕЖКА",
    "ПОЛУЧАТЕЛ (Beneficiary)",
    "  Име (Name):                 ТоплоСофия ЕАД",
    "  IBAN на получателя:         BG64STSA93000112345678",
    "ПЛАЩАНЕ (Payment)",
    "  Сума (Amount):        235,27",
    "  Валута (Currency):          BGN",
    "  Основание (Payment details):Парно 12/2025, аб. № 8800123",
    "  Дата (Date):                04.02.2026",
  ].join("\n");

  test("reads the settled service period from the basis line", () => {
    assert.equal(settledServicePeriod(HEATING_PAYMENT), "2025-12");
    assert.equal(settledServicePeriod("Основание за плащане: Интернет 05/2026, кл. № N-4821"), "2026-05");
    // A period-shaped number outside the basis line is not a period.
    assert.equal(settledServicePeriod("IBAN: BG80 12/2025 ...\nno basis line here"), null);
    assert.equal(settledServicePeriod("Основание: Парно, аб. № 8800123"), null);
  });

  test("files the charge in the month it was issued, not the month it was paid", () => {
    // December consumption → the bill is issued in January → paid 04.02.2026.
    assert.equal(settledChargePeriod(HEATING_PAYMENT, "2026-02-04"), "2026-01");
  });

  test("keeps a payment made in the charge's own month where it is", () => {
    // June's internet payment: May service, issued and paid in June.
    const form = "Основание (Payment details):Интернет 05/2026, кл. № N-4821";
    assert.equal(settledChargePeriod(form, "2026-06-12"), "2026-06");
  });

  test("never places a charge after the payment that settled it", () => {
    // A prepayment inside the service period must not be pushed into a
    // future month by the "issued the month after" bound.
    assert.equal(settledChargePeriod("Основание: Парно 05/2026", "2026-05-28"), "2026-05");
  });

  test("infers nothing when the basis names no period", () => {
    assert.equal(settledChargePeriod("Основание: Парно, аб. № 8800123", "2026-02-04"), null);
  });

  test("shifts periods across a year boundary", () => {
    assert.equal(shiftPeriod("2025-12", 1), "2026-01");
    assert.equal(shiftPeriod("2026-01", -1), "2025-12");
    assert.equal(shiftPeriod("2026-06", 1), "2026-07");
  });

  test("reads the provider being paid, not the form's own title", () => {
    assert.equal(extractBeneficiary(HEATING_PAYMENT), "ТоплоСофия ЕАД");
    assert.equal(extractBeneficiary("FISCAL RECEIPT\nTOTAL 120.00"), null);
  });
});

describe("fact construction refuses to guess", () => {
  const base = { document: "a.txt", amount: 120, currency: "BGN", assignmentDate: "2026-06-09" };

  test("builds a fact with a derived period in minor units", () => {
    const { fact } = createFact(base);
    assert.equal(fact.amount_minor, 12000);
    assert.equal(fact.period, "2026-06");
  });

  test("rejects an amount with no resolvable currency", () => {
    const { fact, issue } = createFact({ ...base, currency: null });
    assert.equal(fact, undefined);
    assert.equal(issue.reason, "no_currency");
  });

  test("rejects a charge whose month cannot be established", () => {
    const { fact, issue } = createFact({ ...base, assignmentDate: null });
    assert.equal(fact, undefined);
    assert.equal(issue.reason, "no_period");
  });
});
