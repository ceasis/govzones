#!/usr/bin/env node
/**
 * Generates data/ph/offices.json — the second directory seed batch: service offices of national
 * agencies in every region, province and city, the standard local-government offices of every
 * province, city and municipality, and the Bangsamoro Government ministries.
 *
 * It is built from the geography and parent agencies already in data/ph/directory.json plus the
 * curated lists below. Two kinds of entries:
 *   - structural: offices every unit of government has by law or standing practice (a civil
 *     registry per city, a PSA office per province, a DOLE office per region …);
 *   - named: specific offices compiled from public knowledge (DFA consular offices, BIR revenue
 *     districts, BOC ports, NBI regional offices …).
 * Everything is published "pending source verification"; each entry carries a reviewNote telling a
 * curator what to confirm. Re-running is deterministic (same keys → same IDs in the seed builder).
 *
 * Usage: node scripts/generate-ph-offices.mjs && npm run seed:build
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(readFileSync(join(root, "data/ph/directory.json"), "utf8"));

const geo = base.geo;
const geoByKey = new Map(geo.map((g) => [g.key, g]));
const regions = geo.filter((g) => g.type === "REGION");
const provinces = geo.filter((g) => g.type === "PROVINCE");
const cities = geo.filter((g) => g.type === "CITY" || g.type === "MUNICIPALITY");
const baseKeys = new Set(base.entities.map((e) => e.key));

const entities = [];
const keys = new Set();
const dedupe = (arr) => [...new Set(arr.filter(Boolean))];
function add(e) {
  if (!e.key || keys.has(e.key) || baseKeys.has(e.key)) throw new Error(`duplicate or missing key: ${e.key}`);
  if (e.parent && !baseKeys.has(e.parent) && !keys.has(e.parent)) throw new Error(`${e.key}: unknown parent ${e.parent}`);
  if (e.geo && !geoByKey.has(e.geo)) throw new Error(`${e.key}: unknown geo ${e.geo}`);
  if (!e.name || !e.description) throw new Error(`${e.key}: name and description are required`);
  keys.add(e.key);
  entities.push({
    key: e.key,
    type: e.type ?? "FIELD_OFFICE",
    name: e.name,
    acronym: e.acronym ?? null,
    aliases: dedupe(e.aliases ?? []).filter((a) => a !== e.name),
    formerNames: [],
    parent: e.parent ?? null,
    geo: e.geo ?? null,
    officialUrl: e.officialUrl ?? null,
    description: e.description,
    address: e.address ?? null,
    reviewNote: e.reviewNote ?? null,
  });
}

// ---------------------------------------------------------------------------------------------
// Geography helpers
// ---------------------------------------------------------------------------------------------
const R = {
  "r-ncr": { code: "NCR", pnp: null, name: "Metro Manila" },
  "r-car": { code: "CAR", pnp: "Cordillera", name: "the Cordillera" },
  "r-01": { code: "I", pnp: "1", name: "the Ilocos Region" },
  "r-02": { code: "II", pnp: "2", name: "Cagayan Valley" },
  "r-03": { code: "III", pnp: "3", name: "Central Luzon" },
  "r-4a": { code: "IV-A", pnp: "4A", name: "CALABARZON" },
  "r-4b": { code: "MIMAROPA", pnp: "MIMAROPA", name: "MIMAROPA" },
  "r-05": { code: "V", pnp: "5", name: "the Bicol Region" },
  "r-06": { code: "VI", pnp: "6", name: "Western Visayas" },
  "r-07": { code: "VII", pnp: "7", name: "Central Visayas" },
  "r-08": { code: "VIII", pnp: "8", name: "Eastern Visayas" },
  "r-09": { code: "IX", pnp: "9", name: "the Zamboanga Peninsula" },
  "r-10": { code: "X", pnp: "10", name: "Northern Mindanao" },
  "r-11": { code: "XI", pnp: "11", name: "the Davao Region" },
  "r-12": { code: "XII", pnp: "12", name: "SOCCSKSARGEN" },
  "r-13": { code: "XIII", pnp: "13", name: "Caraga" },
  "r-barmm": { code: "BARMM", pnp: "Bangsamoro Autonomous Region", name: "the Bangsamoro region" },
  "r-nir": { code: "NIR", pnp: "Negros Island Region", name: "the Negros Island Region" },
};
for (const r of regions) if (!R[r.key]) throw new Error(`no metadata for region ${r.key}`);
const rk = (key) => key.replace(/^r-/, "");
const pk = (key) => key.replace(/^p-/, "");
const ck = (key) => key.replace(/^[cm]-/, "");
const slug = (s) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const provinceOf = (c) => (c.parent?.startsWith("p-") ? geoByKey.get(c.parent) : null);
const regionOf = (g) => {
  let cur = g;
  while (cur && cur.type !== "REGION") cur = geoByKey.get(cur.parent);
  return cur;
};
const inNcr = (c) => c.parent === "r-ncr";
const isHuc = (c) => c.cityClass === "HUC" || c.cityClass === "ICC";
const dupCityNames = new Set(cities.map((c) => c.name).filter((n, i, a) => a.indexOf(n) !== i));
/** "Baguio City", "Quezon City", "Science City of Muñoz", "Pateros". */
const cityLabel = (c) => (c.type === "MUNICIPALITY" || /\bCity\b/.test(c.name) ? c.name : `${c.name} City`);
/** Appended to names of cities that share a name (two Nagas, two San Fernandos …). */
const placeSuffix = (c) => (dupCityNames.has(c.name) ? ` (${provinceOf(c)?.name ?? regionOf(c).shortName})` : "");

/** Provinces (and Sulu, in transition) whose devolved services are run by Bangsamoro ministries. */
const MINISTRY_RUN = new Set([...provinces.filter((p) => p.parent === "r-barmm").map((p) => p.key), "p-sulu"]);
const ministryRun = (g) => MINISTRY_RUN.has(g.key) || MINISTRY_RUN.has(g.parent);

/** Provincial capitals that are cities and large enough to host branch offices of SSS, Pag-IBIG and PhilHealth. */
const CAPITALS = new Set([
  "c-tabuk", "c-laoag", "c-vigan", "c-san-fernando-la-union", "c-tuguegarao", "c-ilagan", "c-balanga", "c-malolos",
  "c-san-fernando-pampanga", "c-tarlac-city", "c-batangas-city", "c-trece-martires", "c-calapan", "c-legazpi", "c-masbate-city",
  "c-sorsogon-city", "c-roxas-city", "c-dumaguete", "c-tagbilaran", "c-borongan", "c-catbalogan", "c-maasin", "c-dipolog",
  "c-pagadian", "c-malaybalay", "c-oroquieta", "c-tagum", "c-digos", "c-mati", "c-kidapawan", "c-koronadal", "c-surigao-city",
  "c-tandag", "c-marawi",
]);
const tierA = (c) => isHuc(c) || CAPITALS.has(c.key);

const STRUCTURAL_NOTE = "Generated from the standard structure of this level of government; confirm the office exists under this name and add its address.";
const LGU_NOTE = "Generic standard office name; the local government's actual office title and structure may differ (e.g. 'Department').";
const regionNote = (r) =>
  r.key === "r-nir"
    ? "The Negros Island Region was created in 2024; confirm this regional office has been established and where it sits."
    : r.key === "r-barmm"
      ? "National agency office operating in the Bangsamoro region; confirm it exists alongside the Bangsamoro ministries."
      : "Regional office named from the agency's standard structure; add its address and confirm the regional centre.";

