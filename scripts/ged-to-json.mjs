#!/usr/bin/env node
/**
 * GEDCOM (Gramps) -> minimal JSON for a Pechgrün GED browser:
 * - people.json (id -> person)
 * - families.json (id -> family)
 * - surnames.json (sorted unique surnames)
 * - surnameToPersons.json (surname -> sorted person ids)
 * - import-report.json (counts + warnings)
 *
 * Whitelist tags only; ignore the rest safely.
 *
 * to run script from project directory root: scripts/ged-to-json.mjs ~/Desktop/test.ged public/data/ged
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const INPUT = process.argv[2] || "test.ged";
const OUTDIR = process.argv[3] || "public/data/ged";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function stripXref(x) {
  // "@I123@" -> "I123"
  return typeof x === "string" ? x.replace(/^@|@$/g, "") : null;
}

function parseLine(line) {
  // GEDCOM line: <level> [@XREF@] <TAG> [VALUE]
  const m = line.match(/^(\d+)\s+(?:(@[^@]+@)\s+)?([A-Z0-9_]+)(?:\s+(.*))?$/);
  if (!m) return null;
  return {
    level: Number(m[1]),
    xref: m[2] || null,
    tag: m[3],
    value: (m[4] ?? "").trim(),
  };
}

/**
 * Display vs. Key:
 * - surnameDisplay: keep as-is (trim + collapse spaces)
 * - surnameKey: uppercase key only for grouping (case-insensitive)
 */
function surnameDisplay(s) {
  if (!s) return "";
  return String(s).trim().replace(/\s+/g, " ");
}

function surnameKey(s) {
  return surnameDisplay(s).toUpperCase();
}

function normalizePlace(s) {
  if (!s) return "";
  return s.trim().replace(/\s+/g, " ");
}

// --- ADDITIVE: GEDCOM date normalization (display-only) ---
// Goal:
//   "28 FEB 1924"      -> "28.02.1924"
//   "FEB 1924"         -> "02.1924"
//   "1924"             -> "1924"
//   "ABT 1924"         -> "ca. 1924"
//   "BEF FEB 1924"     -> "vor 02.1924"
//   "ABT 28 FEB 1924"  -> "ca. 28.02.1924"
//
// Supported qualifiers (as per your data reality): ABT, BEF
// Everything else: return original trimmed string unchanged.

const GED_MONTH = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12",
};

function normalizeGedcomDateDisplay(dateStr) {
  if (!dateStr) return null;
  const s0 = String(dateStr).trim().replace(/\s+/g, " ");
  if (!s0) return null;

  // Qualifier handling (only ABT/BEF, per your constraints)
  let prefix = "";
  let s = s0;

  const qm = s.match(/^(ABT|BEF)\s+(.*)$/i);
  if (qm) {
    const q = qm[1].toUpperCase();
    s = (qm[2] || "").trim();
    if (q === "ABT") prefix = "ca. ";
    else if (q === "BEF") prefix = "vor ";
  }

  // Try to parse: [DD] MON YYYY  (DD optional)
  // Examples: "28 FEB 1924", "FEB 1924"
  const m = s.match(/^(?:(\d{1,2})\s+)?([A-Z]{3})\s+(\d{4})$/i);
  if (m) {
    const dayRaw = m[1] ? Number(m[1]) : null;
    const monKey = m[2].toUpperCase();
    const year = m[3];

    const mm = GED_MONTH[monKey];
    if (!mm) return prefix ? prefix + s : s0; // unexpected month token

    if (dayRaw != null && Number.isFinite(dayRaw) && dayRaw >= 1 && dayRaw <= 31) {
      const dd = String(dayRaw).padStart(2, "0");
      return `${prefix}${dd}.${mm}.${year}`;
    }
    // Month + year only
    return `${prefix}${mm}.${year}`;
  }

  // Year only: "1924"
  const y = s.match(/^(\d{4})$/);
  if (y) return `${prefix}${y[1]}`;

  // Fallback: unchanged (but keep qualifier prefix if we recognized one)
  return prefix ? prefix + s : s0;
}
// --- END ADDITIVE ---

