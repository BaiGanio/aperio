// Renderers for the Bulgarian household documents. Layout deliberately mirrors
// the frozen June 2026 documents so that a fact extractor sees the same label
// shapes in every month — the corpus tests extraction, not layout diversity.
//
// Every function here is pure formatting. All arithmetic happens in build.mjs
// and arrives pre-computed in minor units.

import { money, pad, padEnd, dotted, rule, bgMonthName, serviceMarker } from "./money.mjs";
import { payer, providers, merchants } from "./spec.mjs";

const FICTION_BG = `Фиктивен примерен документ за демонстрационни цели.
Всички имена, адреси и банкови сметки са измислени.`;

const line = rule(60);
const STATEMENT_WIDTH = 77;

function header(provider) {
  return [
    provider.nameBg,
    provider.activityBg,
    "",
    provider.addressBg,
    `ЕИК: ${provider.eik}   ДДС №: ${provider.vat}`,
    `Контакт: ${provider.contact}`,
    "",
    "",
  ].join("\n");
}

/** Right-align `value` so its last character lands on 1-based `column`. */
function rightAlign(label, value, column) {
  const text = String(value);
  return label + text.padStart(Math.max(1, column - label.length), " ");
}

// The frozen bills right-align "<amount> лв" to column 56. Reproduced exactly so
// that a label/amount extractor sees identical geometry in every month.
const AMOUNT_COLUMN = 56;

function amountLine(label, minorUnits, column = AMOUNT_COLUMN) {
  const value = `${money(minorUnits)} лв`;
  return label + value.padStart(Math.max(1, column - label.length), " ");
}

function netVatTotal({ net, vat, total }) {
  return [
    line,
    amountLine("Стойност без ДДС:", net),
    amountLine("ДДС 20%:", vat),
    amountLine("ЗА ПЛАЩАНЕ (с ДДС):", total),
    line,
  ].join("\n");
}

export function electricityBill(model) {
  const p = providers.electricity;
  return `${header(p)}${line}
ФАКТУРА ЗА ЕЛЕКТРОЕНЕРГИЯ
${line}

Фактура №:            ${model.invoiceNo}
Дата на издаване:     ${dotted(model.issue)}
Период на отчитане:   ${dotted(model.periodStart)} – ${dotted(model.periodEnd)}
Краен срок за плащане: ${dotted(model.due)}

Клиент:               ${payer.nameBg}
Клиентски номер:      ${p.clientNo}
Адрес на потребление: ${payer.addressBg}
Измервателна точка:   ${p.meterPoint}

${line}
ОТЧЕТ НА ПОТРЕБЛЕНИЕТО
${line}

Предходен отчет (${dotted(model.prevDate)}):     ${model.prevReadingText} kWh
Настоящ отчет (${dotted(model.periodEnd)}):       ${model.currReadingText} kWh
${rightAlign("Изразходвана енергия:", model.consumedKwh, 40)} kWh

Дневна тарифа:      ${pad(model.dayKwh, 3)} kWh  x ${model.dayRateText} лв/kWh  =  ${money(model.dayCost)} лв
Нощна тарифа:       ${pad(model.nightKwh, 3)} kWh  x ${model.nightRateText} лв/kWh  =  ${money(model.nightCost)} лв
Мрежови услуги (пренос и достъп):            =  ${money(model.grid)} лв
Задължения към обществото:                   =   ${money(model.obligations)} лв
Акциз:                                       =   ${money(model.excise)} лв

${netVatTotal(model)}

Основание за плащане: Ел. енергия ${serviceMarker(model.servicePeriod)}, кл. № ${p.clientNo}
IBAN на доставчика:   ${p.iban}
BIC:                  ${p.bic}
${model.tariffNote ? `\n${model.tariffNote}\n` : ""}
${FICTION_BG}
`;
}