// ---------------------------------------------------------------------------------------------
// 1. Bangsamoro Government ministries (the primary agencies for devolved services in BARMM)
// ---------------------------------------------------------------------------------------------
const MINISTRIES = [
  ["ocm", "Office of the Chief Minister", "OCM", "Executive office of the Bangsamoro Government, headed by the Chief Minister."],
  ["moh", "Ministry of Health", "MOH", "Runs public health services and hospitals in the Bangsamoro region; the regional counterpart of the Department of Health."],
  ["mbhte", "Ministry of Basic, Higher and Technical Education", "MBHTE", "Runs basic, higher and technical education in the Bangsamoro region, including its schools divisions."],
  ["mssd", "Ministry of Social Services and Development", "MSSD", "Delivers social welfare and assistance programs in the Bangsamoro region."],
  ["milg", "Ministry of the Interior and Local Government", "MILG", "Supervises local governments in the Bangsamoro region."],
  ["mole", "Ministry of Labor and Employment", "MOLE", "Labor standards, employment facilitation and workers' programs in the Bangsamoro region."],
  ["mafar", "Ministry of Agriculture, Fisheries and Agrarian Reform", "MAFAR", "Agriculture, fisheries and agrarian reform services in the Bangsamoro region."],
  ["mpw", "Ministry of Public Works", "MPW", "Regional roads, bridges and public buildings in the Bangsamoro region."],
  ["motc", "Ministry of Transportation and Communications", "MOTC", "Transport and communications regulation and projects in the Bangsamoro region."],
  ["mtit", "Ministry of Trade, Investments and Tourism", "MTIT", "Business assistance, trade, investment promotion and tourism in the Bangsamoro region."],
  ["menre", "Ministry of Environment, Natural Resources and Energy", "MENRE", "Environment, natural resources and energy regulation in the Bangsamoro region."],
  ["mfbm", "Ministry of Finance, and Budget and Management", "MFBM", "Regional finance, budget and treasury of the Bangsamoro Government."],
  ["mhsd", "Ministry of Human Settlements and Development", "MHSD", "Housing and human settlements programs in the Bangsamoro region."],
  ["mipa", "Ministry of Indigenous Peoples' Affairs", "MIPA", "Programs for non-Moro indigenous peoples in the Bangsamoro region."],
  ["most", "Ministry of Science and Technology", "MOST", "Science, technology and scholarship programs in the Bangsamoro region."],
  ["mpos", "Ministry of Public Order and Safety", "MPOS", "Public order, safety and disaster coordination in the Bangsamoro region."],
];
for (const [k, name, acronym, description] of MINISTRIES) {
  add({
    key: `barmm-${k}`,
    type: "AGENCY",
    name: `Bangsamoro ${name}`,
    acronym,
    aliases: [`${acronym}-BARMM`, `${name} BARMM`, `${name} – Bangsamoro Government`],
    geo: "r-barmm",
    description,
    address: "Bangsamoro Government Center, Cotabato City",
    reviewNote: "Ministry of the Bangsamoro Government (regional, not national). Listed with national agencies because it is the primary agency for this service in BARMM.",
  });
}

// ---------------------------------------------------------------------------------------------
// 2. Regional offices of national agencies
// ---------------------------------------------------------------------------------------------
const REGIONAL = [
  { parent: "lto", k: "lto-ro", name: (r) => `LTO Regional Office ${r.code}`, al: (r) => [`LTO-${r.code}`, `LTO Region ${r.code}`], desc: (r) => `LTO regional office supervising licensing and registration offices in ${r.name}.`, have: ["r-07", "r-11"] },
  { parent: "ltfrb", k: "ltfrb-ro", name: (r) => `LTFRB Regional Office ${r.code}`, al: (r) => [`LTFRB-${r.code}`, `LTFRB Region ${r.code}`], desc: (r) => `LTFRB regional office franchising and regulating public transport operators in ${r.name}.`, skip: ["r-barmm", "r-nir"] },
  { parent: "dole", k: "dole-ro", name: (r) => `DOLE Regional Office ${r.code}`, al: (r) => [`DOLE-${r.code}`, `DOLE Region ${r.code}`], desc: (r) => `DOLE regional office handling labor standards, employment, and workers' assistance programs in ${r.name}.`, skip: ["r-barmm"], have: ["r-07"] },
  { parent: "dswd", k: "dswd-fo", name: (r) => `DSWD Field Office ${r.code}`, al: (r) => [`DSWD-${r.code}`, `DSWD Region ${r.code}`], desc: (r) => `DSWD regional field office delivering social welfare programs in ${r.name}.`, skip: ["r-barmm"], have: ["r-ncr", "r-07", "r-11"] },
  { parent: "doh", k: "doh-chd", name: (r) => (r.key === "r-ncr" ? "Metro Manila Center for Health Development" : `DOH Center for Health Development – ${r.title}`), al: (r) => [`DOH ${r.code}`, `CHD ${r.code}`, `DOH Regional Office ${r.code}`], desc: (r) => `DOH regional office overseeing public health programs and licensing health facilities in ${r.name}.`, skip: ["r-barmm"] },
  { parent: "deped", k: "deped-ro", name: (r) => `DepEd Regional Office ${r.code}`, al: (r) => [`DepEd ${r.code}`, `DepEd Region ${r.code}`], desc: (r) => `DepEd regional office supervising the schools division offices in ${r.name}.`, skip: ["r-barmm"] },
  { parent: "dilg", k: "dilg-ro", name: (r) => `DILG Regional Office ${r.code}`, al: (r) => [`DILG ${r.code}`, `DILG Region ${r.code}`], desc: (r) => `DILG regional office supervising local governments in ${r.name}.`, skip: ["r-barmm"] },
  { parent: "dpwh", k: "dpwh-ro", name: (r) => `DPWH Regional Office ${r.code}`, al: (r) => [`DPWH ${r.code}`, `DPWH Region ${r.code}`], desc: (r) => `DPWH regional office for national roads, bridges and flood control in ${r.name}.`, skip: ["r-barmm"] },
  { parent: "denr", k: "denr-ro", name: (r) => `DENR Regional Office ${r.code}`, al: (r) => [`DENR ${r.code}`, `DENR Region ${r.code}`], desc: (r) => `DENR regional office for environmental permits, land and forestry matters in ${r.name}.`, skip: ["r-barmm"] },
  { parent: "da", k: "da-rfo", name: (r) => `DA Regional Field Office ${r.code}`, al: (r) => [`DA RFO ${r.code}`, `DA ${r.code}`], desc: (r) => `Department of Agriculture regional field office for farm and fisheries programs in ${r.name}.`, skip: ["r-barmm", "r-ncr"] },
  { parent: "dti", k: "dti-ro", name: (r) => `DTI Regional Office ${r.code}`, al: (r) => [`DTI ${r.code}`, `DTI Region ${r.code}`], desc: (r) => `DTI regional office for business name registration, consumer complaints and MSME programs in ${r.name}.`, skip: ["r-barmm"] },
  { parent: "tesda", k: "tesda-ro", name: (r) => `TESDA Regional Office ${r.code}`, al: (r) => [`TESDA ${r.code}`, `TESDA Region ${r.code}`], desc: (r) => `TESDA regional office for technical-vocational training, assessment and certification in ${r.name}.`, skip: ["r-barmm"] },
  { parent: "csc", k: "csc-ro", name: (r) => `CSC Regional Office ${r.code}`, al: (r) => [`CSC ${r.code}`, `Civil Service Commission ${r.code}`], desc: (r) => `Civil Service Commission regional office for eligibility, appointments and complaints about government personnel in ${r.name}.`, skip: ["r-nir"] },
  { parent: "psa", k: "psa-rsso", name: (r) => `PSA Regional Statistical Services Office ${r.code}`, al: (r) => [`PSA RSSO ${r.code}`, `PSA ${r.code}`], desc: (r) => `PSA regional office for statistics, civil registration, and national ID services in ${r.name}.`, have: ["r-07"] },
  { parent: "philhealth", k: "philhealth-pro", name: (r) => `PhilHealth Regional Office ${r.code}`, al: (r) => [`PhilHealth PRO ${r.code}`, `PhilHealth ${r.code}`], desc: (r) => `PhilHealth regional office serving members and accredited facilities in ${r.name}.`, skip: ["r-nir"], have: ["r-07"] },
  { parent: "owwa", k: "owwa-rwo", name: (r) => `OWWA Regional Welfare Office ${r.code}`, al: (r) => [`OWWA ${r.code}`, `OWWA Region ${r.code}`], desc: (r) => `OWWA regional office for overseas Filipino workers' benefits, scholarships and reintegration programs in ${r.name}.`, skip: ["r-nir"] },
  { parent: "bfp", k: "bfp-ro", name: (r) => `BFP Regional Office ${r.code}`, al: (r) => [`BFP ${r.code}`, `Bureau of Fire Protection ${r.code}`], desc: (r) => `Bureau of Fire Protection regional office supervising fire stations in ${r.name}.` },
  { parent: "bjmp", k: "bjmp-ro", name: (r) => `BJMP Regional Office ${r.code}`, al: (r) => [`BJMP ${r.code}`, `BJMP Region ${r.code}`], desc: (r) => `Bureau of Jail Management and Penology regional office supervising city and municipal jails in ${r.name}.`, skip: ["r-nir"] },
  { parent: "pao", k: "pao-ro", name: (r) => `PAO Regional Office ${r.code}`, al: (r) => [`PAO ${r.code}`, `Public Attorney's Office ${r.code}`], desc: (r) => `Public Attorney's Office regional office providing free legal assistance in ${r.name}.`, skip: ["r-nir"] },
  { parent: "dar", k: "dar-ro", name: (r) => `DAR Regional Office ${r.code}`, al: (r) => [`DAR ${r.code}`, `DAR Region ${r.code}`], desc: (r) => `DAR regional office for agrarian reform land matters in ${r.name}.`, skip: ["r-barmm", "r-ncr", "r-nir"] },
  { parent: "dhsud", k: "dhsud-ro", name: (r) => `DHSUD Regional Office ${r.code}`, al: (r) => [`DHSUD ${r.code}`, `DHSUD Region ${r.code}`], desc: (r) => `DHSUD regional office for housing, subdivision and condominium matters in ${r.name}.`, skip: ["r-barmm", "r-nir"] },
  { parent: "ched", k: "ched-ro", name: (r) => `CHED Regional Office ${r.code}`, al: (r) => [`CHED ${r.code}`, `CHEDRO ${r.code}`], desc: (r) => `CHED regional office for higher education institutions, scholarships and document authentication in ${r.name}.`, skip: ["r-barmm", "r-nir"] },
  { parent: "dost", k: "dost-ro", name: (r) => `DOST Regional Office ${r.code}`, al: (r) => [`DOST ${r.code}`, `DOST Region ${r.code}`], desc: (r) => `DOST regional office for science scholarships and technology programs in ${r.name}.`, skip: ["r-barmm", "r-nir"] },
  { parent: "dmw", k: "dmw-ro", name: (r) => `DMW Regional Office ${r.code}`, al: (r) => [`DMW ${r.code}`, `Migrant Workers Office ${r.code}`], desc: (r) => `Department of Migrant Workers regional office for overseas employment documents and assistance in ${r.name}.`, skip: ["r-nir"], note: "DMW regional offices were organised from the former POEA regional centres in 2023; confirm the office and its location." },
  { parent: "chr", k: "chr-ro", name: (r) => `CHR Regional Office ${r.code}`, al: (r) => [`CHR ${r.code}`, `Commission on Human Rights ${r.code}`], desc: (r) => `Commission on Human Rights regional office receiving complaints and assisting victims in ${r.name}.`, skip: ["r-nir"] },
];
for (const region of regions) {
  const r = { key: region.key, title: region.name, ...R[region.key] };
  for (const t of REGIONAL) {
    if (t.skip?.includes(r.key) || t.have?.includes(r.key)) continue;
    add({ key: `${t.k}-${rk(r.key)}`, name: t.name(r), aliases: t.al(r), parent: t.parent, geo: r.key, description: t.desc(r), reviewNote: t.note ?? regionNote(r) });
  }
  if (!["r-ncr", "r-07", "r-11"].includes(r.key)) {
    const acronym = r.key === "r-car" ? "PROCOR" : r.key === "r-barmm" ? "PRO-BAR" : r.key === "r-nir" ? "PRO-NIR" : `PRO-${r.pnp}`;
    add({
      key: `pro-${rk(r.key)}`,
      name: `Police Regional Office ${r.pnp}`,
      acronym,
      aliases: [acronym, acronym.replace("-", ""), `PNP ${r.title}`],
      parent: "pnp",
      geo: r.key,
      description: `PNP regional office responsible for policing in ${r.name}.`,
      reviewNote: regionNote(r),
    });
  }
}

