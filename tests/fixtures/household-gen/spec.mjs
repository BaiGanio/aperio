// Declarative corpus specification: the single source of truth from which BOTH
// the household documents and the ground-truth oracle are derived. Nothing here
// is random — regenerating produces byte-identical documents.
//
// Frozen slices (authored by hand before this generator existed, never
// rewritten): 2026/June/*, three 2026/July bills, 2026/May/water-payment-12-may.txt
// and templates/*. They appear below with `frozen: true` and carry only the
// metadata the oracle needs; the generator refuses to write over them.
//
// Tariffs step twice: +4.8% on 2026-01-01 and +7.4% on 2026-07-01 (the latter is
// the increase the corpus's own regulatory notice announces). Both steps are
// reproducible from the rates below, so a bill's arithmetic can be re-checked
// against its own issue date.

export const payer = {
  nameBg: "Иван Петров",
  nameEn: "Ivan Petrov",
  addressBg: "ул. Витоша 15, ет. 3, ап. 7, 1000 София",
  addressEn: "15 Vitosha St, fl. 3, apt. 7, 1000 Sofia, Bulgaria",
  iban: "BG80BNBG96611020345678",
  bankBg: "Първа Дигитална Банка",
  bankEn: "First Digital Bank",
  bic: "BNBGBGSD",
  cardSuffix: "4417",
};

export const providers = {
  electricity: {
    nameBg: "СофияЕнерго ЕАД",
    activityBg: "Продажба на електрическа енергия",
    addressBg: "ул. Позитано 8, 1000 София",
    eik: "200123456",
    vat: "BG200123456",
    contact: "0700 12 345   info@sofiaenergo.example",
    iban: "BG18RZBB91550123456789",
    bic: "RZBBBGSF",
    clientNo: "3001234567",
    meterPoint: "32Z000000012345K",
    domain: "sofiaenergo.example",
  },
  water: {
    nameBg: "ВодаСофия ЕАД",
    activityBg: "Доставка на вода и канализация",
    addressBg: "ул. Раковски 22, 1000 София",
    eik: "201234567",
    vat: "BG201234567",
    contact: "0700 22 333   info@vodasofia.example",
    iban: "BG54UNCR70001512345678",
    bic: "UNCRBGSF",
    clientNo: "700556677",
    meterNo: "W-4471203",
    domain: "vodasofia.example",
  },
  heating: {
    nameBg: "ТоплоСофия ЕАД",
    activityBg: "Централно топлоснабдяване",
    addressBg: "ул. Ястребец 23Б, 1680 София",
    eik: "202345678",
    vat: "BG202345678",
    contact: "0700 11 222   info@toplosofia.example",
    iban: "BG64STSA93000112345678",
    bic: "STSABGSF",
    clientNo: "8800123",
    domain: "toplosofia.example",
  },
  waste: {
    nameBg: "СТОЛИЧНА ОБЩИНА (примерна)",
    unitBg: "Дирекция „Местни данъци и такси“",
    addressBg: "пл. Славейков 4, 1000 София",
    eik: "000696327 (примерен)",
    iban: "BG21BUIN95611000123456",
    accountNo: "ПН-1002233",
  },
  internet: {
    nameBg: "НетЛинк ЕООД",
    nameEn: "NetLink EOOD",
    iban: "BG27FINV91501201234567",
    bic: "FINVBGSF",
    bankBg: "Първа Инвестиционна Банка",
    clientNo: "N-4821",
    domain: "netlink.example",
  },
  transport: {
    nameBg: "ГРАДСКИ ТРАНСПОРТ СОФИЯ (примерен)",
    unitBg: "Център за градска мобилност",
    addressBg: "бул. Княгиня Мария Луиза 84, 1202 София",
    eik: "121683408 (примерен)",
    cardNo: "CARD-772041",
  },
  fuel: {
    name: "PETROLMAX",
    vat: "BG204567890",
    tel: "02 987 6543",
  },
  insurance: {
    nameBg: "ЗАСТРАХОВАТЕЛНО АД „ЩИТ“ (примерно)",
    nameEn: "SHTIT Insurance JSC (sample)",
    eik: "203344556",
    iban: "BG11DEMO91500000112233",
    policyNo: "ИМ-2026-0098471",
  },
  mobile: {
    nameBg: "МобиТел ЕАД (примерен)",
    eik: "204455667",
    clientNo: "M-3390214",
  },
};