export function waterBill(model) {
  const p = providers.water;
  const extras = (model.extras ?? [])
    .map(extra => amountLine(`${extra.labelBg}:`, extra.amount))
    .join("\n");
  return `${header(p)}${line}
ФАКТУРА ЗА ВОДОСНАБДЯВАНЕ И КАНАЛИЗАЦИЯ
${line}

Фактура №:            ${model.invoiceNo}
Дата на издаване:     ${dotted(model.issue)}
Период на отчитане:   ${dotted(model.periodStart)} – ${dotted(model.periodEnd)}
Краен срок за плащане: ${dotted(model.due)}

Клиент:               ${payer.nameBg}
Клиентски номер:      ${p.clientNo}
Адрес:                ${payer.addressBg}
Измервателен уред:    ${p.meterNo}

${line}
ОТЧЕТ НА ПОТРЕБЛЕНИЕТО
${line}

Предходен отчет (${dotted(model.prevDate)}):     ${model.prevReadingText} куб.м
Настоящ отчет (${dotted(model.periodEnd)}):       ${model.currReadingText} куб.м
Изразходвана вода:                     ${model.cubic} куб.м

Доставяне на вода:    ${model.cubic} куб.м x ${money(Math.round(model.rates.deliver * 100))} лв   =  ${money(model.deliverCost)} лв
Отвеждане (канал):    ${model.cubic} куб.м x ${money(Math.round(model.rates.sewer * 100))} лв   =   ${money(model.sewerCost)} лв
Пречистване:          ${model.cubic} куб.м x ${money(Math.round(model.rates.treat * 100))} лв   =  ${money(model.treatCost)} лв
${extras ? `\n${extras}\n` : ""}
${netVatTotal(model)}

Основание за плащане: Вода ${serviceMarker(model.servicePeriod)}, кл. № ${p.clientNo}
IBAN на доставчика:   ${p.iban}
BIC:                  ${p.bic}
${model.tariffNote ? `\n${model.tariffNote}\n` : ""}
${FICTION_BG}
`;
}

export function heatingBill(model) {
  const p = providers.heating;
  const heatLine = model.mwh > 0
    ? `Топлинна енергия за отопление:     ${model.mwhText} MWh x ${money(model.perMwh)} лв  =  ${money(model.heatCost)} лв`
    : `Топлинна енергия за отопление:     0,000 MWh (извън сезон)      =   0,00 лв`;
  return `${header(p)}${line}
ФАКТУРА ЗА ТОПЛИННА ЕНЕРГИЯ
${line}

Фактура №:            ${model.invoiceNo}
Дата на издаване:     ${dotted(model.issue)}
Период на отчитане:   ${dotted(model.periodStart)} – ${dotted(model.periodEnd)}
Краен срок за плащане: ${dotted(model.due)}

Клиент:               ${payer.nameBg}
Абонатен номер:       ${p.clientNo}
Адрес:                ${payer.addressBg}

${line}
ОТЧЕТ
${line}

${heatLine}
Енергия за подгряване на вода:                            =   ${money(model.hotWater)} лв
Такса дялово разпределение:                               =   ${money(model.distribution)} лв
${model.note ? `\nЗабележка: ${model.note}.\n` : ""}
${netVatTotal(model)}

Основание за плащане: Парно ${serviceMarker(model.servicePeriod)}, аб. № ${p.clientNo}
IBAN на доставчика:   ${p.iban}
BIC:                  ${p.bic}

${FICTION_BG}
`;
}

export function wasteNotice(model) {
  const p = providers.waste;
  return `${p.nameBg}
${p.unitBg}

${p.addressBg}
ЕИК: ${p.eik}

${line}
СЪОБЩЕНИЕ ЗА ТАКСА БИТОВИ ОТПАДЪЦИ
${line}

Съобщение №:          ${model.noticeNo}
Дата:                 ${dotted(model.date)}
Вноска:               ${model.quarter}
Краен срок:           ${dotted(model.due)}

Задължено лице:       ${payer.nameBg}
Партиден номер:       ${p.accountNo}
Имот:                 ${payer.addressBg}

${line}
Такса битови отпадъци (сметосъбиране,
${amountLine("сметоизвозване и поддържане на чистота):", model.amount)}
${line}
${amountLine("ЗА ПЛАЩАНЕ:", model.amount)}
${line}

Забележка: Таксата не подлежи на облагане с ДДС.
Основание за плащане: ТБО ${model.quarterShort}, ${p.accountNo}
IBAN на общината:     ${p.iban}

Фиктивен примерен документ за демонстрационни цели.
Всички имена, адреси и партидни номера са измислени.
`;
}