// NBI, PRC and DOLE-NCR have their own naming.
const NBI = [
  ["r-car", "Cordillera Administrative Regional Office", "CARO", "Baguio"],
  ["r-01", "Ilocos Regional Office", "IRO", "Dagupan"],
  ["r-02", "Cagayan Valley Regional Office", "CAVRO", "Tuguegarao"],
  ["r-03", "Central Luzon Regional Office", "CELRO", "San Fernando"],
  ["r-4a", "Southern Tagalog Regional Office", "STRO", null],
  ["r-05", "Bicol Regional Office", "BRO", "Legazpi"],
  ["r-06", "Western Visayas Regional Office", "WEVRO", "Iloilo"],
  ["r-07", "Central Visayas Regional Office", "CEVRO", "Cebu"],
  ["r-08", "Eastern Visayas Regional Office", "EVRO", "Tacloban"],
  ["r-09", "Western Mindanao Regional Office", "WEMRO", "Zamboanga"],
  ["r-10", "Northern Mindanao Regional Office", "NEMRO", "Cagayan de Oro"],
  ["r-11", "Southeastern Mindanao Regional Office", "SEMRO", "Davao"],
  ["r-12", "Central Mindanao Regional Office", "CEMRO", "Cotabato"],
  ["r-13", "Caraga Regional Office", "CARAGRO", "Butuan"],
];
for (const [geoKey, name, acr, city] of NBI) {
  add({
    key: `nbi-${rk(geoKey)}`,
    name: `NBI ${name}`,
    aliases: [`NBI ${acr}`, city ? `NBI ${city}` : null],
    parent: "nbi",
    geo: geoKey,
    description: "NBI regional office issuing NBI clearances and handling investigation requests for the region.",
    reviewNote: geoKey === "r-4a" ? "Covers both CALABARZON and MIMAROPA; confirm the office's seat." : "Confirm the office's seat and whether clearance is issued here or at satellite centres.",
  });
}
add({ key: "nbi-bacolod", name: "NBI Bacolod District Office", aliases: ["NBI Bacolod"], parent: "nbi", geo: "c-bacolod", description: "NBI district office issuing NBI clearances and handling investigation requests in Negros Occidental.", reviewNote: "District office under the Western Visayas regional office at last check; confirm after the creation of NIR." });
add({ key: "nbi-dumaguete", name: "NBI Dumaguete District Office", aliases: ["NBI Dumaguete"], parent: "nbi", geo: "c-dumaguete", description: "NBI district office issuing NBI clearances and handling investigation requests in Negros Oriental.", reviewNote: "District office under the Central Visayas regional office at last check; confirm after the creation of NIR." });

const PRC = [
  ["r-car", "Baguio"], ["r-01", "Rosales, Pangasinan"], ["r-02", "Tuguegarao"], ["r-03", "San Fernando, Pampanga"], ["r-4a", "Lucena"],
  ["r-05", "Legazpi"], ["r-06", "Iloilo"], ["r-07", "Cebu"], ["r-08", "Tacloban"], ["r-09", "Zamboanga"], ["r-10", "Cagayan de Oro"],
  ["r-11", "Davao"], ["r-12", "Koronadal"], ["r-13", "Butuan"],
];
for (const [geoKey, city] of PRC) {
  add({
    key: `prc-ro-${rk(geoKey)}`,
    name: `PRC Regional Office ${R[geoKey].code}`,
    aliases: [`PRC ${city}`, `PRC ${R[geoKey].code}`],
    parent: "prc",
    geo: geoKey,
    description: "Professional Regulation Commission regional office for licensure exam applications, licence renewal and certifications.",
    reviewNote: `Seat believed to be ${city}; confirm address and service centres.`,
  });
}
add({ key: "prc-central-office", name: "PRC Central Office", aliases: ["PRC Manila", "PRC Main Office", "PRC P. Paredes"], parent: "prc", geo: "c-manila", description: "Head office of the Professional Regulation Commission, serving professionals in Metro Manila.", address: "P. Paredes Street, Sampaloc, Manila" });