// Regulated tariffs by regime. `grid`, `obligations` and `excise` are flat
// monthly components (verified against the frozen June and July 2026 bills:
// 30.00 → 32.22 is exactly the announced +7.4%).
export const regimes = {
  r2025: {
    label: "до 31.12.2025",
    electricity: { day: 0.28435, night: 0.16603, grid: 2863, obligations: 684, excise: 119 },
    water: { deliver: 2.05, sewer: 0.71, treat: 2.31 },
    heating: { perMwh: 145.0 },
    internet: 2799,
    waste: 1500,
  },
  r2026: {
    label: "от 01.01.2026",
    electricity: { day: 0.298, night: 0.174, grid: 3000, obligations: 717, excise: 125 },
    water: { deliver: 2.15, sewer: 0.74, treat: 2.42 },
    heating: { perMwh: 152.0 },
    internet: 2999,
    waste: 1500,
  },
  r2026h2: {
    label: "от 01.07.2026",
    electricity: { day: 0.32005, night: 0.18688, grid: 3222, obligations: 770, excise: 134 },
    water: { deliver: 2.31, sewer: 0.79, treat: 2.6 },
    heating: { perMwh: 163.25 },
    internet: 2999,
    waste: 1500,
  },
};

// Categories used across the whole corpus. June 2026's five are a subset; the
// oracle marks the taxonomy as benchmark policy, not universal truth.
export const categories = {
  Utilities: "Electricity, heating, water and the municipal waste fee.",
  Internet: "Fixed internet/connectivity service, kept separate from Utilities for this benchmark.",
  Mobile: "Prepaid mobile top-ups. Occasional, not a monthly subscription.",
  Fuel: "Household vehicle fuel.",
  Groceries: "Household food and supermarket purchases.",
  Transport: "Public-transport cards and top-ups.",
  Health: "Pharmacy, dental and medical payments.",
  Dining: "Restaurants and cafés at home in Bulgaria.",
  Shopping: "Clothing, gifts and household goods.",
  Vehicle: "Vehicle servicing, parts and tyres (excludes fuel and insurance).",
  Insurance: "Insurance premiums.",
};