function extractYear(dateStr) {
  // GRAMPS export uses e.g. "28 FEB 1924"
  const m = dateStr.match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

function pickPrimaryName(names) {
  // Prefer the NAME without TYPE married (Gramps usually exports married name as TYPE married)
  if (!Array.isArray(names) || names.length === 0) return null;
  const notMarried = names.find((n) => (n.type || "").toLowerCase() !== "married");
  return notMarried || names[0];
}

function localeCompareDE(a, b) {
  // German-friendly sorting; falls back fine in most environments
  return a.localeCompare(b, "de", { sensitivity: "base" });
}

async function main() {
  ensureDir(OUTDIR);

  const people = new Map(); // id -> raw person
  const families = new Map(); // id -> raw family

  const report = {
    inputFile: INPUT,
    outputDir: OUTDIR,
    counts: { individuals: 0, families: 0 },
    ignoredTagsTop: {}, // filled later
    warnings: {
      brokenRefs: 0,
      externalRefs: 0,
      notes:
        "External refs are expected in a Pechgrün subset; broken refs indicate malformed GED or parsing issues.",
    },
    parseErrors: 0,
    examples: {
      brokenRefSamples: [],
    },
  };

  const ignoredTags = new Map(); // tag -> count

  // Current record state
  let currentType = null; // "INDI" | "FAM" | null
  let currentId = null;

  let currentPerson = null;
  let currentFamily = null;

  let currentEvent = null; // "BIRT" | "DEAT" | "MARR" | null
  let currentName = null;

  function flushCurrent() {
    if (currentType === "INDI" && currentPerson && currentId) {
      people.set(currentId, currentPerson);
      report.counts.individuals += 1;
    } else if (currentType === "FAM" && currentFamily && currentId) {
      families.set(currentId, currentFamily);
      report.counts.families += 1;
    }
    currentType = null;
    currentId = null;
    currentPerson = null;
    currentFamily = null;
    currentEvent = null;
    currentName = null;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(INPUT, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const rec = parseLine(line);
    if (!rec) {
      report.parseErrors += 1;
      continue;
    }

    // Start of a new record
    if (rec.level === 0) {
      // close out any open NAME
      if (currentType === "INDI" && currentPerson && currentName) {
        currentPerson.names.push(currentName);
        currentName = null;
      }
      flushCurrent();

      // Identify record
      if (rec.tag === "INDI" && rec.xref) {
        currentType = "INDI";
        currentId = stripXref(rec.xref);
        currentPerson = {
          id: currentId,
          names: [],
          sex: null,
          birth: { date: null, place: null, year: null },
          death: { date: null, place: null, year: null },
          occupation: null,
          famc: [],
          fams: [],
        };
      } else if (rec.tag === "FAM" && rec.xref) {
        currentType = "FAM";
        currentId = stripXref(rec.xref);
        currentFamily = {
          id: currentId,
          husband: null,
          wife: null,
          children: [],
          marriage: { date: null, place: null, year: null },
        };
      } else {
        // HEAD, SUBM, etc. ignore
        currentType = null;
        currentId = null;
      }
      continue;
    }

    // If we're not inside INDI or FAM, ignore
    if (!currentType) continue;

    // --- INDI parsing (whitelist) ---
    if (currentType === "INDI") {
      // Begin new NAME at level 1
      if (rec.level === 1 && rec.tag === "NAME") {
        if (currentName) currentPerson.names.push(currentName);
        currentName = {
          raw: rec.value || null,
          givn: null,
          surn: null,
          type: null,
        };
        currentEvent = null;
        continue;
      }

      // If we see any new level-1 tag (BIRT/DEAT/FAMC/...), the NAME block is finished.
      // Otherwise level-2 DATE/PLAC lines would be wrongly swallowed as NAME subfields.
      if (rec.level === 1 && currentName && rec.tag !== "NAME") {
        currentPerson.names.push(currentName);
        currentName = null;
      }

      // NAME subfields at level 2
      if (rec.level === 2 && currentName) {
        if (rec.tag === "GIVN") currentName.givn = rec.value || null;
        else if (rec.tag === "SURN") currentName.surn = rec.value || null;
        else if (rec.tag === "TYPE") currentName.type = rec.value || null;
        else {
          ignoredTags.set(rec.tag, (ignoredTags.get(rec.tag) || 0) + 1);
        }
        continue;
      }

      // Core fields
      if (rec.level === 1 && rec.tag === "SEX") {
        currentPerson.sex = rec.value || null;
        currentEvent = null;
        continue;
      }
      if (rec.level === 1 && rec.tag === "OCCU") {
        currentPerson.occupation = rec.value || null;
        currentEvent = null;
        continue;
      }
      if (rec.level === 1 && rec.tag === "FAMC") {
        currentPerson.famc.push(stripXref(rec.value));
        currentEvent = null;
        continue;
      }
      if (rec.level === 1 && rec.tag === "FAMS") {
        currentPerson.fams.push(stripXref(rec.value));
        currentEvent = null;
        continue;
      }

      // Events
      if (rec.level === 1 && (rec.tag === "BIRT" || rec.tag === "DEAT")) {
        currentEvent = rec.tag;
        continue;
      }
      if (rec.level === 2 && currentEvent) {
        if (rec.tag === "DATE") {
          if (currentEvent === "BIRT") {
            // CHANGED (minimal): normalize display date at import-time
            currentPerson.birth.date = normalizeGedcomDateDisplay(rec.value) || null;
            currentPerson.birth.year = extractYear(rec.value);
          } else if (currentEvent === "DEAT") {
            // CHANGED (minimal): normalize display date at import-time
            currentPerson.death.date = normalizeGedcomDateDisplay(rec.value) || null;
            currentPerson.death.year = extractYear(rec.value);
          }
        } else if (rec.tag === "PLAC") {
          if (currentEvent === "BIRT") currentPerson.birth.place = normalizePlace(rec.value);
          else if (currentEvent === "DEAT") currentPerson.death.place = normalizePlace(rec.value);
        } else {
          // Ignore event sub-tags
          ignoredTags.set(rec.tag, (ignoredTags.get(rec.tag) || 0) + 1);
        }
        continue;
      }

      // Everything else in INDI ignored (CHAN, FACT, SOUR, NOTE, etc.)
      ignoredTags.set(rec.tag, (ignoredTags.get(rec.tag) || 0) + 1);
      continue;
    }

    // --- FAM parsing (whitelist) ---
    if (currentType === "FAM") {
      if (rec.level === 1 && rec.tag === "HUSB") {
        currentFamily.husband = stripXref(rec.value);
        currentEvent = null;
        continue;
      }
      if (rec.level === 1 && rec.tag === "WIFE") {
        currentFamily.wife = stripXref(rec.value);
        currentEvent = null;
        continue;
      }
      if (rec.level === 1 && rec.tag === "CHIL") {
        currentFamily.children.push(stripXref(rec.value));
        currentEvent = null;
        continue;
      }
      if (rec.level === 1 && rec.tag === "MARR") {
        currentEvent = "MARR";
        continue;
      }
      if (rec.level === 2 && currentEvent === "MARR") {
        if (rec.tag === "DATE") {
          // CHANGED (minimal): normalize display date at import-time
          currentFamily.marriage.date = normalizeGedcomDateDisplay(rec.value) || null;
          currentFamily.marriage.year = extractYear(rec.value);
        } else if (rec.tag === "PLAC") {
          currentFamily.marriage.place = normalizePlace(rec.value);
        } else {
          ignoredTags.set(rec.tag, (ignoredTags.get(rec.tag) || 0) + 1);
        }
        continue;
      }

      ignoredTags.set(rec.tag, (ignoredTags.get(rec.tag) || 0) + 1);
      continue;
    }
  }

  // Flush last record
  if (currentType === "INDI" && currentPerson && currentName) {
    currentPerson.names.push(currentName);
    currentName = null;
  }
  flushCurrent();

  // Post-process: choose primary name + build indices + validate refs
  const peopleOut = {};
  const familiesOut = {};

  // Build a quick set for ref checks
  const personIds = new Set(people.keys());
  const familyIds = new Set(families.keys());

  // Convert persons
  for (const [id, p] of people.entries()) {
    const primary = pickPrimaryName(p.names);
    const given = primary?.givn || null;

    const surnRaw = primary?.surn || null;

    let surnameIndex = surnRaw; // what we store as "surname" (used for indexing)
    let displaySurname = surnRaw; // what we show in UI
    let legBirthSurname = null; // left side before ", leg."
    let legNewSurname = null; // right side after ", leg."

    if (typeof surnRaw === "string") {
      // EXACT convention: "<birthSurname>, leg. <newSurname>"
      const m = surnRaw.match(/^\s*(.+?)\s*,\s*leg\.\s*(.+?)\s*$/i);
      if (m) {
        legBirthSurname = (m[1] || "").trim();
        legNewSurname = (m[2] || "").trim();
        if (legNewSurname) {
          // Your requested behavior:
          surnameIndex = legNewSurname; // index under the legitimating surname
          displaySurname = `${legNewSurname} (leg.)`; // simplest UI marker
          // If you ever prefer Variant B instead, swap the previous line for:
          // displaySurname = `${legNewSurname} (geb. ${legBirthSurname})`;
        }
      }
    }

    const displayName =
      given && displaySurname
        ? `${given} ${displaySurname}`
        : primary?.raw
          ? primary.raw.replace(/\//g, "").trim()
          : id;

    // Check refs; treat missing as external (expected)
    for (const f of p.famc) {
      if (!f) continue;
      if (!familyIds.has(f)) {
        report.warnings.externalRefs += 1;
      }
    }
    for (const f of p.fams) {
      if (!f) continue;
      if (!familyIds.has(f)) {
        report.warnings.externalRefs += 1;
      }
    }

    peopleOut[id] = {
      id,
      name: {
        given,
        surname: surnameIndex || null, // used for index keys like Heinzl / Kneiss(l)
        display: displayName,
        ...(legBirthSurname ? { legBirthSurname } : {}), // optional, harmless
        ...(legNewSurname ? { legNewSurname } : {}),
        ...(surnRaw ? { surnameRaw: surnRaw } : {}),
      },
      sex: p.sex,
      birth: p.birth,
      death: p.death,
      occupation: p.occupation,
      famc: p.famc.filter(Boolean),
      fams: p.fams.filter(Boolean),
    };
  }

  // Convert families
  for (const [id, f] of families.entries()) {
    // Validate refs
    for (const pid of [f.husband, f.wife, ...(f.children || [])]) {
      if (!pid) continue;
      if (!personIds.has(pid)) {
        // This should be rare if it's truly a subset; treat as external, not broken.
        report.warnings.externalRefs += 1;
      }
    }

    familiesOut[id] = {
      id,
      husband: f.husband,
      wife: f.wife,
      children: (f.children || []).filter(Boolean),
      marriage: f.marriage,
    };
  }

  // Build surname index:
  // group by KEY (uppercase) but OUTPUT DISPLAY (original case)
  const keyToIds = new Map(); // KEY -> [personId]
  const keyToDisplay = new Map(); // KEY -> first-seen DISPLAY label

  for (const [id, p] of Object.entries(peopleOut)) {
    const disp = surnameDisplay(p.name.surname || "");
    const key = disp ? surnameKey(disp) : "(UNKNOWN)";

    if (!keyToIds.has(key)) keyToIds.set(key, []);
    keyToIds.get(key).push(id);

    if (key !== "(UNKNOWN)" && !keyToDisplay.has(key) && disp) {
      keyToDisplay.set(key, disp);
    }
  }

  // Sort persons within surname
  for (const [k, ids] of keyToIds.entries()) {
    ids.sort((a, b) => {
      const pa = peopleOut[a];
      const pb = peopleOut[b];
      const ga = (pa?.name?.given || "").trim();
      const gb = (pb?.name?.given || "").trim();
      const c1 = localeCompareDE(ga, gb);
      if (c1 !== 0) return c1;

      const ya = pa?.birth?.year ?? 9999;
      const yb = pb?.birth?.year ?? 9999;
      if (ya !== yb) return ya - yb;

      return localeCompareDE(pa?.name?.display || a, pb?.name?.display || b);
    });
  }

  // Sort surname list by DISPLAY labels
  const surnames = Array.from(keyToIds.keys())
    .map((k) => {
      if (k === "(UNKNOWN)") return "(UNKNOWN)";
      return keyToDisplay.get(k) || k;
    })
    .sort(localeCompareDE);

  // Build surnameToPersons with DISPLAY labels as keys
  const surnameToPersons = {};
  for (const disp of surnames) {
    if (disp === "(UNKNOWN)") {
      surnameToPersons["(UNKNOWN)"] = keyToIds.get("(UNKNOWN)") || [];
      continue;
    }
    const k = surnameKey(disp);
    surnameToPersons[disp] = keyToIds.get(k) || [];
  }

  // Write outputs
  fs.writeFileSync(path.join(OUTDIR, "people.json"), JSON.stringify(peopleOut, null, 2), "utf8");
  fs.writeFileSync(path.join(OUTDIR, "families.json"), JSON.stringify(familiesOut, null, 2), "utf8");
  fs.writeFileSync(path.join(OUTDIR, "surnames.json"), JSON.stringify(surnames, null, 2), "utf8");
  fs.writeFileSync(
    path.join(OUTDIR, "surnameToPersons.json"),
    JSON.stringify(surnameToPersons, null, 2),
    "utf8"
  );

  // ignored tags top list
  const ignoredArr = Array.from(ignoredTags.entries()).sort((a, b) => b[1] - a[1]);
  report.ignoredTagsTop = Object.fromEntries(ignoredArr.slice(0, 30));

  fs.writeFileSync(path.join(OUTDIR, "import-report.json"), JSON.stringify(report, null, 2), "utf8");

  console.log(`✅ Wrote JSON to ${OUTDIR}`);
  console.log(`   people:   ${Object.keys(peopleOut).length}`);
  console.log(`   families: ${Object.keys(familiesOut).length}`);
  console.log(`   surnames: ${surnames.length}`);
  console.log(`   report:   import-report.json`);
}

main().catch((err) => {
  console.error("❌ Import failed:", err);
  process.exit(1);
});