const DOLE_NCR = [
  ["manila", "Manila", "c-manila"], ["quezon-city", "Quezon City", "c-quezon-city"], ["camanava", "CAMANAVA", "r-ncr"],
  ["muntaparlas", "MUNTAPARLAS", "r-ncr"], ["papamamarisan", "PAPAMAMARISAN", "r-ncr"], ["makati-pasay", "Makati-Pasay", "r-ncr"],
];
for (const [k, label, geoKey] of DOLE_NCR) {
  add({
    key: `dole-ncr-fo-${k}`,
    name: `DOLE NCR ${label} Field Office`,
    aliases: [`DOLE ${label}`],
    parent: "dole",
    geo: geoKey,
    description: `DOLE field office for labor complaints (SEnA), employment programs and permits covering ${label}.`,
    reviewNote: "DOLE-NCR field office names group several cities (e.g. CAMANAVA = Caloocan, Malabon, Navotas, Valenzuela); confirm the current grouping and address.",
  });
}

// ---------------------------------------------------------------------------------------------
// 3. Provincial offices
// ---------------------------------------------------------------------------------------------
const PROVINCIAL = [
  { parent: "psa", k: "psa-pso", name: (p) => `PSA Provincial Statistical Office – ${p.name}`, al: (p) => [`PSA ${p.name}`, `PSO ${p.name}`], desc: (p) => `PSA provincial office for civil registry documents (PSA birth, marriage and death certificates), the national ID and statistics in ${p.name}.` },
  { parent: "pnp", k: "pnp-ppo", name: (p) => `${p.name} Police Provincial Office`, al: (p) => [`${p.name} PPO`, `PNP ${p.name}`], desc: (p) => `PNP provincial office supervising the municipal and city police stations in ${p.name}.` },
  { parent: "dti", k: "dti-po", name: (p) => `DTI ${p.name} Provincial Office`, al: (p) => [`DTI ${p.name}`], desc: (p) => `DTI provincial office for business name registration, consumer complaints and MSME assistance in ${p.name}.`, national: true },
  { parent: "tesda", k: "tesda-po", name: (p) => `TESDA ${p.name} Provincial Office`, al: (p) => [`TESDA ${p.name}`], desc: (p) => `TESDA provincial office for technical-vocational scholarships, assessment and certification in ${p.name}.`, national: true },
  { parent: "dar", k: "dar-po", name: (p) => `DAR Provincial Office – ${p.name}`, al: (p) => [`DARPO ${p.name}`, `DAR ${p.name}`], desc: (p) => `DAR provincial agrarian reform office for land transfer, titles and beneficiary support in ${p.name}.`, national: true, skip: ["p-batanes"] },
  { parent: "comelec", k: "comelec-pes", name: (p) => `COMELEC Provincial Election Office – ${p.name}`, al: (p) => [`COMELEC ${p.name}`, `Provincial Election Supervisor ${p.name}`], desc: (p) => `Office of the Provincial Election Supervisor for ${p.name}.` },
  { parent: "lra", k: "lra-rd", name: (p) => `Registry of Deeds – ${p.name}`, al: (p) => [`RD ${p.name}`, `LRA ${p.name}`], desc: (p) => `Land Registration Authority registry issuing certified true copies of land titles and registering deeds for ${p.name}.` },
  { parent: "dole", k: "dole-pfo", name: (p) => `DOLE ${p.name} Provincial Field Office`, al: (p) => [`DOLE ${p.name}`], desc: (p) => `DOLE field office for labor complaints (SEnA), employment programs and permits in ${p.name}.`, national: true },
  { parent: "dpwh", k: "dpwh-deo", name: (p) => `DPWH ${p.name} District Engineering Office`, al: (p) => [`DPWH ${p.name}`, `${p.name} DEO`], desc: (p) => `DPWH district office building and maintaining national roads and bridges in ${p.name}.`, national: true, note: "Provinces with several district engineering offices are listed once; split when verified." },
  { parent: "denr", k: "denr-penro", name: (p) => `DENR Provincial Environment and Natural Resources Office – ${p.name}`, al: (p) => [`PENRO ${p.name}`, `DENR ${p.name}`], desc: (p) => `DENR provincial office for land, forestry and environmental permits in ${p.name}.`, national: true },
];
for (const p of provinces) {
  for (const t of PROVINCIAL) {
    if (t.skip?.includes(p.key)) continue;
    if (t.national && ministryRun(p)) continue; // run by a Bangsamoro ministry instead
    add({ key: `${t.k}-${pk(p.key)}`, name: t.name(p), aliases: t.al(p), parent: t.parent, geo: p.key, description: t.desc(p), reviewNote: t.note ?? STRUCTURAL_NOTE });
  }
  // Schools divisions: one per province, two in Pangasinan; Bangsamoro divisions sit under MBHTE.
  const divisions = p.key === "p-pangasinan" ? ["Pangasinan I", "Pangasinan II"] : [p.name];
  for (const d of divisions) {
    add({
      key: `deped-sdo-${slug(d)}`,
      name: `Schools Division Office of ${d}`,
      aliases: [`SDO ${d}`, `DepEd ${d}`, `${d} Division Office`],
      parent: ministryRun(p) ? "barmm-mbhte" : "deped",
      geo: p.key,
      description: `Schools division supervising public elementary and secondary schools in the province of ${p.name}.`,
      reviewNote: ministryRun(p) ? "Schools division of the Bangsamoro education ministry (MBHTE), not DepEd." : STRUCTURAL_NOTE,
    });
  }
  // Standard provincial government offices (Local Government Code, RA 10121, RA 8759).
  const lgu = `lgu-prov-${pk(p.key)}`;
  if (!baseKeys.has(lgu)) throw new Error(`no provincial LGU for ${p.key}`);
  const PROV_LGU = [
    ["treasurer", "Provincial Treasurer's Office", ["PTO", "Provincial Treasurer"], "Collects provincial taxes, fees and charges and manages provincial funds."],
    ["assessor", "Provincial Assessor's Office", ["Provincial Assessor"], "Appraises and assesses real property for provincial taxation and issues tax declarations."],
    ["health", "Provincial Health Office", ["PHO"], "Runs provincial public health programs and supervises provincial and district hospitals."],
    ["pswdo", "Provincial Social Welfare and Development Office", ["PSWDO"], "Provides social welfare services and assistance programs for residents of the province."],
    ["engineer", "Provincial Engineer's Office", ["PEO"], "Builds and maintains provincial roads, bridges and facilities."],
    ["ppdo", "Provincial Planning and Development Office", ["PPDO"], "Prepares the provincial development and land use plans."],
    ["pdrrmo", "Provincial Disaster Risk Reduction and Management Office", ["PDRRMO"], "Coordinates disaster preparedness and emergency response for the province."],
    ["peso", "Provincial Public Employment Service Office", ["PESO"], "Free job matching, referral and labor market information for residents of the province."],
    ["agriculture", "Provincial Agriculture Office", ["Office of the Provincial Agriculturist", "OPAG"], "Agricultural extension, farm inputs and support programs for the province's farmers and fishers."],
  ];
  for (const [suffix, office, acronyms, description] of PROV_LGU) {
    add({ key: `${lgu}-${suffix}`, type: "LGU_OFFICE", name: `${p.name} ${office}`, aliases: acronyms.map((a) => `${p.name} ${a}`), parent: lgu, geo: p.key, description, reviewNote: LGU_NOTE });
  }
}