// Multilingual travel. Every trip is denominated in the destination's currency
// and written in the destination's language, and every trip document is excluded
// from the BGN household totals by declared policy — never converted.
export const trips = {
  "london-2025-11": {
    place: "London", country: "United Kingdom", locale: "en", currency: "GBP",
    language: "en-GB",
    docs: [
      { id: "heathrow-express", kind: "train", date: "2025-11-07", merchant: "Heathrow Express", amount: 2500, ref: "HEX-2025-884213", slug: "heathrow-express-07-nov" },
      { id: "black-cab", kind: "taxi", date: "2025-11-07", merchant: "London Black Cab (TfL licensed)", amount: 3480, ref: "TX-77120", slug: "london-taxi-07-nov" },
      { id: "hotel-london", kind: "hotel", date: "2025-11-09", merchant: "The Bloomsbury Rooms", amount: 31200, ref: "BR-2025-11842", slug: "london-hotel-07-09-nov", format: "pdf" },
      { id: "gatwick-bus", kind: "bus", date: "2025-11-09", merchant: "National Express coach", amount: 1150, ref: "NX-2025-55210", slug: "london-coach-09-nov" },
      { id: "airport-meal-lhr", kind: "airport", date: "2025-11-09", merchant: "The Tin Goose, Heathrow T2", amount: 1895, ref: "TG-2025-3391", slug: "heathrow-meal-09-nov" },
    ],
  },
  "helsinki-2025-12": {
    place: "Helsinki", country: "Finland", locale: "fi", currency: "EUR",
    language: "fi-FI",
    docs: [
      { id: "hotel-helsinki", kind: "hotel", date: "2025-12-11", merchant: "Hotelli Kaisaniemi", amount: 24600, ref: "HK-2025-04417", slug: "helsinki-hotelli-09-11-dec", format: "pdf" },
      { id: "taksi-helsinki", kind: "taxi", date: "2025-12-09", merchant: "Helsingin Taksi Oy", amount: 3850, ref: "TAK-2025-98120", slug: "helsinki-taksi-09-dec" },
      { id: "vr-juna", kind: "train", date: "2025-12-10", merchant: "VR Matkustajaliikenne", amount: 4290, ref: "VR-2025-772104", slug: "helsinki-tampere-juna-10-dec" },
      { id: "lentoasema-kahvila", kind: "airport", date: "2025-12-11", merchant: "Kahvila Aurora, Helsinki-Vantaa", amount: 1640, ref: "KA-2025-1188", slug: "vantaa-kahvila-11-dec" },
      { id: "bussilippu", kind: "bus", date: "2025-12-10", merchant: "HSL bussiliikenne", amount: 320, ref: "HSL-2025-40912", slug: "helsinki-bussilippu-10-dec" },
    ],
  },
  "barcelona-2026-02": {
    place: "Barcelona", country: "Spain", locale: "es", currency: "EUR",
    language: "es-ES",
    docs: [
      { id: "hotel-barcelona", kind: "hotel", date: "2026-02-15", merchant: "Hotel Sant Jordi", amount: 28800, ref: "SJ-2026-00912", slug: "barcelona-hotel-12-15-feb", format: "pdf" },
      { id: "taxi-barcelona", kind: "taxi", date: "2026-02-12", merchant: "Taxi Barcelona (Àrea Metropolitana)", amount: 3520, ref: "TB-2026-11204", slug: "barcelona-taxi-12-feb" },
      { id: "metro-tcasual", kind: "bus", date: "2026-02-13", merchant: "TMB Transports Metropolitans", amount: 1235, ref: "TMB-2026-88317", slug: "barcelona-metro-13-feb" },
      { id: "restaurante-barcelona", kind: "dining", date: "2026-02-14", merchant: "Restaurante El Xampanyet", amount: 6740, ref: "EX-2026-2214", slug: "barcelona-restaurante-14-feb" },
      { id: "aeropuerto-cafe", kind: "airport", date: "2026-02-15", merchant: "Cafetería El Prat T1", amount: 1480, ref: "EP-2026-7731", slug: "barcelona-aeropuerto-15-feb" },
    ],
  },
  "shanghai-2026-03": {
    place: "Shanghai", country: "China", locale: "zh", currency: "CNY",
    language: "zh-CN",
    docs: [
      { id: "hotel-shanghai", kind: "hotel", date: "2026-03-14", merchant: "上海静安宾馆", amount: 268000, ref: "SH-2026-0033127", slug: "shanghai-hotel-10-14-mar" },
      { id: "taxi-shanghai", kind: "taxi", date: "2026-03-10", merchant: "上海大众出租汽车", amount: 18500, ref: "CT-2026-772104", slug: "shanghai-taxi-10-mar" },
      { id: "gaotie", kind: "train", date: "2026-03-12", merchant: "中国铁路 高铁 G7018", amount: 55350, ref: "TR-2026-4471203", slug: "shanghai-hangzhou-gaotie-12-mar" },
      { id: "airport-meal-pvg", kind: "airport", date: "2026-03-14", merchant: "浦东机场 T2 餐厅", amount: 9800, ref: "PV-2026-11842", slug: "pudong-canting-14-mar" },
      { id: "ditie", kind: "bus", date: "2026-03-11", merchant: "上海地铁", amount: 1400, ref: "SM-2026-99120", slug: "shanghai-ditie-11-mar" },
    ],
  },
  "newyork-2026-04": {
    place: "New York", country: "United States", locale: "en", currency: "USD",
    language: "en-US",
    docs: [
      { id: "hotel-newyork", kind: "hotel", date: "2026-04-20", merchant: "The Gramercy Court Hotel", amount: 62400, ref: "GC-2026-118427", slug: "newyork-hotel-16-20-apr", format: "pdf" },
      { id: "yellow-cab", kind: "taxi", date: "2026-04-16", merchant: "NYC Yellow Cab, medallion 7T42", amount: 7855, ref: "TLC-2026-448120", slug: "newyork-cab-16-apr" },
      { id: "airtrain-jfk", kind: "train", date: "2026-04-16", merchant: "AirTrain JFK", amount: 875, ref: "AT-2026-99231", slug: "jfk-airtrain-16-apr" },
      { id: "metrocard", kind: "bus", date: "2026-04-17", merchant: "MTA New York City Transit", amount: 3400, ref: "MTA-2026-771208", slug: "newyork-metrocard-17-apr" },
      { id: "airport-diner-jfk", kind: "airport", date: "2026-04-20", merchant: "Terminal 4 Diner, JFK", amount: 2695, ref: "T4-2026-5517", slug: "jfk-diner-20-apr" },
    ],
  },
  "paris-2026-05": {
    place: "Paris / Lyon", country: "France", locale: "fr", currency: "EUR",
    language: "fr-FR",
    docs: [
      { id: "hotel-paris", kind: "hotel", date: "2026-05-24", merchant: "Hôtel des Grands Boulevards", amount: 34200, ref: "HGB-2026-07741", slug: "paris-hotel-21-24-mai", format: "pdf" },
      { id: "taxi-paris", kind: "taxi", date: "2026-05-21", merchant: "Taxi Parisien G7", amount: 5620, ref: "G7-2026-338120", slug: "paris-taxi-21-mai" },
      { id: "tgv-lyon", kind: "train", date: "2026-05-22", merchant: "SNCF TGV INOUI 6607", amount: 8900, ref: "SNCF-2026-4471288", slug: "paris-lyon-tgv-22-mai" },
      { id: "rer-b", kind: "bus", date: "2026-05-24", merchant: "RATP — RER B aéroport", amount: 1145, ref: "RATP-2026-90213", slug: "paris-rer-24-mai" },
      { id: "cafe-cdg", kind: "airport", date: "2026-05-24", merchant: "Café de la Terrasse, CDG T2", amount: 2130, ref: "CDG-2026-6612", slug: "cdg-cafe-24-mai" },
    ],
  },
  "london-2026-07": {
    place: "London", country: "United Kingdom", locale: "en", currency: "GBP",
    language: "en-GB",
    docs: [
      { id: "hotel-london-jul", kind: "hotel", date: "2026-07-22", merchant: "The Bloomsbury Rooms", amount: 29800, ref: "BR-2026-20417", slug: "london-hotel-20-22-jul", format: "pdf" },
      { id: "gatwick-express", kind: "train", date: "2026-07-20", merchant: "Gatwick Express", amount: 2390, ref: "GX-2026-771043", slug: "gatwick-express-20-jul" },
      { id: "black-cab-jul", kind: "taxi", date: "2026-07-21", merchant: "London Black Cab (TfL licensed)", amount: 2740, ref: "TX-88431", slug: "london-taxi-21-jul" },
    ],
  },
};