/** A credit note: a negative Utilities amount that must reduce the total. */
export function creditNote(model) {
  const p = providers[model.provider];
  return `${header(p)}${line}
КРЕДИТНО ИЗВЕСТИЕ КЪМ ФАКТУРА
${line}

Кредитно известие №:  ${model.noticeNo}
Дата на издаване:     ${dotted(model.date)}
Към фактура №:        ${model.referencesInvoiceNo} от ${dotted(model.referencesInvoiceDate)}

Клиент:               ${payer.nameBg}
Клиентски номер:      ${p.clientNo}
Адрес:                ${payer.addressBg}

${line}
ОСНОВАНИЕ ЗА КОРЕКЦИЯ
${line}

${model.reasonBg}

${line}
${amountLine("Стойност без ДДС:", model.net)}
${amountLine("ДДС 20%:", model.vat)}
${amountLine("СУМА ЗА ВЪЗСТАНОВЯВАНЕ (с ДДС):", model.total)}
${line}

Забележка: Сумата е кредитна (в намаление). Приспада се от
следващото задължение или се възстановява по сметка на клиента.

${FICTION_BG}
`;
}

/** Completed payment order. Same body is reused for the .docx variant. */
export function paymentForm(model) {
  return `ПЛАТЕЖНО НАРЕЖДАНЕ / ВНОСНА БЕЛЕЖКА
Payment order (completed — ${model.subjectEn})

За кредитен превод в лева / For BGN credit transfer

${rule(61)}
НАРЕДИТЕЛ (Payer)
${rule(61)}
  Име (Name):                 ${payer.nameBg}
  Адрес (Address):            ${payer.addressBg}
  IBAN на наредителя:         ${payer.iban}
  Банка / BIC:                ${payer.bankBg} / ${payer.bic}

${rule(61)}
ПОЛУЧАТЕЛ (Beneficiary)
${rule(61)}
  Име (Name):                 ${model.payeeName}
  IBAN на получателя:         ${model.payeeIban}
  Банка / BIC:                ${model.payeeBank} / ${model.payeeBic}

${rule(61)}
ПЛАЩАНЕ (Payment)
${rule(61)}
  Сума (Amount):              ${money(model.amount)}
  Валута (Currency):          BGN
  Основание (Payment details):${model.reason}
  Клиентски номер (Client No): ${model.clientNo}
  Дата (Date):                ${dotted(model.date)}

  Подпис на наредителя (Signature): И. Петров

${rule(61)}
Фиктивен примерен формуляр за демонстрационни цели.
Fictional sample form for demonstration purposes.
`;
}

export function transportTopup(model) {
  const p = providers.transport;
  return `${p.nameBg}
${p.unitBg}

${p.addressBg}
ЕИК: ${p.eik}

${rule(43)}
 КАСОВ БОН - ЗАРЕЖДАНЕ НА КАРТА
${rule(43)}
 Дата: ${dotted(model.date)}        Час: ${model.time}
 Бон №: ${model.receiptNo}
 Каса: ${model.machine}
${rule(43)}
 Карта №:            ${p.cardNo}
 Титуляр:            ${payer.nameBg}
${rule(43)}
 Зареждане на превозен документ
 (30-дневна карта, всички линии)     ${money(model.amount)}
${rule(43)}
 Категория: Транспорт
 ЗА ПЛАЩАНЕ:                         ${money(model.amount)} лв
${rule(43)}
 Плащане с карта ....... ${money(model.amount)} лв
${rule(43)}

 Основание: Градски транспорт ${serviceMarker(model.period)}
 Забележка: примерен фиктивен документ.
 Всички данни са измислени.
`;
}

const FUEL_PRODUCTS = {
  diesel: { label: "Diesel B7" },
  a95: { label: "Gasoline A95" },
};

export function fuelReceipt(model) {
  const p = providers.fuel;
  const product = FUEL_PRODUCTS[model.product] ?? FUEL_PRODUCTS.diesel;
  return `        P E T R O L M A X
     Fuel Station #${model.station} - Sofia
   ${model.stationAddress}
       VAT No: ${p.vat}
       Tel: ${p.tel}

${rule(41)}
 FISCAL RECEIPT
${rule(41)}
 Date: ${dotted(model.date)}        Time: ${model.time}
 Receipt No: ${model.receiptNo}
 Pump: ${model.pump}     Operator: ${String(model.operator).padStart(2, "0")}
${rule(41)}
 Item                 Qty        Amount
${rule(41)}
 ${padEnd(product.label, 17)} ${pad(model.litersText, 5)} L      ${money(model.total, "en")}
   Unit price:  ${model.unitPriceText} BGN / L
${rule(41)}
 Category: Fuel
 Subtotal (excl. VAT):         ${pad(money(model.net, "en"), 6)}
 VAT 20%:                       ${pad(money(model.vat, "en"), 6)}
 TOTAL:                        ${pad(money(model.total, "en"), 7)} BGN
${rule(41)}
 Paid by card ....... ${money(model.total, "en")} BGN
 VISA **** ${payer.cardSuffix}   AUTH ${model.auth}
${rule(41)}

   Thank you for your visit!

 Fictional sample receipt for demo use.
 All data is invented.
`;
}