// ---------------------------------------------------------------------------------------------
// 4. City and municipal offices
// ---------------------------------------------------------------------------------------------
// The ten standard local offices are copied from the seeded Cebu City set so wording stays identical.
const CITY_LGU = base.entities
  .filter((e) => e.parent === "lgu-cebu-city")
  .map((e) => ({
    suffix: e.key.slice("lgu-cebu-city-".length),
    office: e.name.replace(/^Cebu City /, ""),
    aliases: e.aliases.map((a) => a.replace(/^Cebu City /, "")),
    description: e.description,
  }));
if (CITY_LGU.length !== 10) throw new Error("expected the 10 Cebu City template offices");

const NCR_DISTRICT = {
  "c-caloocan": "Northern", "c-malabon": "Northern", "c-navotas": "Northern", "c-valenzuela": "Northern",
  "c-pasig": "Eastern", "c-marikina": "Eastern", "c-mandaluyong": "Eastern", "c-san-juan": "Eastern",
  "c-makati": "Southern", "c-pasay": "Southern", "c-paranaque": "Southern", "c-las-pinas": "Southern", "c-muntinlupa": "Southern", "c-taguig": "Southern", "m-pateros": "Southern",
};
const NCR_POLICE_DISTRICTS = [
  ["pnp-mpd", "Manila Police District", "MPD", "c-manila", "United Nations Avenue, Ermita, Manila", "PNP district office responsible for policing in the City of Manila, under the NCRPO.", null],
  ["pnp-qcpd", "Quezon City Police District", "QCPD", "c-quezon-city", "Camp Karingal, Sikatuna Village, Quezon City", "PNP district office responsible for policing in Quezon City, under the NCRPO.", null],
  ["pnp-npd", "Northern Police District", "NPD", "c-caloocan", null, "PNP district office covering Caloocan, Malabon, Navotas and Valenzuela, under the NCRPO.", "Headquarters is in Caloocan; the district covers four cities."],
  ["pnp-epd", "Eastern Police District", "EPD", "c-pasig", null, "PNP district office covering Pasig, Marikina, Mandaluyong and San Juan, under the NCRPO.", "Headquarters is in Pasig; the district covers four cities."],
  ["pnp-spd", "Southern Police District", "SPD", "c-taguig", null, "PNP district office covering Makati, Pasay, Parañaque, Las Piñas, Muntinlupa, Taguig and Pateros, under the NCRPO.", "Headquarters is at Fort Bonifacio, Taguig; the district covers six cities and Pateros."],
];
for (const [key, name, acronym, geoKey, address, description, reviewNote] of NCR_POLICE_DISTRICTS) {
  add({ key, name, acronym, aliases: [acronym, `${name} Office`], parent: "pnp", geo: geoKey, address, description, reviewNote });
}

const LTO_SKIP = new Set(["c-navotas", "m-pateros", "c-el-salvador", "c-palayan", "c-sipalay", "c-canlaon", "c-naga-cebu"]);
const SSS_EXTRA = new Set([
  "c-antipolo", "c-calamba", "c-san-pablo", "c-santa-rosa", "c-binan", "c-lipa", "c-cabanatuan", "c-san-jose-del-monte", "c-meycauayan",
  "c-dasmarinas", "c-bacoor", "c-imus", "c-general-trias", "c-urdaneta", "c-cauayan", "c-tabaco", "c-kabankalan", "c-san-carlos-negros-occidental",
  "c-toledo", "c-danao", "c-calbayog", "c-baybay", "c-valencia", "c-ozamiz", "c-gingoog", "c-panabo", "c-tacurong", "c-bislig", "c-bayugan",
  "c-alaminos", "c-san-carlos-pangasinan", "c-candon", "c-mabalacat", "c-gapan", "c-san-jose-nueva-ecija", "c-tanauan", "c-cavite-city", "c-silay",
  "c-dapitan", "c-isabela-city", "c-iriga", "c-ligao", "c-san-pedro", "c-cabuyao", "c-santo-tomas", "c-carcar", "c-guihulngan", "c-bayawan",
  "c-cadiz", "c-la-carlota",
]);
const PAGIBIG_EXTRA = new Set([
  "c-antipolo", "c-calamba", "c-san-pablo", "c-santa-rosa", "c-binan", "c-lipa", "c-cabanatuan", "c-san-jose-del-monte", "c-meycauayan",
  "c-dasmarinas", "c-bacoor", "c-imus", "c-urdaneta", "c-cauayan", "c-kabankalan", "c-toledo", "c-calbayog", "c-ozamiz", "c-valencia", "c-gingoog",
  "c-panabo", "c-tacurong", "c-bislig", "c-alaminos", "c-mabalacat", "c-gapan", "c-tanauan", "c-isabela-city", "c-iriga",
]);
const PAGIBIG_SKIP = new Set(["c-navotas", "c-san-juan"]);
const LHIO_EXTRA = new Set([
  "c-antipolo", "c-calamba", "c-san-pablo", "c-lipa", "c-cabanatuan", "c-san-jose-del-monte", "c-cauayan", "c-urdaneta", "c-kabankalan",
  "c-san-carlos-negros-occidental", "c-calbayog", "c-ozamiz", "c-gingoog", "c-dasmarinas", "c-bacoor", "c-panabo", "c-tacurong", "c-isabela-city", "c-iriga",
]);
const LHIO_SKIP = new Set(["c-navotas", "c-san-juan"]);
const GSIS = new Set([
  "c-baguio", "c-dagupan", "c-tuguegarao", "c-cauayan", "c-san-fernando-pampanga", "c-cabanatuan", "c-malolos", "c-tarlac-city", "c-olongapo",
  "c-batangas-city", "c-lucena", "c-puerto-princesa", "c-calapan", "c-legazpi", "c-naga-camarines-sur", "c-iloilo-city", "c-roxas-city", "c-bacolod",
  "c-dumaguete", "c-tagbilaran", "c-cebu-city", "c-tacloban", "c-zamboanga-city", "c-pagadian", "c-dipolog", "c-cagayan-de-oro", "c-iligan",
  "c-malaybalay", "c-davao-city", "c-tagum", "c-general-santos", "c-koronadal", "c-kidapawan", "c-butuan", "c-surigao-city", "c-cotabato-city",
]);
const MANY_BRANCHES = new Set(["c-manila", "c-quezon-city", "c-makati", "c-pasig", "c-cebu-city", "c-davao-city"]);