// The frozen June 2026 travel documents, declared for the oracle only.
export const frozenTravel = [
  { path: "2026/June/train-berlin-munich-14-jun.txt", merchant: "BahnReise AG", date: "2026-06-14", amount: 4990, currency: "EUR", kind: "train", language: "de-DE", ref: "BR-2026-778142" },
  { path: "2026/June/hotel-berlin-14-15-jun.pdf", merchant: "Hotel Lindenhof Berlin", date: "2026-06-15", amount: 12800, currency: "EUR", kind: "hotel", language: "de-DE", ref: "HLB-2026-03318" },
  { path: "2026/June/airport-paris-16-jun.pdf", merchant: "Café du Terminal", date: "2026-06-16", amount: 1850, currency: "EUR", kind: "airport", language: "fr-FR", ref: "CDT-2026-55217" },
];

// ---------------------------------------------------------------------------
// Per-month plan. Amounts are integer стотинки; consumption figures drive the
// bill arithmetic. Meter readings chain continuously into the frozen June 2026
// bill (electricity 14 820 kWh at 2026-04-30, water 384 m³ at 2026-04-30).
// ---------------------------------------------------------------------------

export const months = [
  {
    period: "2025-11",
    dir: "2025/November",
    regime: "r2025",
    electricity: { issue: "2025-11-03", due: "2025-11-20", dayKwh: 203, nightKwh: 95, prevReading: 12213, currReading: 12511 },
    water: { issue: "2025-11-05", due: "2025-11-25", cubic: 5, prevReading: 346, currReading: 351 },
    heating: { issue: "2025-11-15", due: "2025-11-30", mwh: 0.0, hotWater: 458, distribution: 198, note: "извън отоплителен сезон — само подгряване на вода" },
    waste: null,
    internet: { date: "2025-11-12", form: "txt" },
    transport: { date: "2025-11-27", time: "07:58", amount: 5000 },
    fuel: [
      { date: "2025-11-08", time: "09:14", station: 17, product: "diesel", unitPrice: 2.74, total: 11000, pump: 3, operator: 12, auth: "003118" },
      { date: "2025-11-24", time: "18:02", station: 22, product: "a95", unitPrice: 2.72, total: 8500, pump: 1, operator: 7, auth: "003904" },
    ],
    groceries: [
      { date: "2025-11-06", time: "18:22", merchant: "freshmarket", total: 9230, scan: true },
      { date: "2025-11-17", time: "19:05", merchant: "euromarket", total: 6415 },
      { date: "2025-11-27", time: "17:41", merchant: "zelenmarket", total: 4890 },
    ],
    extras: [
      { id: "pharmacy-nov", category: "Health", date: "2025-11-12", time: "16:30", merchant: "pharmacy", total: 3460, card: true },
      { id: "dining-nov", category: "Dining", date: "2025-11-22", time: "20:15", merchant: "restaurant", total: 6200, card: true },
    ],
    statement: { style: "partial", coverEnd: 20 },
    einvoiceHtml: "electricity",
    paymentFormDocx: "heating",
    notificationEml: "electricity",
    budget: { Utilities: 16000, Groceries: 20000, Fuel: 18000, Transport: 5000, Internet: 2799, Dining: 5000, Health: 3000 },
    trip: "london-2025-11",
  },
  {
    period: "2025-12",
    dir: "2025/December",
    regime: "r2025",
    electricity: { issue: "2025-12-03", due: "2025-12-20", dayKwh: 253, nightKwh: 119, prevReading: 12511, currReading: 12883 },
    water: { issue: "2025-12-05", due: "2025-12-25", cubic: 5, prevReading: 351, currReading: 356 },
    heating: { issue: "2025-12-15", due: "2025-12-30", mwh: 0.78, hotWater: 522, distribution: 198 },
    waste: { date: "2025-12-22", due: "2025-12-30", quarter: "Тримесечие 4 / 2025", noticeNo: "ТБО-2025-0388417" },
    internet: { date: "2025-12-12", form: "txt" },
    transport: { date: "2025-12-29", time: "08:12", amount: 5000 },
    fuel: [
      { date: "2025-12-06", time: "10:40", station: 17, product: "diesel", unitPrice: 2.76, total: 13000, pump: 5, operator: 12, auth: "004201" },
    ],
    groceries: [
      { date: "2025-12-05", time: "18:50", merchant: "freshmarket", total: 11860 },
      { date: "2025-12-19", time: "17:34", merchant: "euromarket", total: 8720, scan: true },
      { date: "2025-12-29", time: "11:20", merchant: "freshmarket", total: 14375, note: "празнични покупки" },
    ],
    extras: [
      { id: "shopping-dec", category: "Shopping", date: "2025-12-13", time: "15:05", merchant: "clothing", total: 18990, card: true },
      { id: "dining-dec", category: "Dining", date: "2025-12-31", time: "21:00", merchant: "restaurant", total: 9850, card: true },
    ],
    statement: { style: "full" },
    einvoiceHtml: "electricity",
    paymentFormDocx: "water",
    notificationEml: "heating",
    regulatoryNotice: {
      slug: "tariff-increase-notice-30-dec",
      date: "2025-12-30",
      ref: "РЕГ-2025-0918",
      ratePercent: 4.8,
      effective: "2026-01-01",
    },
    budget: { Utilities: 30000, Groceries: 30000, Fuel: 14000, Transport: 5000, Internet: 2799, Shopping: 15000, Dining: 8000 },
    trip: "helsinki-2025-12",
  },
  {
    period: "2026-01",
    dir: "2026/January",
    regime: "r2026",
    electricity: { issue: "2026-01-03", due: "2026-01-20", dayKwh: 293, nightKwh: 138, prevReading: 12883, currReading: 13314 },
    water: { issue: "2026-01-05", due: "2026-01-25", cubic: 6, prevReading: 356, currReading: 362 },
    heating: {
      issue: "2026-01-15", due: "2026-01-30", mwh: 1.24, hotWater: 550, distribution: 208,
      // Deliberate cross-month trap: January's heating charge is settled by a
      // payment form dated 2026-02-04, filed under 2026/February.
      paidBy: { date: "2026-02-04", dir: "2026/February", slug: "heating-payment-04-feb", format: "docx" },
    },
    waste: null,
    internet: { date: "2026-01-12", form: "txt" },
    transport: { date: "2026-01-28", time: "08:05", amount: 5000 },
    fuel: [
      { date: "2026-01-10", time: "08:55", station: 17, product: "diesel", unitPrice: 2.8, total: 11500, pump: 4, operator: 12, auth: "004612" },
      { date: "2026-01-26", time: "17:26", station: 19, product: "a95", unitPrice: 2.78, total: 9000, pump: 6, operator: 14, auth: "004980" },
    ],
    groceries: [
      { date: "2026-01-08", time: "18:12", merchant: "freshmarket", total: 7640, scan: true },
      { date: "2026-01-21", time: "19:22", merchant: "euromarket", total: 5985 },
    ],
    extras: [
      {
        id: "insurance-jan", category: "Insurance", date: "2026-01-15", merchant: "insurance", total: 24000,
        kind: "insurance-premium", card: false,
        coverage: { start: "2026-02-01", end: "2027-01-31" },
        format: "pdf",
      },
    ],
    statement: { style: "partial", coverEnd: 20 },
    einvoiceHtml: "electricity",
    paymentFormDocx: "water",
    notificationEml: "internet",
    budget: { Utilities: 40000, Groceries: 15000, Fuel: 20000, Transport: 5000, Internet: 2999, Insurance: 24000 },
    trip: null,
  },
  {
    period: "2026-02",
    dir: "2026/February",
    regime: "r2026",
    electricity: { issue: "2026-02-03", due: "2026-02-20", dayKwh: 309, nightKwh: 146, prevReading: 13314, currReading: 13769 },
    water: { issue: "2026-02-05", due: "2026-02-25", cubic: 5, prevReading: 362, currReading: 367 },
    heating: { issue: "2026-02-15", due: "2026-02-28", mwh: 1.38, hotWater: 550, distribution: 208 },
    waste: null,
    internet: { date: "2026-02-12", form: "txt" },
    transport: { date: "2026-02-26", time: "07:49", amount: 5000 },
    // Deliberate negative-amount trap: a credit note reduces Utilities.
    creditNote: {
      provider: "electricity",
      date: "2026-02-10",
      amount: -3420,
      slug: "electricity-credit-note-10-feb",
      reasonBg: "коригиран отчет за 12/2025 — сторниране на начислена разлика",
      referencesInvoiceOf: "2026-01",
    },
    fuel: [
      { date: "2026-02-07", time: "09:31", station: 17, product: "diesel", unitPrice: 2.82, total: 12000, pump: 2, operator: 12, auth: "005240" },
    ],
    groceries: [
      { date: "2026-02-05", time: "18:40", merchant: "freshmarket", total: 8810 },
      { date: "2026-02-19", time: "18:02", merchant: "zelenmarket", total: 7145, scan: true },
    ],
    extras: [
      { id: "vehicle-feb", category: "Vehicle", date: "2026-02-18", time: "14:20", merchant: "carservice", total: 15600, card: true },
    ],
    statement: { style: "partial", coverEnd: 20 },
    einvoiceHtml: "electricity",
    paymentFormDocx: null, // the docx this month is January's heating payment form
    notificationEml: "electricity",
    budget: { Utilities: 45000, Groceries: 16000, Fuel: 12000, Transport: 5000, Internet: 2999, Vehicle: 10000 },
    trip: "barcelona-2026-02",
  },
  {
    period: "2026-03",
    dir: "2026/March",
    regime: "r2026",
    electricity: {
      issue: "2026-03-03", due: "2026-03-20", dayKwh: 273, nightKwh: 129, prevReading: 13769, currReading: 14171,
      // Deliberate duplicate-representation trap: the same invoice is delivered
      // twice by e-mail, once as the original and once as a reminder resend.
      resendEml: { date: "2026-03-18", slug: "electricity-invoice-resend-18-mar" },
    },
    water: { issue: "2026-03-05", due: "2026-03-25", cubic: 5, prevReading: 367, currReading: 372 },
    heating: { issue: "2026-03-15", due: "2026-03-30", mwh: 1.15, hotWater: 520, distribution: 208 },
    waste: { date: "2026-03-22", due: "2026-03-31", quarter: "Тримесечие 1 / 2026", noticeNo: "ТБО-2026-0412088" },
    internet: { date: "2026-03-12", form: "txt" },
    transport: { date: "2026-03-27", time: "08:31", amount: 5000 },
    fuel: [
      { date: "2026-03-09", time: "10:05", station: 22, product: "a95", unitPrice: 2.8, total: 10500, pump: 1, operator: 7, auth: "005611" },
      { date: "2026-03-23", time: "19:44", station: 17, product: "diesel", unitPrice: 2.82, total: 9500, pump: 4, operator: 12, auth: "005903" },
    ],
    groceries: [
      { date: "2026-03-06", time: "17:55", merchant: "euromarket", total: 9425, scan: true },
      { date: "2026-03-20", time: "18:33", merchant: "freshmarket", total: 6370 },
    ],
    extras: [
      { id: "pharmacy-mar", category: "Health", date: "2026-03-16", time: "11:40", merchant: "pharmacy", total: 2780, card: true },
    ],
    statement: { style: "partial", coverEnd: 20 },
    einvoiceHtml: "water",
    paymentFormDocx: "heating",
    notificationEml: "electricity",
    budget: { Utilities: 42000, Groceries: 16000, Fuel: 20000, Transport: 5000, Internet: 2999, Health: 3000 },
    trip: "shanghai-2026-03",
  },
  {
    period: "2026-04",
    dir: "2026/April",
    regime: "r2026",
    electricity: { issue: "2026-04-03", due: "2026-04-20", dayKwh: 234, nightKwh: 110, prevReading: 14171, currReading: 14515 },
    water: { issue: "2026-04-05", due: "2026-04-25", cubic: 6, prevReading: 372, currReading: 378 },
    heating: { issue: "2026-04-15", due: "2026-04-30", mwh: 0.82, hotWater: 500, distribution: 208 },
    waste: null,
    internet: { date: "2026-04-12", form: "txt" },
    transport: { date: "2026-04-28", time: "08:20", amount: 5000 },
    fuel: [
      { date: "2026-04-11", time: "09:48", station: 17, product: "diesel", unitPrice: 2.82, total: 12500, pump: 3, operator: 12, auth: "006315" },
    ],
    groceries: [
      { date: "2026-04-07", time: "18:18", merchant: "freshmarket", total: 8155 },
      { date: "2026-04-23", time: "19:10", merchant: "euromarket", total: 7730, scan: true },
    ],
    extras: [
      { id: "dining-apr", category: "Dining", date: "2026-04-25", time: "20:05", merchant: "restaurant", total: 5430, card: true },
      // Deliberate foreign-currency trap: a EUR online order settled from a EUR
      // wallet, so it never reaches the BGN statement and must not be converted.
      {
        id: "eur-order-apr", category: "Shopping", date: "2026-04-14", merchant: "elektroshop-de", total: 7990,
        currency: "EUR", kind: "online-order", card: false, format: "pdf", language: "de-DE",
        excluded: { reason: "EUR purchase settled from a EUR wallet; excluded from the BGN total and never converted" },
      },
    ],
    statement: { style: "full" },
    einvoiceHtml: "electricity",
    paymentFormDocx: "water",
    notificationEml: "water",
    budget: { Utilities: 35000, Groceries: 16000, Fuel: 13000, Transport: 5000, Internet: 2999, Dining: 6000 },
    trip: "newyork-2026-04",
  },
  {
    period: "2026-05",
    dir: "2026/May",
    regime: "r2026",
    electricity: { issue: "2026-05-03", due: "2026-05-20", dayKwh: 207, nightKwh: 98, prevReading: 14515, currReading: 14820 },
    // The frozen 2026/May/water-payment-12-may.txt settles this bill: its 41.10
    // BGN pins the total, which the annual meter-maintenance line makes exact.
    water: {
      issue: "2026-05-05", due: "2026-05-25", cubic: 6, prevReading: 378, currReading: 384,
      extras: [{ labelBg: "Такса отчитане и поддръжка на водомер (годишна)", amount: 239 }],
      frozenPayment: { path: "2026/May/water-payment-12-may.txt", date: "2026-05-12", amount: 4110 },
    },
    heating: { issue: "2026-05-15", due: "2026-05-30", mwh: 0.62, hotWater: 490, distribution: 208 },
    waste: null,
    internet: { date: "2026-05-12", form: "txt" },
    transport: { date: "2026-05-28", time: "08:02", amount: 5000 },
    fuel: [
      { date: "2026-05-08", time: "08:37", station: 17, product: "diesel", unitPrice: 2.82, total: 11000, pump: 4, operator: 12, auth: "006702" },
      { date: "2026-05-22", time: "18:29", station: 19, product: "a95", unitPrice: 2.8, total: 10000, pump: 6, operator: 14, auth: "007018" },
    ],
    groceries: [
      { date: "2026-05-06", time: "18:44", merchant: "freshmarket", total: 9005, scan: true },
      { date: "2026-05-20", time: "17:58", merchant: "euromarket", total: 6840 },
    ],
    extras: [
      { id: "vehicle-may", category: "Vehicle", date: "2026-05-14", time: "10:15", merchant: "tyreservice", total: 12000, card: true },
      { id: "pharmacy-may", category: "Health", date: "2026-05-19", time: "17:20", merchant: "pharmacy", total: 4125, card: true },
    ],
    statement: { style: "partial", coverEnd: 20 },
    einvoiceHtml: "electricity",
    paymentFormDocx: "heating",
    notificationEml: "electricity",
    budget: { Utilities: 32000, Groceries: 16000, Fuel: 20000, Transport: 5000, Internet: 2999, Vehicle: 12000, Health: 4000 },
    trip: "paris-2026-05",
  },
  {
    // Frozen slice. Declared for the oracle; the generator writes nothing here.
    period: "2026-06",
    dir: "2026/June",
    regime: "r2026",
    frozen: true,
  },
  {
    period: "2026-07",
    dir: "2026/July",
    regime: "r2026h2",
    // Three bills in this month are frozen; the rest of July is generated.
    electricity: { frozen: true, path: "2026/July/electricity-bill-03-jul.txt", invoiceNo: "0000489215", issue: "2026-07-03", due: "2026-07-20", amount: 16513, servicePeriod: "2026-06" },
    water: { frozen: true, path: "2026/July/water-bill-05-jul.txt", invoiceNo: "0000785123", issue: "2026-07-05", due: "2026-07-25", amount: 3420, servicePeriod: "2026-06" },
    heating: { issue: "2026-07-15", due: "2026-07-30", mwh: 0.12, hotWater: 510, distribution: 223 },
    waste: null,
    internet: { date: "2026-07-12", form: "txt" },
    transport: { date: "2026-07-28", time: "08:14", amount: 5000 },
    fuel: [
      { frozen: true, path: "2026/July/fuel-receipt-15-jul.txt", date: "2026-07-15", receiptNo: "0441-001023", total: 13200, station: 19 },
      { date: "2026-07-24", time: "19:03", station: 17, product: "diesel", unitPrice: 2.992, total: 11800, pump: 5, operator: 12, auth: "008947" },
    ],
    groceries: [
      { date: "2026-07-07", time: "18:26", merchant: "freshmarket", total: 9610, scan: true },
      { date: "2026-07-21", time: "19:14", merchant: "euromarket", total: 7425 },
    ],
    extras: [
      { id: "mobile-jul", category: "Mobile", date: "2026-07-09", time: "12:05", merchant: "mobile", total: 2000, card: true, kind: "prepaid-topup" },
      { id: "dining-jul", category: "Dining", date: "2026-07-18", time: "20:40", merchant: "restaurant", total: 7680, card: true },
    ],
    statement: { style: "partial", coverEnd: 20 },
    einvoiceHtml: "heating",
    paymentFormDocx: "heating",
    notificationEml: "internet",
    budget: { Utilities: 24000, Groceries: 17000, Fuel: 25000, Transport: 5000, Internet: 2999, Dining: 8000, Mobile: 2000 },
    trip: "london-2026-07",
  },
];