/**
 * Fiscal receipt for a shop: groceries, pharmacy, restaurant, retail, service.
 * `model.lines` are pre-balanced by build.mjs so they sum to `model.total`.
 */
export function shopReceipt(model) {
  const shop = merchants[model.merchant];
  const store = shop.store ? ` ${shop.store}` : "";
  const lines = model.lines
    .map(item => ` ${padEnd(item.nameBg, 30)}${pad(money(item.amount), 9)}`)
    .join("\n");
  const paid = model.card
    ? ` Плащане с карта ...... ${money(model.total)} лв\n VISA **** ${payer.cardSuffix}   AUTH ${model.auth}`
    : ` Плащане в брой ....... ${money(model.total)} лв`;
  return `${shop.nameBg}${store}
${shop.addressBg}
ЕИК: ${shop.eik}

${rule(41)}
 ФИСКАЛЕН БОН
${rule(41)}
 Дата: ${dotted(model.date)}        Час: ${model.time}
 Бон №: ${model.receiptNo}
${model.operatorLine ? ` ${model.operatorLine}\n` : ""}${rule(41)}
 Артикул                          Сума
${rule(41)}
${lines}
${rule(41)}
 Категория: ${model.categoryBg}
 Междинна сума без ДДС:      ${pad(money(model.net), 9)}
 ДДС 20%:                    ${pad(money(model.vat), 9)}
 ОБЩА СУМА:                  ${pad(money(model.total), 9)} лв
${rule(41)}
${paid}
${rule(41)}
${model.note ? `\n Забележка: ${model.note}\n` : ""}
 Благодарим Ви!
 Примерен фиктивен документ. Всички данни са измислени.
`;
}

/** Insurance premium invoice — an annual charge inside a single month. */
export function insuranceInvoice(model) {
  const p = providers.insurance;
  return `${p.nameBg}
Общо застраховане

ул. Позитано 3, 1000 София
ЕИК: ${p.eik}

${line}
СМЕТКА / ФАКТУРА ЗА ЗАСТРАХОВАТЕЛНА ПРЕМИЯ
${line}

Полица №:             ${p.policyNo}
Вид застраховка:      „Дом+“ — имущество, домашно имущество
Дата на издаване:     ${dotted(model.date)}
Срок на покритие:     ${dotted(model.coverage.start)} – ${dotted(model.coverage.end)}

Застрахован:          ${payer.nameBg}
Адрес на имота:       ${payer.addressBg}

${line}
${amountLine("Годишна премия (еднократно плащане):", model.total)}
${line}
${amountLine("ЗА ПЛАЩАНЕ:", model.total)}
${line}

Забележка: Премията е за целия 12-месечен срок на покритие и се
дължи еднократно при издаване на полицата. Застрахователните
премии не се облагат с ДДС.

Основание за плащане: Премия полица ${p.policyNo}
IBAN на застрахователя: ${p.iban}

${FICTION_BG}
`;
}

/** Prepaid mobile top-up voucher. */
export function mobileTopup(model) {
  const p = providers.mobile;
  return `${p.nameBg}
Предплатена услуга — зареждане на сметка

ЕИК: ${p.eik}

${rule(41)}
 КАСОВ БОН — ПРЕДПЛАТЕНО ЗАРЕЖДАНЕ
${rule(41)}
 Дата: ${dotted(model.date)}        Час: ${model.time}
 Бон №: ${model.receiptNo}
${rule(41)}
 Абонатен номер:     ${p.clientNo}
 Титуляр:            ${payer.nameBg}
${rule(41)}
 Зареждане предплатена сметка        ${money(model.total)}
${rule(41)}
 Категория: Мобилни услуги
 ЗА ПЛАЩАНЕ:                         ${money(model.total)} лв
${rule(41)}
 Плащане с карта ...... ${money(model.total)} лв
 VISA **** ${payer.cardSuffix}   AUTH ${model.auth}
${rule(41)}

 Забележка: Зареждането е предплатено и не е месечен абонамент.
 Примерен фиктивен документ. Всички данни са измислени.
`;
}