for (const c of cities) {
  const L = cityLabel(c);
  const S = placeSuffix(c);
  const k = ck(c.key);
  const prov = provinceOf(c);
  const lgu = `lgu-${k}`;
  if (!baseKeys.has(lgu)) throw new Error(`no LGU for ${c.key}`);

  // Standard local government offices (skipped for the six cities already seeded).
  if (!base.entities.some((e) => e.parent === lgu)) {
    for (const t of CITY_LGU) {
      const municipal = c.type === "MUNICIPALITY";
      const office = municipal ? `Municipal ${t.office}` : t.office;
      const aliases = t.aliases.map((a) => `${L} ${municipal ? a.replace(/\bC(RO|SWDO|DRRMO|PDO|TO|HO)\b/, "M$1") : a}`);
      add({ key: `${lgu}-${t.suffix}`, type: "LGU_OFFICE", name: `${L} ${office}${S}`, aliases, parent: lgu, geo: c.key, description: t.description, reviewNote: LGU_NOTE });
    }
  }

  // Police.
  if (inNcr(c)) {
    if (!["c-manila", "c-quezon-city"].includes(c.key)) {
      const station = c.type === "MUNICIPALITY" ? `${L} Municipal Police Station` : `${L} Police Station`;
      add({ key: `pnp-cps-${k}`, name: station, aliases: [`${c.name} Police`, `PNP ${L}`], parent: "pnp", geo: c.key, description: `PNP police station responsible for ${L}, under the ${NCR_DISTRICT[c.key]} Police District.`, reviewNote: STRUCTURAL_NOTE });
    }
  } else if (isHuc(c)) {
    add({ key: `pnp-cpo-${k}`, name: `${L} Police Office${S}`, aliases: [`${c.name} CPO`, `${c.name} Police`, `PNP ${L}`], parent: "pnp", geo: c.key, description: `PNP city police office responsible for policing in ${L}.`, reviewNote: STRUCTURAL_NOTE });
  } else {
    add({ key: `pnp-cps-${k}`, name: `${L} Police Station${S}`, aliases: [`${c.name} CPS`, `${c.name} Police`, `PNP ${L}`], parent: "pnp", geo: c.key, description: `PNP city police station responsible for policing in ${L}${prov ? `, under the ${prov.name} Police Provincial Office` : ""}.`, reviewNote: STRUCTURAL_NOTE });
  }

  // Fire station, post office, election officer.
  add({ key: `bfp-${k}`, name: `${L} Fire Station${S}`, aliases: [`BFP ${L}`, `${c.name} Fire Station`], parent: "bfp", geo: c.key, description: `Bureau of Fire Protection station for ${L}: fire response, fire safety inspection certificates and fire code fees.`, reviewNote: STRUCTURAL_NOTE });
  add({
    key: `phlpost-${k}`,
    name: c.key === "c-manila" ? "Manila Central Post Office" : `${L} Post Office${S}`,
    aliases: [`PhilPost ${L}`, `${c.name} Post Office`],
    parent: "phlpost",
    geo: c.key,
    description: `PHLPost post office serving ${L}: mail, parcels, postal IDs and money orders.`,
    reviewNote: c.key === "c-manila" ? "The Manila Central Post Office building was gutted by fire in May 2023 and services moved to temporary sites; verify the current address." : STRUCTURAL_NOTE,
  });
  add({
    key: `comelec-oeo-${k}`,
    name: `COMELEC Office of the Election Officer – ${L}${S}`,
    aliases: [`COMELEC ${L}`, `${c.name} Election Officer`],
    parent: "comelec",
    geo: c.key,
    description: `COMELEC office for voter registration, transfers and voter certifications in ${L}.`,
    reviewNote: ["c-quezon-city", "c-manila"].includes(c.key) ? "Large cities have one election office per legislative district; listed once." : STRUCTURAL_NOTE,
  });

  // Schools division (most cities have their own; Pateros is served with Taguig, Palayan with Nueva Ecija).
  if (!["m-pateros", "c-palayan"].includes(c.key)) {
    const name = c.key === "c-taguig" ? "Schools Division Office of Taguig City and Pateros" : `Schools Division Office of ${L}${S}`;
    add({
      key: `deped-sdo-${k}`,
      name,
      aliases: [`SDO ${L}`, `DepEd ${L}`, `Division of City Schools ${L}`],
      parent: ministryRun(c) ? "barmm-mbhte" : "deped",
      geo: c.key,
      description: `Schools division supervising public elementary and secondary schools in ${L}.`,
      reviewNote: ministryRun(c) ? "Schools division of the Bangsamoro education ministry (MBHTE), not DepEd." : "Most cities have their own schools division; confirm this city's division exists and is not part of the provincial division.",
    });
  }

  // LTO.
  if (c.key === "c-manila") {
    add({ key: "lto-do-manila-east", name: "LTO Manila East District Office", aliases: ["LTO Manila East", "LTO Sta. Mesa"], parent: "lto", geo: c.key, description: "LTO office for driver's licenses, vehicle registration and plates serving the eastern districts of Manila.", reviewNote: "Confirm office name and address." });
    add({ key: "lto-do-manila-west", name: "LTO Manila West District Office", aliases: ["LTO Manila West", "LTO Manila"], parent: "lto", geo: c.key, description: "LTO office for driver's licenses, vehicle registration and plates serving the western districts of Manila.", reviewNote: "Confirm office name and address." });
  } else if (!LTO_SKIP.has(c.key)) {
    add({ key: `lto-do-${k}`, name: `LTO ${L} District Office${S}`, aliases: [`LTO ${L}`, `LTO ${c.name}`], parent: "lto", geo: c.key, description: `LTO office for driver's licenses, vehicle registration and plates serving ${L}.`, reviewNote: "LTO calls some of these 'extension' or 'licensing' offices; confirm the office type and address." });
  }

  // Branches of SSS, Pag-IBIG and PhilHealth in larger cities.
  const branchNote = MANY_BRANCHES.has(c.key) ? "This agency has several branches in this city; the listing stands for the main branch until each is verified." : "Confirm the branch name and address against the agency's branch directory.";
  if (tierA(c) || SSS_EXTRA.has(c.key)) {
    add({ key: `sss-${k}`, name: `SSS ${L} Branch${S}`, aliases: [`SSS ${c.name}`, `Social Security System ${L}`], parent: "sss", geo: c.key, description: `SSS branch for membership, contributions, loans and benefit claims in ${L}.`, reviewNote: branchNote });
  }
  if ((tierA(c) && !PAGIBIG_SKIP.has(c.key)) || PAGIBIG_EXTRA.has(c.key)) {
    add({ key: `pagibig-${k}`, name: `Pag-IBIG Fund ${L} Branch${S}`, aliases: [`Pag-IBIG ${c.name}`, `HDMF ${L}`], parent: "pagibig", geo: c.key, description: `Pag-IBIG Fund branch for membership, savings, housing and short-term loans in ${L}.`, reviewNote: branchNote });
  }
  if ((tierA(c) && !LHIO_SKIP.has(c.key)) || LHIO_EXTRA.has(c.key)) {
    add({ key: `philhealth-lhio-${k}`, name: `PhilHealth Local Health Insurance Office – ${L}${S}`, aliases: [`PhilHealth ${c.name}`, `LHIO ${L}`], parent: "philhealth", geo: c.key, description: `PhilHealth local office for member registration, contributions, MDR updates and claims assistance in ${L}.`, reviewNote: branchNote });
  }
  if (GSIS.has(c.key)) {
    add({ key: `gsis-${k}`, name: `GSIS ${L} Branch${S}`, aliases: [`GSIS ${c.name}`], parent: "gsis", geo: c.key, description: `GSIS branch serving government employees and pensioners in ${L}: loans, claims and records.`, reviewNote: "Confirm the branch against the GSIS branch directory." });
  }

  // Registry of Deeds and city jail in highly urbanised and independent component cities.
  if (isHuc(c)) {
    if (c.key !== "c-navotas") {
      add({ key: `lra-rd-${k}`, name: `Registry of Deeds – ${L}${S}`, aliases: [`RD ${L}`, `LRA ${L}`], parent: "lra", geo: c.key, description: `Land Registration Authority registry issuing certified true copies of land titles and registering deeds for ${L}.`, reviewNote: STRUCTURAL_NOTE });
    }
    add({ key: `bjmp-${k}`, name: `${L} Jail${S}`, aliases: [`BJMP ${L}`, `${c.name} City Jail`], parent: "bjmp", geo: c.key, description: `BJMP-run city jail for persons deprived of liberty awaiting trial; handles visitation and release paperwork.`, reviewNote: "Large jails are split into male and female dormitories; listed once." });
  }
}