// Merchants for the non-utility receipts.
export const merchants = {
  freshmarket: { nameEn: "FreshMarket #218 groceries", nameBg: "ФРЕШМАРКЕТ", store: "#218", addressBg: "бул. Витоша 102, София", eik: "205566778" },
  euromarket: { nameEn: "EuroMarket groceries", nameBg: "ЕВРОМАРКЕТ", store: "#41", addressBg: "ул. Граф Игнатиев 14, София", eik: "205667889" },
  zelenmarket: { nameEn: "ZelenMarket groceries", nameBg: "ЗЕЛЕНМАРКЕТ", store: "#7", addressBg: "ул. Плачковица 3, София", eik: "205778990" },
  pharmacy: { nameEn: "Zdrave pharmacy", nameBg: "АПТЕКА ЗДРАВЕ (примерна)", store: "", addressBg: "бул. Патриарх Евтимий 22, София", eik: "206112233" },
  restaurant: { nameEn: "Starata Kushta restaurant", nameBg: "РЕСТОРАНТ „СТАРАТА КЪЩА“ (примерен)", store: "", addressBg: "ул. Цар Иван Шишман 9, София", eik: "206223344" },
  clothing: { nameEn: "Moda Stil clothing", nameBg: "МОДА СТИЛ ЕООД (примерен)", store: "", addressBg: "бул. Витоша 55, София", eik: "206334455" },
  carservice: { nameEn: "Motor car service", nameBg: "АВТОСЕРВИЗ „МОТОР“ (примерен)", store: "", addressBg: "ул. Илиянци 88, София", eik: "206445566" },
  tyreservice: { nameEn: "Gumi Centar tyre service", nameBg: "ГУМИ ЦЕНТЪР (примерен)", store: "", addressBg: "бул. Ломско шосе 210, София", eik: "206556677" },
  mobile: { nameEn: "MobiTel prepaid top-up", nameBg: "МобиТел ЕАД (примерен)", store: "", addressBg: "бул. Цариградско шосе 115, София", eik: "204455667" },
  insurance: { nameEn: "SHTIT insurance premium", nameBg: "ЗАСТРАХОВАТЕЛНО АД „ЩИТ“ (примерно)", store: "", addressBg: "ул. Позитано 3, София", eik: "203344556" },
  "elektroshop-de": { nameEn: "ElektroShop GmbH order", nameBg: "ElektroShop GmbH", store: "", addressBg: "Hauptstraße 44, 10827 Berlin, Deutschland", eik: "DE811223344" },
};