/** Regulatory tariff-change notice (informational, not a transaction). */
export function regulatoryNotice(model) {
  return `КОМИСИЯ ЗА ЕНЕРГИЙНО И ВОДНО РЕГУЛИРАНЕ (примерна)
Официално съобщение до потребителите

Дата: ${dotted(model.date)}
Изх. №: ${model.ref}

ОТНОСНО: Изменение на регулираните цени на комунални услуги

Уважаеми потребители,

Уведомяваме Ви, че от ${dotted(model.effective)} регулираните цени на
следните комунални услуги се увеличават с ${money(Math.round(model.ratePercent * 100))} %
(${model.rateWords}):

  - електрическа енергия за битови нужди
  - водоснабдяване и канализация
  - централно топлоснабдяване

Увеличението се отнася само до изброените услуги. Цените на
горива, хранителни стоки, интернет и градски транспорт не се
променят с настоящото решение. Местните такси (в т.ч. такса
битови отпадъци) не са предмет на това решение.

Примерно изчисление: за всеки 100,00 лв месечен разход по
засегнатите услуги увеличението води до допълнителни
${money(Math.round(model.ratePercent * 100))} лв на месец (нова сума ${money(10000 + Math.round(model.ratePercent * 100))} лв).

Съобщението е с информативен характер. За точните суми, моля
вижте следващата си месечна фактура.

Фиктивен примерен документ за демонстрационни цели.
Имената, номерата и данните са измислени.
`;
}

/**
 * Monthly bank statement. Partial by construction: either a mid-month cut-off
 * (`coverEnd`) or a full month that still excludes counter/transfer/cash
 * payments. Rendered in English, like the frozen June statement.
 */
export function bankStatement(model) {
  // The frozen June statement is 77 columns wide with amounts ending on column
  // 77; reproduced so a table parser sees one geometry across every month.
  const rows = model.rows
    .map(row => rightAlign(
      ` ${dotted(row.date)}  ${padEnd(row.description, 38)}${padEnd(row.category, 12)}`,
      `-${money(row.amount, "en")}`,
      STATEMENT_WIDTH,
    ))
    .join("\n");
  const scope = model.coverEnd
    ? `Statement period: ${dotted(model.periodStart)} – ${dotted(model.cutoff)} (interim extract)`
    : `Statement period: ${dotted(model.periodStart)} – ${dotted(model.periodEnd)}`;
  const note = model.coverEnd
    ? `Note: this is an INTERIM extract. It covers card payments made from this
account up to and including ${dotted(model.cutoff)} only. Card payments made later in
the month, utility bills settled at the counter or by bank transfer form,
and cash payments are not shown here. Please refer to the individual
invoices, notices and receipts for those amounts.`
    : `Note: this statement reflects card payments made from this account only.
Utility bills settled at the counter or by bank transfer form, payments
made in cash, and purchases settled from other accounts or in foreign
currency are not shown here. Please refer to the individual invoices,
notices and receipts for those amounts.`;
  return `FIRST DIGITAL BANK
Account Statement

Account holder:   ${payer.nameEn}
Address:          ${payer.addressEn}
IBAN:             ${payer.iban}
Currency:         BGN
${scope}
Opening balance:  ${money(model.opening, "en")} BGN
Closing balance:  ${money(model.closing, "en")} BGN

${rule(STATEMENT_WIDTH, "=")}
 Date        Description                          Category      Amount (BGN)
${rule(STATEMENT_WIDTH)}
${rows}
${rule(STATEMENT_WIDTH)}
${rightAlign(" Total debits for period", `-${money(model.totalDebits, "en")}`, STATEMENT_WIDTH)}
${rule(STATEMENT_WIDTH, "=")}

${note}

This is a fictional sample statement generated for demonstration purposes.
All names, addresses, IBANs and transactions are invented.
`;
}

/** The planned-budget sheet's rows; the XLSX writer consumes this. */
export function budgetRows(model) {
  return model.rows.map(row => [row.category, row.planned / 100, row.note ?? ""]);
}

export function monthTitleBg(period) {
  const [year, month] = period.split("-").map(Number);
  return `${bgMonthName(month)} ${year}`;
}