// ---------------------------------------------------------------------------------------------
// 5. Named offices of specific agencies
// ---------------------------------------------------------------------------------------------
// BIR revenue regions (BIR's own boundaries, not administrative regions).
const BIR_RR = [
  ["1", "Calasiao, Pangasinan", "p-pangasinan"], ["2", "Cordillera Administrative Region", "c-baguio"], ["3", "Tuguegarao City", "c-tuguegarao"],
  ["4", "San Fernando City, Pampanga", "c-san-fernando-pampanga"], ["5", "Caloocan City", "c-caloocan"], ["6", "Manila", "c-manila"],
  ["7", "Quezon City", "c-quezon-city"], ["8", "Makati City", "c-makati"], ["9A", "CaBaMiRo (Cavite, Batangas, Mindoro, Romblon)", "r-4a"],
  ["9B", "LaQueMar (Laguna, Quezon, Marinduque)", "r-4a"], ["10", "Legazpi City", "c-legazpi"], ["11", "Iloilo City", "c-iloilo-city"],
  ["12", "Bacolod City", "c-bacolod"], ["13", "Cebu City", "c-cebu-city"], ["14", "Eastern Visayas (Tacloban City)", "c-tacloban"],
  ["15", "Zamboanga City", "c-zamboanga-city"], ["16", "Cagayan de Oro City", "c-cagayan-de-oro"], ["17", "Butuan City", "c-butuan"],
  ["18", "Koronadal City", "c-koronadal"], ["19", "Davao City", "c-davao-city"],
];
for (const [n, label, geoKey] of BIR_RR) {
  add({
    key: `bir-rr-${n.toLowerCase()}`,
    name: `BIR Revenue Region No. ${n} – ${label}`,
    aliases: [`BIR RR ${n}`, `Revenue Region ${n}`],
    parent: "bir",
    geo: geoKey,
    description: "BIR revenue region supervising the revenue district offices in its area; handles assessments, collection and taxpayer assistance escalations.",
    reviewNote: "Revenue regions follow BIR's own boundaries; verify the number, seat and coverage against the BIR directory.",
  });
}
const BIR_RDO = [
  ["c-valenzuela", "Valenzuela City"], ["c-malabon", "Malabon-Navotas"], ["c-caloocan", "Caloocan City"], ["c-quezon-city", "Novaliches, Quezon City"],
  ["c-manila", "Tondo-San Nicolas, Manila"], ["c-manila", "Binondo, Manila"], ["c-manila", "Sta. Cruz, Manila"], ["c-manila", "Quiapo-Sampaloc-San Miguel-Sta. Mesa, Manila"],
  ["c-manila", "Intramuros-Ermita-Malate, Manila"], ["c-manila", "Paco-Pandacan-Sta. Ana-San Andres, Manila"], ["c-quezon-city", "North Quezon City"],
  ["c-quezon-city", "South Quezon City"], ["c-quezon-city", "Cubao, Quezon City"], ["c-mandaluyong", "Mandaluyong City"], ["c-san-juan", "San Juan City"],
  ["c-pasig", "Pasig City"], ["c-taguig", "Taguig City-Pateros"], ["c-marikina", "Marikina City"], ["c-makati", "East Makati"], ["c-makati", "West Makati"],
  ["c-makati", "North Makati"], ["c-makati", "South Makati"], ["c-pasay", "Pasay City"], ["c-paranaque", "Parañaque City"], ["c-las-pinas", "Las Piñas City"],
  ["c-muntinlupa", "Muntinlupa City"],
  ["c-laoag", "Laoag City"], ["c-vigan", "Vigan City"], ["c-san-fernando-la-union", "San Fernando City, La Union"], ["c-alaminos", "Alaminos City"],
  ["c-urdaneta", "Urdaneta City"], ["c-baguio", "Baguio City"], ["c-tabuk", "Tabuk City"], ["c-tuguegarao", "Tuguegarao City"], ["c-tarlac-city", "Tarlac City"],
  ["c-olongapo", "Olongapo City"], ["c-balanga", "Balanga City"], ["c-angeles", "North Pampanga (Angeles City)"], ["c-san-fernando-pampanga", "South Pampanga (San Fernando City)"],
  ["c-cabanatuan", "South Nueva Ecija (Cabanatuan City)"], ["c-malolos", "West Bulacan (Malolos City)"], ["c-trece-martires", "Trece Martires City"],
  ["c-san-pablo", "San Pablo City"], ["c-calamba", "Calamba City"], ["c-binan", "Biñan City"], ["c-batangas-city", "Batangas City"], ["c-lipa", "Lipa City"],
  ["c-lucena", "Lucena City"], ["c-calapan", "Calapan City"], ["c-puerto-princesa", "Puerto Princesa City"], ["c-naga-camarines-sur", "Naga City, Camarines Sur"],
  ["c-iriga", "Iriga City"], ["c-legazpi", "Legazpi City"], ["c-sorsogon-city", "Sorsogon City"], ["c-masbate-city", "Masbate City"],
  ["c-roxas-city", "Roxas City"], ["c-iloilo-city", "Iloilo City"], ["c-victorias", "Victorias City"], ["c-bacolod", "Bacolod City"], ["c-dumaguete", "Dumaguete City"],
  ["c-mandaue", "Mandaue City"], ["c-cebu-city", "Cebu City North"], ["c-cebu-city", "Cebu City South"], ["c-talisay-cebu", "Talisay City, Cebu"],
  ["c-tagbilaran", "Tagbilaran City"], ["c-borongan", "Borongan City"], ["c-catbalogan", "Catbalogan City"], ["c-tacloban", "Tacloban City"], ["c-ormoc", "Ormoc City"],
  ["c-maasin", "Maasin City"],
  ["c-dipolog", "Dipolog City"], ["c-pagadian", "Pagadian City"], ["c-zamboanga-city", "Zamboanga City"], ["c-isabela-city", "Isabela City, Basilan"],
  ["c-gingoog", "Gingoog City"], ["c-cagayan-de-oro", "Cagayan de Oro City"], ["c-malaybalay", "Malaybalay City"], ["c-ozamiz", "Ozamiz City"], ["c-iligan", "Iligan City"],
  ["c-marawi", "Marawi City"], ["c-butuan", "Butuan City"], ["c-bayugan", "Bayugan City"], ["c-surigao-city", "Surigao City"], ["c-tandag", "Tandag City"],
  ["c-cotabato-city", "Cotabato City"], ["c-kidapawan", "Kidapawan City"], ["c-tacurong", "Tacurong City"], ["c-general-santos", "General Santos City"],
  ["c-koronadal", "Koronadal City"], ["c-tagum", "Tagum City"], ["c-davao-city", "West Davao City"], ["c-davao-city", "East Davao City"], ["c-mati", "Mati City"],
  ["c-digos", "Digos City"],
];
for (const [geoKey, label] of BIR_RDO) {
  const city = geoByKey.get(geoKey);
  add({
    key: `bir-rdo-${slug(label)}`,
    name: `BIR Revenue District Office – ${label}`,
    aliases: [`BIR ${label}`, `RDO ${label}`, `BIR ${city.name}`],
    parent: "bir",
    geo: geoKey,
    description: `BIR revenue district office for taxpayer registration (TIN), filing and payment assistance covering ${label}.`,
    reviewNote: "District number and exact coverage to be verified against the BIR directory.",
  });
}