// Basket lines for grocery receipts, chosen per receipt so the printed lines sum
// to the receipt total (the generator balances the last line).
export const basket = [
  { nameBg: "Хляб пълнозърнест 700 г", unit: 289 },
  { nameBg: "Мляко прясно 3.6% 1 л", unit: 319 },
  { nameBg: "Кисело мляко 400 г x4", unit: 476 },
  { nameBg: "Яйца размер М 10 бр.", unit: 549 },
  { nameBg: "Сирене бяло краве 800 г", unit: 1290 },
  { nameBg: "Кашкавал 400 г", unit: 998 },
  { nameBg: "Пилешко филе 1 кг", unit: 1449 },
  { nameBg: "Свинско месо 1 кг", unit: 1690 },
  { nameBg: "Домати 1 кг", unit: 429 },
  { nameBg: "Краставици 1 кг", unit: 389 },
  { nameBg: "Картофи 2 кг", unit: 358 },
  { nameBg: "Ориз 1 кг", unit: 379 },
  { nameBg: "Макарони 500 г", unit: 189 },
  { nameBg: "Олио слънчогледово 1 л", unit: 429 },
  { nameBg: "Кафе мляно 250 г", unit: 899 },
  { nameBg: "Плодов сок 1 л", unit: 279 },
  { nameBg: "Минерална вода 1.5 л x6", unit: 449 },
  { nameBg: "Тоалетна хартия 8 бр.", unit: 699 },
  { nameBg: "Прах за пране 2 кг", unit: 1249 },
  { nameBg: "Шоколад 90 г", unit: 249 },
];