// DFA consular offices (mostly mall-based; they move).
const DFA = [
  ["ncr-east", "DFA NCR East", "c-mandaluyong", "SM Megamall, Mandaluyong"], ["ncr-west", "DFA NCR West", "c-manila", "SM City Manila"],
  ["ncr-north", "DFA NCR North", "c-quezon-city", "Robinsons Novaliches, Quezon City"], ["ncr-northeast", "DFA NCR Northeast", "c-quezon-city", "Ali Mall, Cubao, Quezon City"],
  ["ncr-south", "DFA NCR South", "c-muntinlupa", "Metro Gaisano Alabang, Muntinlupa"], ["ncr-central", "DFA NCR Central", "c-quezon-city", "Robinsons Galleria, Quezon City"],
  ["baguio", "DFA Consular Office Baguio", "c-baguio"], ["ilocos-norte", "DFA Consular Office Ilocos Norte", "c-laoag"], ["la-union", "DFA Consular Office La Union", "c-san-fernando-la-union"],
  ["tuguegarao", "DFA Consular Office Tuguegarao", "c-tuguegarao"], ["pampanga", "DFA Consular Office Pampanga", "c-san-fernando-pampanga"], ["clark", "DFA Consular Office Clark", "c-angeles"],
  ["malolos", "DFA Consular Office Malolos", "c-malolos"], ["antipolo", "DFA Consular Office Antipolo", "c-antipolo"], ["lipa", "DFA Consular Office Lipa", "c-lipa"],
  ["lucena", "DFA Consular Office Lucena", "c-lucena"], ["puerto-princesa", "DFA Consular Office Puerto Princesa", "c-puerto-princesa"], ["legazpi", "DFA Consular Office Legazpi", "c-legazpi"],
  ["iloilo", "DFA Consular Office Iloilo", "c-iloilo-city"], ["bacolod", "DFA Consular Office Bacolod", "c-bacolod"], ["dumaguete", "DFA Consular Office Dumaguete", "c-dumaguete"],
  ["cebu", "DFA Consular Office Cebu", "c-mandaue", "Pacific Mall, Mandaue City"], ["tacloban", "DFA Consular Office Tacloban", "c-tacloban"], ["tagbilaran", "DFA Consular Office Tagbilaran", "c-tagbilaran"],
  ["zamboanga", "DFA Consular Office Zamboanga", "c-zamboanga-city"], ["pagadian", "DFA Consular Office Pagadian", "c-pagadian"], ["dipolog", "DFA Consular Office Dipolog", "c-dipolog"],
  ["cagayan-de-oro", "DFA Consular Office Cagayan de Oro", "c-cagayan-de-oro"], ["butuan", "DFA Consular Office Butuan", "c-butuan"], ["davao", "DFA Consular Office Davao", "c-davao-city"],
  ["general-santos", "DFA Consular Office General Santos", "c-general-santos"], ["cotabato", "DFA Consular Office Cotabato", "c-cotabato-city"],
];
for (const [k, name, geoKey, where] of DFA) {
  const short = name.replace(/^DFA (Consular Office )?/, "");
  add({
    key: `dfa-co-${k}`,
    name,
    aliases: [`DFA ${short}`, `DFA ${short} Consular Office`, `Passport office ${geoByKey.get(geoKey).name}`],
    parent: "dfa",
    geo: geoKey,
    description: "DFA consular office for passport applications and renewals (by appointment) and, at some offices, apostille of documents.",
    reviewNote: `${where ? `Located at ${where} at last check. ` : ""}Consular offices are mostly in malls and move; confirm the current location and services.`,
  });
}

// Bureau of Immigration field offices.
const BI = [
  ["baguio", "Baguio", "c-baguio"], ["clark", "Clark", "c-angeles"], ["subic", "Subic", "c-olongapo"], ["batangas", "Batangas", "c-batangas-city"],
  ["legazpi", "Legazpi", "c-legazpi"], ["puerto-princesa", "Puerto Princesa", "c-puerto-princesa"], ["iloilo", "Iloilo", "c-iloilo-city"], ["bacolod", "Bacolod", "c-bacolod"],
  ["cebu", "Cebu", "c-cebu-city"], ["tacloban", "Tacloban", "c-tacloban"], ["zamboanga", "Zamboanga", "c-zamboanga-city"], ["cagayan-de-oro", "Cagayan de Oro", "c-cagayan-de-oro"],
  ["davao", "Davao", "c-davao-city"], ["general-santos", "General Santos", "c-general-santos"], ["cotabato", "Cotabato", "c-cotabato-city"],
];
for (const [k, label, geoKey] of BI) {
  add({ key: `bi-fo-${k}`, name: `Bureau of Immigration ${label} Field Office`, aliases: [`BI ${label}`, `Immigration ${label}`], parent: "bi", geo: geoKey, description: "Bureau of Immigration field office for visa extensions, ACR I-Card and other alien registration transactions.", reviewNote: "Confirm against the BI field office directory; some offices are 'satellite' or 'one-stop-shop' offices." });
}

// SEC extension offices, Insurance Commission district offices, Ombudsman area offices.
const SEC = [
  ["baguio", "Baguio", "c-baguio"], ["tarlac", "Tarlac", "c-tarlac-city"], ["legazpi", "Legazpi", "c-legazpi"], ["iloilo", "Iloilo", "c-iloilo-city"],
  ["cebu", "Cebu", "c-cebu-city"], ["zamboanga", "Zamboanga", "c-zamboanga-city"], ["cagayan-de-oro", "Cagayan de Oro", "c-cagayan-de-oro"], ["davao", "Davao", "c-davao-city"],
  ["tacloban", "Tacloban", "c-tacloban"],
];
for (const [k, label, geoKey] of SEC) {
  add({ key: `sec-eo-${k}`, name: `SEC ${label} Extension Office`, aliases: [`SEC ${label}`], parent: "sec", geo: geoKey, description: "SEC extension office for corporate and partnership registration, filings and certified documents.", reviewNote: k === "tacloban" ? "Newer extension office; confirm it is operating." : "Confirm address." });
}
add({ key: "ic-cebu", name: "Insurance Commission Cebu District Office", aliases: ["IC Cebu"], parent: "insurance-commission", geo: "c-cebu-city", description: "Insurance Commission district office receiving insurance, pre-need and HMO complaints in the Visayas.", reviewNote: "Confirm address." });
add({ key: "ic-davao", name: "Insurance Commission Davao District Office", aliases: ["IC Davao"], parent: "insurance-commission", geo: "c-davao-city", description: "Insurance Commission district office receiving insurance, pre-need and HMO complaints in Mindanao.", reviewNote: "Confirm address." });
for (const [k, area, geoKey] of [["luzon", "Luzon", "c-quezon-city"], ["visayas", "the Visayas", "c-cebu-city"], ["mindanao", "Mindanao", "c-davao-city"], ["moleo", "the Military and Other Law Enforcement Offices", "c-quezon-city"]]) {
  add({ key: `ombudsman-${k}`, name: `Office of the Deputy Ombudsman for ${area}`, aliases: [`Ombudsman ${area.replace(/^the /, "")}`, k === "moleo" ? "MOLEO" : null], parent: "ombudsman", geo: geoKey, description: `Receives and investigates complaints against public officials ${k === "moleo" ? "in the military and law enforcement" : `in ${area}`}.`, reviewNote: "Confirm address." });
}

// Bureau of Customs collection districts (the four Metro Manila / Cebu ports are already seeded).
const BOC = [
  ["batangas", "Batangas", "c-batangas-city"], ["subic", "Subic", "c-olongapo"], ["clark", "Clark", "c-angeles"], ["limay", "Limay", "p-bataan"],
  ["san-fernando", "San Fernando", "c-san-fernando-la-union"], ["aparri", "Aparri", "p-cagayan"], ["legazpi", "Legazpi", "c-legazpi"], ["iloilo", "Iloilo", "c-iloilo-city"],
  ["tacloban", "Tacloban", "c-tacloban"], ["surigao", "Surigao", "c-surigao-city"], ["cagayan-de-oro", "Cagayan de Oro", "c-cagayan-de-oro"], ["zamboanga", "Zamboanga", "c-zamboanga-city"],
  ["davao", "Davao", "c-davao-city"],
];
for (const [k, label, geoKey] of BOC) {
  add({ key: `boc-port-of-${k}`, name: `BOC Port of ${label}`, aliases: [`Port of ${label} Customs`, `Customs ${label}`], parent: "boc", geo: geoKey, description: `Customs collection district for the Port of ${label}: import and export clearance, duties and passenger baggage.`, reviewNote: geoKey.startsWith("p-") ? "Port is in a municipality not yet in the geography; placed at province level." : "Confirm address." });
}

// ---------------------------------------------------------------------------------------------
writeFileSync(join(root, "data/ph/offices.json"), JSON.stringify({ country: base.country, geo: [], entities }, null, 1) + "\n");
const byType = {};
for (const e of entities) byType[e.type] = (byType[e.type] ?? 0) + 1;
console.log(`wrote ${entities.length} entities to data/ph/offices.json`, byType);
