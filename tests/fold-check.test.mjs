import assert from "node:assert/strict";
import test from "node:test";
import {
  CHECK_CLASSES,
  FOLD_FORMAT,
  FOLD_VERSION,
  foldProblems,
  isAuthorText,
  isFold,
  isWrittenText,
} from "../shared/fold-format.mjs";
import {
  NUMBER_GAP,
  PAYLOAD_CLASSES,
  checkFormat,
  checkLine,
  checkMonotonic,
  checkPins,
  checkWrittenUnit,
  countWords,
  extractPayload,
  validateEvidence,
} from "../shared/fold-check.mjs";

const HASH = "b".repeat(64);
const makeEvidence = (unitText, quote, elementId = "paragraph-ab12cd34", sentence = 0) => {
  const start = unitText.indexOf(quote);
  assert.ok(start >= 0, `test fixture quote must appear in unitText: ${quote}`);
  return { elementId, quote, sentence, start, end: start + quote.length };
};
const written = (text, quotes, elementId = "paragraph-ab12cd34") => ({
  by: "model",
  text,
  evidence: quotes.map((quote, index) => ({ elementId, quote, sentence: index, start: 0, end: quote.length })),
});

test("PAYLOAD_CLASSES enumerates the 7 semantic ES/EN classes within CHECK_CLASSES", () => {
  assert.deepEqual(PAYLOAD_CLASSES, [
    "negation", "restriction", "condition", "uncertainty", "number", "scope", "attribution",
  ]);
  for (const cls of PAYLOAD_CLASSES) assert.ok(CHECK_CLASSES.includes(cls), cls);
  assert.equal(NUMBER_GAP, "—?");
});

// --- Class 1: Negation (EN + ES) ---
test("negation (EN): preserves polarity, catches dropped or invented negation and contractions", () => {
  const ev = "Do not give fluids in pulmonary edema.";
  assert.equal(checkLine("Never give fluids in pulmonary edema.", ev).checks.negation, "pass");
  assert.equal(checkLine("Don't give fluids in pulmonary edema.", ev).checks.negation, "pass");

  const dropped = checkLine("Give fluids in pulmonary edema.", ev);
  assert.equal(dropped.ok, false);
  assert.equal(dropped.checks.negation, "fail");
  assert.equal(dropped.findings[0].code, "dropped_negation");
  assert.equal(dropped.findings[0].action, "retry");
  assert.ok(dropped.retryTokens.some(t => /do not/i.test(t)));

  const invented = checkLine("Do not start IV furosemide 40 mg.", "Start IV furosemide 40 mg.");
  assert.equal(invented.checks.negation, "fail");
  assert.equal(invented.findings[0].code, "invented_negation");

  const contra = checkLine("Safe in pregnancy.", "Contraindicated in pregnancy.");
  assert.equal(contra.checks.negation, "fail");
  assert.equal(checkLine("Do not use in pregnancy.", "Contraindicated in pregnancy.").checks.negation, "pass");

  const withoutDrop = checkLine("Start antibiotics.", "Without delay, start antibiotics.");
  assert.equal(withoutDrop.checks.negation, "fail");
});

test("negation (ES): handles negative concord, contraindications, exceptions, and Unicode word boundaries", () => {
  const mh = "El óxido nitroso y el propofol no la desencadenan.";
  assert.equal(checkLine("NO N2O ni propofol.", mh).checks.negation, "pass");
  assert.equal(checkLine("N2O y propofol la desencadenan.", mh).checks.negation, "fail");

  const met = "Metformina está contraindicada en ERC por debajo de 30.";
  assert.equal(checkLine("No usar metformina en ERC <30.", met).checks.negation, "pass");
  assert.equal(checkLine("Usar metformina en ERC <30.", met).checks.negation, "fail");

  // Exception paired with negation: dropping "salvo" inverts meaning.
  const lease = "El arrendador no podrá resolver salvo impago.";
  assert.equal(checkLine("El arrendador no resuelve salvo impago.", lease).checks.negation, "pass");
  assert.equal(checkLine("El arrendador no podrá resolver.", lease).checks.negation, "fail");
  assert.equal(checkLine("El arrendador podrá resolver salvo impago.", lease).checks.negation, "fail");

  // Unicode boundary guard: "niño" must NOT match "ni", "sinusal" must NOT match "sin".
  assert.equal(extractPayload("Ritmo sinusal en un niño sano.").negation.length, 0);
  assert.equal(checkLine("Ritmo sinusal en niños.", "Ritmo sinusal en niños.").checks.negation, "pass");
});

// --- Class 2: Restriction (EN + ES) ---
test("restriction (EN + ES): keeps exclusivity and universality; distinguishes 'siempre que' conditional", () => {
  const enExcl = "Give epinephrine only in anaphylaxis.";
  assert.equal(checkLine("Epinephrine only in anaphylaxis.", enExcl).checks.restriction, "pass");
  assert.equal(checkLine("Epinephrine solely in anaphylaxis.", enExcl).checks.restriction, "pass");
  const enDrop = checkLine("Give epinephrine in anaphylaxis.", enExcl);
  assert.equal(enDrop.checks.restriction, "fail");
  assert.ok(enDrop.retryTokens.includes("only"));

  const enUniv = "Always check potassium before insulin.";
  assert.equal(checkLine("Always check K+ before insulin.", enUniv).checks.restriction, "pass");
  assert.equal(checkLine("Check K+ before insulin.", enUniv).checks.restriction, "fail");

  const esExcl = "Administrar únicamente por vía intravenosa.";
  assert.equal(checkLine("Solo vía IV.", esExcl).checks.restriction, "pass");
  const esDrop = checkLine("Administrar por vía IV.", esExcl);
  assert.equal(esDrop.checks.restriction, "fail");
  assert.ok(esDrop.retryTokens.some(t => /únicamente/i.test(t)));

  const esUniv = "Monitorizar siempre el EtCO2 tras intubación.";
  assert.equal(checkLine("Siempre monitorizar EtCO2 tras intubación.", esUniv).checks.restriction, "pass");
  assert.equal(checkLine("Monitorizar EtCO2 tras intubación.", esUniv).checks.restriction, "fail");

  // "siempre que" is a conditional ("provided that"), NOT universality "siempre".
  const siempreQue = "El arrendatario podrá resolver siempre que avise por escrito.";
  assert.equal(extractPayload(siempreQue).restriction.length, 0);
  assert.equal(extractPayload(siempreQue).condition.length, 1);
  assert.equal(checkLine("Arrendatario resuelve si avisa por escrito.", siempreQue).ok, true);
});

// --- Class 3: Condition (EN + ES) ---
test("condition (EN + ES): keeps conditionals and negative conditionals; guards 'si' vs 'sí'", () => {
  const enIf = "Start IV furosemide 40 mg if diuretic-naive.";
  assert.equal(checkLine("IV furosemide 40 mg if diuretic-naive.", enIf).checks.condition, "pass");
  assert.equal(checkLine("Start IV furosemide 40 mg.", enIf).checks.condition, "fail");

  // Fixture 10 pattern: "do not ... unless ..."
  const enUnless = "Do not stop beta-blocker unless shock.";
  assert.equal(checkLine("Never stop beta-blocker unless shock.", enUnless).ok, true);
  assert.equal(checkLine("Never stop beta-blocker except in shock.", enUnless).ok, true);
  assert.equal(checkLine("Never stop beta-blocker.", enUnless).checks.condition, "fail");
  assert.equal(checkLine("Never stop beta-blocker if shock.", enUnless).checks.condition, "fail");

  const esCond = "En caso de alergia grave, usar aztreonam.";
  assert.equal(checkLine("Si alergia grave, usar aztreonam.", esCond).checks.condition, "pass");
  assert.equal(checkLine("Usar aztreonam.", esCond).checks.condition, "fail");

  const esNegCond = "No suspender betabloqueantes a menos que haya shock.";
  assert.equal(checkLine("No suspender betabloqueantes salvo shock.", esNegCond).ok, true);
  assert.equal(checkLine("No suspender betabloqueantes.", esNegCond).checks.condition, "fail");
  assert.equal(checkLine("No suspender betabloqueantes si hay shock.", esNegCond).checks.condition, "fail");

  // Accented "sí" ("yes") must NOT be parsed as conditional "si" ("if").
  assert.equal(extractPayload("El paciente respondió que sí.").condition.length, 0);
  assert.equal(extractPayload("Si hay fiebre, hemocultivos.").condition.length, 1);
});

// --- Class 4: Uncertainty / frequency (EN + ES) ---
test("uncertainty (EN + ES): rejects upgrading hedges or low frequency to certainty or high frequency", () => {
  const enMay = "Hyperkalemia may occur with spironolactone.";
  assert.equal(checkLine("Hyperkalemia may occur.", enMay).checks.uncertainty, "pass");
  assert.equal(checkLine("Hyperkalemia occurs.", enMay).checks.uncertainty, "fail");
  assert.equal(checkLine("Hyperkalemia always occurs.", enMay).checks.uncertainty, "fail");

  const enRare = "Lactic acidosis is rare with metformin.";
  assert.equal(checkLine("Rare: lactic acidosis.", enRare).checks.uncertainty, "pass");
  assert.equal(checkLine("Lactic acidosis is common.", enRare).checks.uncertainty, "fail");
  assert.equal(checkLine("Lactic acidosis occurs.", enRare).checks.uncertainty, "fail");

  const enSupport = "BNP >100 pg/mL supports the diagnosis.";
  assert.equal(checkLine("BNP >100 pg/mL supports dx.", enSupport).ok, true);
  assert.equal(checkLine("BNP >100 pg/mL confirms dx.", enSupport).checks.uncertainty, "fail");

  const esPuede = "La metformina puede causar acidosis láctica rara.";
  assert.equal(checkLine("Puede causar acidosis láctica rara.", esPuede).checks.uncertainty, "pass");
  assert.equal(checkLine("Causa acidosis láctica.", esPuede).checks.uncertainty, "fail");
  assert.equal(checkLine("Causa acidosis láctica frecuente.", esPuede).checks.uncertainty, "fail");

  const esSuele = "El primer signo suele ser el aumento del EtCO2.";
  assert.equal(checkLine("Habitualmente el primer signo es ↑EtCO2.", esSuele).checks.uncertainty, "pass");
  assert.equal(checkLine("El primer signo es raramente ↑EtCO2.", esSuele).checks.uncertainty, "fail");

  // "seguro" ("safe") in ES is not a certainty marker; "cannot" is negation, not uncertainty.
  assert.equal(extractPayload("El propofol es seguro.").uncertainty.length, 0);
  assert.equal(extractPayload("Patient cannot tolerate beta-blockers.").uncertainty.length, 0);
});

// --- Class 5: Number + unit + direction (EN + ES) ---
test("number (EN + ES): verifies values, canonical units, directions, ranges, ES decimals, and replaces bad numbers with —?", () => {
  // Exact match and unit canonicalization (ES comma vs EN dot, µg vs mcg, horas vs h).
  assert.equal(checkLine("Dantroleno 2.5 mg/kg IV, repetir hasta 10 mg/kg.", "Dantroleno 2,5 mg/kg IV, repetible hasta 10 mg/kg.").ok, true);
  assert.equal(checkLine("Fentanyl 50 mcg IV over 6 h.", "Fentanyl 50 µg IV over 6 hours.").ok, true);

  // Verbal comparator in evidence matches symbolic comparator in line (Fixture 7: Metformin & CKD).
  const metEv = "En enfermedad renal crónica, reducir dosis por debajo de 45 y contraindicada por debajo de 30.";
  assert.equal(checkLine("En ERC: <45 reducir dosis; <30 contraindicada.", metEv).ok, true);

  // Spelled-out number + unit in evidence authorizes digits in line (ES + EN).
  assert.equal(checkLine("Monitorizar función renal cada 3 meses.", "Monitorizar la función renal cada tres meses.").ok, true);
  assert.equal(checkLine("Aviso escrito ≥30 días tras 6 meses.", "Tras seis meses, con al menos 30 días de antelación.").ok, true);
  assert.equal(checkLine("Assess perfusion within 1 h.", "Assess perfusion within the first hour.").ok, true);

  // Directional arrows (↑ / ↓) on numbers and multiple bad numbers replaced without offset drift.
  assert.equal(checkLine("Risk ↓20% with therapy.", "Risk ↓20% with therapy.").ok, true);
  assert.equal(checkLine("Risk ↑20% with therapy.", "Risk ↓20% with therapy.").checks.number, "fail");
  const multiBad = checkLine("Give 80 mg then 120 mg.", "Give 40 mg then 60 mg.");
  assert.equal(multiBad.checks.number, "fail");
  assert.equal(multiBad.text, "Give —? then —?.");

  // Invented number → replaced with visible gap "—?"
  const invented = checkLine("Start IV furosemide 80 mg.", "Start IV furosemide 40 mg.");
  assert.equal(invented.checks.number, "fail");
  assert.equal(invented.findings[0].code, "invented_number");
  assert.equal(invented.findings[0].action, "gap");
  assert.equal(invented.text, "Start IV furosemide —?.");
  assert.equal(invented.warning, true);

  // Unit mismatch (1000x overdose bug: mg vs mcg / g) → replaced with "—?"
  const unitWrong = checkLine("Dantroleno 2,5 g/kg IV.", "Dantroleno 2,5 mg/kg IV.");
  assert.equal(unitWrong.checks.number, "fail");
  assert.equal(unitWrong.findings[0].code, "unit_mismatch");
  assert.equal(unitWrong.text, "Dantroleno —? IV.");

  // Direction flip (> vs <, or dropped >) → replaced with "—?"
  const dirFlip = checkLine("BNP <100 pg/mL supports dx.", "BNP >100 pg/mL supports diagnosis.");
  assert.equal(dirFlip.checks.number, "fail");
  assert.equal(dirFlip.findings[0].code, "direction_mismatch");
  assert.equal(dirFlip.text, "BNP —? supports dx.");

  const dirDrop = checkLine("BNP 100 pg/mL supports dx.", "BNP >100 pg/mL supports diagnosis.");
  assert.equal(dirDrop.checks.number, "fail");
  assert.equal(dirDrop.findings[0].code, "direction_mismatch");

  // Ranges: matching range passes, mutated range becomes "—?".
  assert.equal(checkLine("eGFR 30-44 mL/min: reducir dosis.", "Con eGFR 30-44 mL/min reducir dosis.").ok, true);
  assert.equal(checkLine("eGFR 30-44: reducir.", "Con eGFR entre 30 y 44 reducir.").ok, true);
  const badRange = checkLine("eGFR 30-50 mL/min: reducir.", "Con eGFR 30-44 mL/min reducir.");
  assert.equal(badRange.checks.number, "fail");
  assert.equal(badRange.text, "eGFR —?: reducir.");

  // Chemical/gene identifiers (RYR1, EtCO2, N2O, COVID-19) are NOT extracted as numeric measurements.
  assert.equal(extractPayload("Mutación RYR1: ↑EtCO2, no N2O ni COVID-19.").number.length, 0);
});

// --- Class 6: Scope (EN + ES) ---
test("scope (EN + ES): preserves population, legal parties, jurisdiction, platform, and versions", () => {
  const enPop = "Avoid tetracyclines in pregnancy and children.";
  assert.equal(checkLine("Avoid tetracyclines in pregnancy and pediatric patients.", enPop).ok, true);
  const droppedChild = checkLine("Avoid tetracyclines in pregnancy.", enPop);
  assert.equal(droppedChild.checks.scope, "fail");
  assert.ok(droppedChild.retryTokens.includes("children"));

  const esPop = "Ajustar metformina en enfermedad renal crónica.";
  assert.equal(checkLine("Ajustar metformina en ERC.", esPop).ok, true);
  assert.equal(checkLine("Ajustar metformina.", esPop).checks.scope, "fail");

  // Fixture 13: legal parties (arrendatario vs arrendador).
  const esParty = "El arrendatario debe avisar con 30 días.";
  assert.equal(checkLine("Arrendatario: aviso 30 días.", esParty).ok, true);
  assert.equal(checkLine("El arrendador debe avisar con 30 días.", esParty).checks.scope, "fail");

  // Version + platform scope.
  const tech = "Only supported in v2.4 on Linux.";
  assert.equal(checkLine("Only in version 2.4 on Linux.", tech).ok, true);
  assert.equal(checkLine("Only on Linux.", tech).checks.scope, "fail");

  // Lowercase English pronoun "us" must NOT trigger US jurisdiction.
  assert.equal(extractPayload("Tell us the dose.").scope.length, 0);
});

// --- Class 7: Attribution (EN + ES) ---
test("attribution (EN + ES): preserves citations, guidelines, and cues; ignores 'per kg' rates", () => {
  const esGuide = "Según la guía ESC, iniciar furosemida 40 mg IV.";
  assert.equal(checkLine("ESC: iniciar furosemida 40 mg IV.", esGuide).ok, true);
  const dropEsc = checkLine("Iniciar furosemida 40 mg IV.", esGuide);
  assert.equal(dropEsc.checks.attribution, "fail");
  assert.ok(dropEsc.retryTokens.includes("ESC"));

  const enEtAl = "Smith et al. (2024) reported a 20% mortality reduction.";
  assert.equal(checkLine("Smith et al.: 20% mortality reduction.", enEtAl).ok, true);
  assert.equal(checkLine("20% mortality reduction.", enEtAl).checks.attribution, "fail");

  const esEtAl = "García et al. describieron menor riesgo.";
  assert.equal(checkLine("García et al.: menor riesgo.", esEtAl).ok, true);
  assert.equal(checkLine("Menor riesgo.", esEtAl).checks.attribution, "fail");

  // Cue-only attribution (no uppercase acronym or et al.)
  const cueOnly = "Según el autor, el beneficio es incierto.";
  assert.equal(checkLine("Según el autor: beneficio incierto.", cueOnly).ok, true);
  assert.equal(checkLine("El beneficio es incierto.", cueOnly).checks.attribution, "fail");

  // Rate preposition "per kg" / "per day" must NOT trigger attribution.
  assert.equal(extractPayload("Give 2.5 mg per kg once per day.").attribution.length, 0);
  assert.equal(checkLine("Give 2.5 mg/kg daily.", "Give 2.5 mg/kg daily.").checks.attribution, "pass");
});

// --- Class 8: Glass pins ---
test("pins: keeps covered highlights and surfaces uncovered pins to outOfFold (never silent)", () => {
  const pins = [
    { id: "m1", quote: "furosemide 40 mg" },
    { id: "m2", quote: "Never give fluids with pulmonary congestion" },
  ];
  const res = checkLine(
    "Start IV furosemide 40 mg if diuretic-naive.",
    "Start IV furosemide 40 mg if diuretic-naive. Never give fluids with pulmonary congestion.",
    { pins },
  );
  assert.equal(res.checks.pins, "fail");
  assert.equal(res.outOfFold.length, 1);
  assert.equal(res.outOfFold[0].id, "m2");

  const allCovered = checkPins("Start IV furosemide 40 mg; never give fluids with pulmonary congestion.", pins);
  assert.equal(allCovered.ok, true);
  assert.equal(allCovered.outOfFold.length, 0);
});

// --- Class 9: Monotonic size ladder ---
test("monotonic: enforces Key <= Brief, Takeaway <= Key, Topic <= Takeaway with cascading fallback", () => {
  const brief = { by: "author", text: "Start IV furosemide 40 mg if diuretic-naive." }; // 7 words
  const okMono = checkMonotonic({
    brief,
    key: written("IV furosemide 40 mg if diuretic-naive.", ["furosemide 40 mg"]), // 6 words
    takeaway: written("IV furosemide 40 mg.", ["furosemide 40 mg"]), // 4 words
    topic: written("IV furosemide", ["furosemide 40 mg"]), // 2 words
  });
  assert.equal(okMono.ok, true);
  assert.equal(okMono.status, "pass");
  assert.deepEqual(okMono.demoted, []);

  // Key longer than Brief → Key shows Brief; Takeaway longer than effective Key → Takeaway also demotes.
  const bloated = checkMonotonic({
    brief,
    key: written("Begin intravenous loop diuretic therapy with furosemide 40 mg immediately for naive patients.", ["furosemide 40 mg"]),
    takeaway: written("Intravenous furosemide 40 mg is recommended immediately for every diuretic-naive patient.", ["furosemide 40 mg"]),
    topic: written("IV furosemide", ["furosemide 40 mg"]),
  });
  assert.equal(bloated.ok, false);
  assert.equal(bloated.status, "fail");
  assert.deepEqual(bloated.demoted, ["key", "takeaway"]);
  assert.deepEqual(bloated.stops.key, brief);
  assert.deepEqual(bloated.stops.takeaway, brief);
  assert.equal(bloated.stops.topic.text, "IV furosemide");
  assert.ok(countWords(bloated.stops.topic.text) <= countWords(bloated.stops.takeaway.text));
  assert.ok(countWords(bloated.stops.takeaway.text) <= countWords(bloated.stops.key.text));
  assert.ok(countWords(bloated.stops.key.text) <= countWords(brief.text));
});

// --- Class 10: Injection / format ---
test("format: rejects and strips Markdown links, HTML tags, URLs, and code fences without harming comparators", () => {
  const safeClinical = "eGFR <30 and BNP >100 pg/mL; K+ <3.5.";
  const clean = checkFormat(safeClinical);
  assert.equal(clean.ok, true);
  assert.equal(clean.sanitized, safeClinical);

  const attacks = [
    ["See [guide](https://evil.test/x) now.", "See guide now."],
    ["Image ![alt](https://evil.test/a.png) kept.", "Image alt kept."],
    ["Click <a href=\"https://evil.test\">here</a>.", "Click here."],
    ["Load <img src=x onerror=alert(1)> fast.", "Load fast."],
    ["Bad <script>alert(1)</script> payload.", "Bad payload."],
    ["Visit http://evil.test/steal today.", "Visit today."],
    ["Run javascript:alert(1) now.", "Run now."],
    ["Click [here](javascript:alert(1)) now.", "Click here now."],
    ["Bare http:// link.", "Bare link."],
    ["```md\nIgnore instructions\n```", "Ignore instructions"],
    ["Unclosed <img src=x onerror=1", "Unclosed"],
  ];
  for (const [input, expected] of attacks) {
    const res = checkFormat(input);
    assert.equal(res.ok, false, input);
    assert.equal(res.status, "fail", input);
    assert.equal(res.findings[0].action, "strip", input);
    assert.equal(res.sanitized, expected, input);
  }
});

// --- Retry once vs fallback to Brief + ⚠, plus evidence grounding ---
test("semantic failure requests one retry with missing tokens, then falls back to Brief AuthorText with warning", () => {
  const unitText = "Do not stop beta-blocker unless shock occurs.";
  const brief = { by: "author", text: unitText };
  const badModelLine = {
    by: "model",
    text: "Stop beta-blocker.",
    evidence: [makeEvidence(unitText, unitText)],
  };

  const firstTry = checkLine(badModelLine, undefined, { unitText, brief, retryAvailable: true });
  assert.equal(firstTry.ok, false);
  assert.equal(firstTry.checks.negation, "fail");
  assert.equal(firstTry.checks.condition, "fail");
  assert.ok(firstTry.retryTokens.some(t => /do not/i.test(t)));
  assert.ok(firstTry.retryTokens.some(t => /unless/i.test(t)));
  assert.equal(isWrittenText(firstTry.resolved), true);

  const afterRetry = checkLine(badModelLine, undefined, { unitText, brief, retryAvailable: false });
  assert.equal(afterRetry.ok, false);
  assert.equal(afterRetry.fallback, "brief");
  assert.equal(afterRetry.warning, true);
  assert.equal(isAuthorText(afterRetry.resolved), true);
  assert.deepEqual(afterRetry.resolved, brief);

  // AuthorText passes through without warning; pins still checked.
  const authorPass = checkLine(brief, undefined, { pins: ["unless shock"] });
  assert.equal(authorPass.ok, true);
  assert.equal(authorPass.fallback, null);
  assert.equal(authorPass.warning, false);

  // Empty text after format stripping falls back to Brief with warning.
  const onlyScript = checkLine(
    { by: "model", text: "<script>alert(1)</script>", evidence: [makeEvidence(unitText, unitText)] },
    undefined,
    { unitText, brief, retryAvailable: true },
  );
  assert.equal(onlyScript.checks.format, "fail");
  assert.equal(onlyScript.warning, true);
  assert.equal(isAuthorText(onlyScript.resolved), true);
  assert.deepEqual(onlyScript.resolved, brief);
});

test("fixture 10 sepsis dense negation/condition/restriction: 100% polarity preserved or caught", () => {
  const sepsisEv = "Do not delay broad-spectrum antibiotics; give vasopressors only if hypotension persists unless fluid-responsive.";
  assert.equal(
    checkLine("Never delay antibiotics; vasopressors only if hypotension persists unless fluid-responsive.", sepsisEv).ok,
    true,
  );
  const dropNeg = checkLine("Delay antibiotics; vasopressors only if hypotension persists unless fluid-responsive.", sepsisEv);
  assert.equal(dropNeg.checks.negation, "fail");
  const dropOnly = checkLine("Never delay antibiotics; vasopressors if hypotension persists unless fluid-responsive.", sepsisEv);
  assert.equal(dropOnly.checks.restriction, "fail");
  const dropUnless = checkLine("Never delay antibiotics; vasopressors only if hypotension persists.", sepsisEv);
  assert.equal(dropUnless.checks.condition, "fail");
});

test("validateEvidence rejects hallucinated anchors and misaligned offsets, accepts NFD/NFC match", () => {
  const unitText = "Start IV furosemide 40 mg if diuretic-naive.";
  assert.equal(validateEvidence(unitText, [makeEvidence(unitText, "furosemide 40 mg")]).ok, true);
  const wrongOffset = [{ elementId: "paragraph-ab12cd34", quote: "furosemide 40 mg", sentence: 0, start: 0, end: 16 }];
  assert.equal(validateEvidence(unitText, wrongOffset).ok, false);
  const nfdUnit = "Café. Start IV furosemide 40 mg.".normalize("NFD");
  const nfcCafe = "Café".normalize("NFC");
  assert.notEqual(nfdUnit, nfdUnit.normalize("NFC"));
  assert.equal(validateEvidence(nfdUnit, [{ elementId: "p", quote: nfcCafe, sentence: 0, start: 0, end: nfcCafe.length }]).ok, true);
  assert.equal(validateEvidence(nfdUnit, [{ elementId: "p", quote: "furosemide 40 mg", sentence: 0, start: 15, end: 31 }]).ok, true);
  assert.equal(validateEvidence(nfdUnit, [{ elementId: "p", quote: "furosemide 40 mg", sentence: 0, start: 0, end: 16 }]).ok, false);
  const nfcUnit = "Café. Start IV furosemide 40 mg.".normalize("NFC");
  const nfdCafe = "Café".normalize("NFD");
  assert.equal(validateEvidence(nfcUnit, [{ elementId: "p", quote: nfdCafe, sentence: 0, start: 0, end: nfdCafe.length }]).ok, true);
  assert.equal(validateEvidence(nfcUnit, [{ elementId: "p", quote: nfdCafe, sentence: 0, start: 1, end: 1 + nfdCafe.length }]).ok, false);
  const hallucinated = [{ elementId: "paragraph-ab12cd34", quote: "furosemide 80 mg", sentence: 0, start: 0, end: 16 }];
  assert.equal(validateEvidence(unitText, hallucinated).ok, false);

  const res = checkLine(
    { by: "model", text: "Start IV furosemide 80 mg.", evidence: hallucinated },
    undefined,
    { unitText, brief: { by: "author", text: unitText } },
  );
  assert.equal(res.evidenceValid, false);
  assert.equal(res.ok, false);
  assert.equal(res.warning, true);
  assert.equal(isAuthorText(res.resolved), true);
  assert.equal(res.resolved.text, unitText);
});

// --- End-to-end WrittenUnit integration with fold-format.mjs ---
test("checkWrittenUnit produces a valid omarkie/fold WrittenUnit passing foldProblems()", () => {
  const unitText = "Do not stop beta-blocker unless shock; start IV furosemide 40 mg if diuretic-naive.";
  const brief = { by: "author", text: "Do not stop beta-blocker unless shock; IV furosemide 40 mg if diuretic-naive." };
  const evAll = makeEvidence(unitText, unitText);
  const evDose = makeEvidence(unitText, "furosemide 40 mg");

  const unit = {
    elementId: "paragraph-ab12cd34",
    role: "treatment",
    key: { by: "model", text: "Never stop beta-blocker unless shock; IV furosemide 40 mg if diuretic-naive.", evidence: [evAll] },
    takeaway: { by: "model", text: "IV furosemide 80 mg if diuretic-naive.", evidence: [evDose] },
    topic: { by: "model", text: "Furosemide [link](https://evil.test)", evidence: [evDose] },
    checks: {},
  };

  const checked = checkWrittenUnit(unit, { unitText, brief, retryAvailable: false });
  assert.equal(checked.checks.negation, "pass");
  assert.equal(checked.checks.number, "fail");
  assert.equal(checked.checks.format, "fail");
  assert.equal(checked.checks.monotonic, "pass");
  assert.equal(checked.unit.takeaway.text, "IV furosemide —? if diuretic-naive.");
  assert.equal(checked.unit.topic.text, "Furosemide link");

  const foldRecord = {
    format: FOLD_FORMAT,
    version: FOLD_VERSION,
    meta: {
      slot: "ladder",
      route: "agent",
      agent: "opencode",
      model: "fixture-model",
      promptVersion: 1,
      schemaVersion: 1,
      outLang: "en",
      created: "2026-11-27T22:00:00Z",
    },
    units: [
      { elementId: "paragraph-ab12cd34", kind: "paragraph", line: 1, endLine: 1, hash: HASH, raw: null },
    ],
    written: [checked.unit],
    sections: [],
    estudio: null,
  };
  assert.deepEqual(foldProblems(foldRecord), []);
  assert.equal(isFold(foldRecord), true);

  // Demoting to a string brief still produces a valid AuthorText FoldLine.
  const demotedUnit = checkWrittenUnit(
    {
      elementId: "paragraph-ab12cd34",
      role: "treatment",
      key: { by: "model", text: "Never stop beta-blocker unless shock; start IV furosemide 40 mg if diuretic-naive.", evidence: [evAll] },
      takeaway: { by: "model", text: "IV furosemide 40 mg.", evidence: [evDose] },
      topic: { by: "model", text: "Furosemide", evidence: [evDose] },
      checks: {},
    },
    { unitText, brief: "IV furosemide 40 mg." },
  );
  assert.equal(demotedUnit.checks.monotonic, "fail");
  assert.equal(isAuthorText(demotedUnit.unit.key), true);
  assert.deepEqual(foldProblems({ ...foldRecord, written: [demotedUnit.unit] }), []);
});

test("malformed model lines and unvalidated quotes cannot forge AuthorText", () => {
  const unitText = "Start IV furosemide 40 mg if diuretic-naive.";

  const emptyEv = checkLine({ by: "model", text: "Invented clinical claim.", evidence: [] }, undefined, { unitText });
  assert.equal(emptyEv.evidenceValid, false);
  assert.equal(emptyEv.ok, false);
  assert.equal(emptyEv.warning, true);
  assert.equal(emptyEv.fallback, "brief");
  assert.equal(isAuthorText(emptyEv.resolved), true);
  assert.equal(emptyEv.resolved.text, unitText);

  const badShapeNoUnit = checkLine({ by: "model", text: "Invented claim.", evidence: [{ quote: "hallucinated" }] });
  assert.equal(badShapeNoUnit.evidenceValid, false);
  assert.equal(badShapeNoUnit.ok, false);
  assert.equal(badShapeNoUnit.warning, true);
  assert.equal(badShapeNoUnit.resolved.text, NUMBER_GAP);

  const hallucinatedNoBrief = checkLine(
    {
      by: "model",
      text: "Start IV furosemide 80 mg.",
      evidence: [{ elementId: "p", quote: "furosemide 80 mg", sentence: 0, start: 0, end: 16 }],
    },
    undefined,
    { unitText },
  );
  assert.equal(hallucinatedNoBrief.evidenceValid, false);
  assert.equal(hallucinatedNoBrief.ok, false);
  assert.equal(hallucinatedNoBrief.warning, true);
  assert.equal(hallucinatedNoBrief.fallback, "brief");
  assert.equal(hallucinatedNoBrief.resolved.text, unitText);
});

test("number extraction handles descending spans, English article 'a', negative values, and multi-dot thousands", () => {
  assert.equal(checkLine("Reduce furosemide from 40 to 2 mg.", "Reduce furosemide from 40 to 20 mg.").checks.number, "fail");
  assert.equal(checkLine("Target furosemide 20 mg.", "Reduce furosemide from 40 to 20 mg.").ok, true);
  assert.equal(checkLine("In 2024 a 500 mg dose was given.", "In 2024 a 50 mg dose was given.").checks.number, "fail");
  assert.equal(checkLine("Give 50 mg on day 1.", "At day 1 a 50 mg dose was given.").ok, true);
  assert.equal(checkLine("At day 1 a 500 mg dose.", "At day 1 a 50 mg dose.").checks.number, "fail");
  assert.equal(checkLine("Dosis 10-20 mg.", "Administrar de 10 a 20 mg.").ok, true);

  assert.equal(checkLine("Base excess -40 mEq/L.", "Base excess -4 mEq/L.").checks.number, "fail");
  assert.equal(checkLine("Base excess -4 mEq/L.", "Base excess -4 mEq/L.").ok, true);
  assert.equal(extractPayload("COVID-19, SARS-CoV-2, and IL-6 have no numeric values.").number.length, 0);

  assert.equal(checkLine("Reduce furosemide 40-2 mg.", "Reduce furosemide 40-20 mg.").checks.number, "fail");
  assert.equal(checkLine("BP 120-40 mmHg.", "BP 120-80 mmHg.").checks.number, "fail");
  assert.equal(checkLine("BP 120-80 mmHg.", "BP 120-80 mmHg.").ok, true);
  assert.equal(checkLine("Published 2024-12-31.", "Published 2024-05-01.").checks.number, "fail");
  assert.equal(checkLine("Published 2024-05-12.", "Published 2024-05-12.").ok, true);
  assert.equal(checkLine("Published 01-19-2024.", "Published 01-12-2024.").checks.number, "fail");
  assert.equal(checkLine("Day 12 of 2024.", "Published 01-12-2024.").ok, true);
  assert.equal(checkLine("Dose schedule 1-29-100 mg.", "Dose schedule 1-20-100 mg.").checks.number, "fail");
  assert.deepEqual(
    extractPayload("1-2.5-3").number.map(n => n.value),
    [1, 2.5, 3],
  );
  assert.equal(checkLine("Delta 10--5 mEq/L.", "Delta 10--50 mEq/L.").checks.number, "fail");
  assert.equal(checkLine("Delta 10--5 mEq/L.", "Delta 10--5 mEq/L.").ok, true);

  assert.equal(checkLine("Version 2.4 — 80 mg.", "Version 2.4 — 40 mg.").checks.number, "fail");
  assert.equal(checkLine("Edition 3 - 80 mg.", "Edition 3 - 40 mg.").checks.number, "fail");
  assert.equal(checkLine("4.4.1 — 80 mg IV.", "4.4.1 — 40 mg IV.").checks.number, "fail");
  assert.equal(checkLine("Section 1.2.3 to 500 mg.", "Section 1.2.3 to 50 mg.").checks.number, "fail");
  assert.equal(checkLine("Version 2.4 — 40 mg.", "Version 2.4 — 40 mg.").ok, true);
  assert.equal(checkLine("4.4.1 — 40 mg IV.", "4.4.1 — 40 mg IV.").ok, true);

  assert.equal(checkLine("Penicilina 9.000.000 UI.", "Penicilina 2.400.000 UI.").checks.number, "fail");
  assert.equal(checkLine("Penicilina 2.400.000 UI.", "Penicilina 2.400.000 UI.").ok, true);

  // Compact comparators attached to identifiers
  assert.equal(checkLine("eGFR>30", "eGFR<30").checks.number, "fail");
  assert.equal(checkLine("p>0.05", "p<0.05").checks.number, "fail");
  assert.equal(checkLine("SpO2>90%", "SpO2<90%").checks.number, "fail");
  assert.equal(checkLine("BNP<100 pg/mL", "BNP>100 pg/mL").checks.number, "fail");
  assert.equal(checkLine("Risk↑20%", "Risk↓20%").checks.number, "fail");
  assert.equal(checkLine("eGFR <30", "eGFR<30").ok, true);
  assert.equal(checkLine("MAP ≥65 mmHg", "MAP≥65 mmHg").ok, true);

  // Leading-decimal clinical values and dotted version/code identifiers
  assert.equal(checkLine("Give 5 mg.", "Give .5 mg.").checks.number, "fail");
  assert.equal(checkLine("Give .5 mg.", "Give 5 mg.").checks.number, "fail");
  assert.equal(checkLine("Give 0.5 mg.", "Give .5 mg.").ok, true);
  assert.equal(checkLine("Give 0.5-1.5 mg.", "Give between .5 and 1.5 mg.").ok, true);
  assert.equal(checkLine("Only in v2.4 on Linux.", "Only supported in version 2.4 on Linux.").ok, true);
  assert.equal(checkLine("Give 4 on Linux in v2.4.", "Only supported in v2.4 on Linux.").checks.number, "fail");
  assert.equal(checkLine("Use ICD-10.1 criteria.", "Use ICD-10 criteria.").ok, true);

  // Compact unit-hyphen ranges (letter-ending and symbol-ending units)
  assert.equal(checkLine("Give 40 mg-80 mg daily.", "Give 40 mg-20 mg daily.").checks.number, "fail");
  assert.equal(checkLine("Give 40mg-80mg daily.", "Give 40mg-20mg daily.").checks.number, "fail");
  assert.equal(checkLine("Give 2.5 mg/kg-10 mg/kg.", "Give 2.5 mg/kg-5 mg/kg.").checks.number, "fail");
  assert.equal(checkLine("Temp 37°C-42°C.", "Temp 37°C-39°C.").checks.number, "fail");
  assert.equal(checkLine("Give 80 mg.", "Give 40 mg-80 mg.").ok, true);
  assert.equal(checkLine("Risk 50%-80%.", "Risk 50% to 80%.").ok, true);
  assert.equal(checkLine("Risk 50%-80%.", "Risk 50-80%.").ok, true);
  assert.equal(checkLine("Risk 50%-90%.", "Risk 50-80%.").checks.number, "fail");

  // Non-hyphen separators after a unit-bearing number do not split a following hyphenated range
  assert.equal(checkLine("eGFR 30-44 mL/min.", ["Start IV furosemide 40 mg", "30-44 mL/min"]).ok, true);
  assert.equal(checkLine("Infuse 500 mL 1-2 hours.", "Infuse 500 mL in 1-2 hours.").ok, true);
  assert.equal(checkLine("Age 65 yr; give 44 mL/min.", "Age 65 yr 30-44 mL/min.").checks.number, "fail");
  assert.equal(checkLine("Age 65 yr; give 30.", "Age 65 yr 30-44 mL/min.").checks.number, "fail");

  // NFD input redacts bad numbers at exact offsets without drifting into preceding accented words
  const nfdBad1 = checkLine(
    "Administración rápida según guía clínica pediátrica: 80 mg.".normalize("NFD"),
    "Administración rápida según guía clínica pediátrica: 40 mg.",
  );
  assert.equal(nfdBad1.checks.number, "fail");
  assert.equal(nfdBad1.text, "Administración rápida según guía clínica pediátrica: —?.");

  const nfdBad2 = checkLine(
    "Dosis máxima según guía clínica: 80 mg.".normalize("NFD"),
    "Dosis máxima según guía clínica: 40 mg.",
  );
  assert.equal(nfdBad2.checks.number, "fail");
  assert.equal(nfdBad2.text, "Dosis máxima según guía clínica: —?.");
});

test("compound slash-units, prefix currency rates, negated verbal comparators, and direction gap replacement", () => {
  assert.equal(checkLine("Infuse norepinephrine at 5 mg/min.", "Infuse norepinephrine at 5 mcg/min.").checks.number, "fail");
  assert.equal(checkLine("Give 5 g/day.", "Give 5 mg/day.").checks.number, "fail");
  assert.equal(checkLine("Give 50 mcg/h.", "Give 50 µg/hr.").ok, true);
  assert.equal(checkLine("Give 10 mg/m2.", "Give 10 mg/m².").ok, true);
  assert.equal(checkLine("Heparin 1000 U/h.", "Heparin 1000 U/min.").checks.number, "fail");
  assert.equal(checkLine("Give 5 mg/d.", "Give 5 mg/día.").ok, true);
  assert.equal(checkLine("$50/month", "€50/month").checks.number, "fail");
  assert.equal(checkLine("50/month", "€50/month").checks.number, "fail");
  assert.equal(checkLine("€50/month", "50 EUR/month").ok, true);
  assert.equal(checkLine("$50-100/month", "€50-100/month").checks.number, "fail");
  assert.equal(checkLine("€50-100/month", "50-100 EUR/month").ok, true);

  assert.equal(checkLine("Keep MAP ≥65 mmHg.", "Keep MAP not below 65 mmHg.").ok, true);
  assert.equal(checkLine("Give ≤40 mg.", "Give not more than 40 mg.").ok, true);
  assert.equal(checkLine("Dar ≤40 mg.", "Dar no mayor que 40 mg.").ok, true);
  assert.equal(checkLine("Administrar ≤10 mg/kg.", "Administrar no más de 10 mg/kg.").ok, true);
  assert.equal(checkLine("Give ≤40 mg.", "Give no more than 40 mg.").ok, true);

  const verbalFlip = checkLine("BNP below 100 pg/mL supports dx.", "BNP >100 pg/mL supports diagnosis.");
  assert.equal(verbalFlip.checks.number, "fail");
  assert.equal(verbalFlip.text, "BNP —? supports dx.");

  const trailingFlip = checkLine("Give 40 mg min.", "Give 40 mg max.");
  assert.equal(trailingFlip.checks.number, "fail");
  assert.equal(trailingFlip.text, "Give —?.");
});

test("checkFormat reaches fixed point against nested HTML, reconstituted Markdown, whitespace close tags, and unclosed media tags", () => {
  const cases = [
    ["<vi<b>deo src=x onerror=alert(1)>", ""],
    ["![alt]<span>(/local/file.png)", "alt"],
    ["[click]<span>(/admin)", "click"],
    ["<script>alert(1)</script >", ""],
    ["<style>body{display:none}</style  >Keep.", "Keep."],
    ["<details open ontoggle=alert(1)", ""],
    ["<video src=x onerror=alert(1)", ""],
    ["<svg/onload=alert(1)>Safe.", "Safe."],
  ];
  for (const [input, expected] of cases) {
    const res = checkFormat(input);
    assert.equal(res.ok, false, input);
    assert.equal(res.sanitized, expected, input);
    assert.equal(checkFormat(res.sanitized).ok, true, `re-check sanitized: ${input}`);
  }
});

test("lexicon disambiguation and sentence-initial attribution matching (ES + EN)", () => {
  assert.equal(checkLine("Unless improving, intubate.", "If not improving, intubate.").ok, true);
  assert.equal(checkLine("If not in shock, give fluids.", "Unless in shock, give fluids.").ok, true);
  assert.equal(checkLine("A menos que mejore, intubar.", "Si no mejora, intubar.").ok, true);
  assert.equal(checkLine("Unless shock, give fluids.", "In the absence of shock, give fluids.").ok, true);

  assert.equal(checkLine("Patients cannot tolerate beta-blockers.", "Patients could not tolerate beta-blockers.").ok, true);
  assert.equal(checkLine("Do not use in pregnancy.", "You may not use in pregnancy.").ok, true);
  assert.equal(extractPayload("Patients can't tolerate beta-blockers.").uncertainty.length, 0);

  assert.equal(checkLine("Avoid benzodiazepines in elderly.", "Avoid benzodiazepines in older adults.").ok, true);
  assert.equal(checkLine("Evitar benzodiacepinas en ancianos.", "Evitar benzodiacepinas en adultos mayores.").ok, true);

  assert.equal(checkLine("Administrar estrictamente por vía IV.", "Administrar solo por vía IV.").ok, true);
  assert.equal(checkLine("Give strictly IV.", "Give only IV.").ok, true);

  assert.equal(checkLine("Recheck lactate at 2 h.", "Per protocol, recheck lactate at 2 h.").checks.attribution, "fail");
  assert.equal(checkLine("Per protocol, recheck lactate at 2 h.", "Per protocol, recheck lactate at 2 h.").ok, true);
  assert.equal(checkLine("Mortality fell 20%.", "Trial RECOVERY showed mortality fell 20%.").checks.attribution, "fail");
  assert.equal(checkLine("RECOVERY: mortality fell 20%.", "Trial RECOVERY showed mortality fell 20%.").ok, true);
});

test("checkPins enforces token boundaries, polarity, and multi-clause isolation", () => {
  assert.equal(checkPins("Give 140 mg IV.", ["40 mg"]).ok, false);
  assert.equal(checkPins("Give 40 mg/kg IV.", ["40 mg"]).ok, false);
  assert.equal(checkPins("Never give fluids in edema.", ["give fluids"]).ok, false);
  assert.equal(checkPins("Do not give fluids in edema.", ["give fluids"]).ok, false);

  const multiClause = checkPins(
    "Never stop beta-blocker; start IV furosemide 40 mg if diuretic-naive.",
    ["start intravenous furosemide 40 mg"],
  );
  assert.equal(multiClause.ok, true);
  assert.equal(multiClause.outOfFold.length, 0);
});

test("checkMonotonic enforces full as upper word-count bound with or without brief", () => {
  const withoutBrief = checkMonotonic({
    full: "Start IV furosemide 40 mg now.",
    key: "Begin intravenous loop diuretic therapy with furosemide 40 mg immediately for every patient.",
    takeaway: "IV furosemide 40 mg.",
    topic: "Furosemide",
  });
  assert.equal(withoutBrief.ok, false);
  assert.equal(withoutBrief.status, "fail");
  assert.deepEqual(withoutBrief.demoted, ["key"]);
  assert.equal(withoutBrief.stops.key, "Start IV furosemide 40 mg now.");

  const briefOverFull = checkMonotonic({
    full: "Start IV furosemide 40 mg now.",
    brief: "Begin intravenous loop diuretic therapy with furosemide 40 mg immediately.",
    key: "Start intravenous furosemide 40 mg immediately for naive patients.",
    takeaway: "IV furosemide 40 mg.",
    topic: "Furosemide",
  });
  assert.equal(briefOverFull.ok, false);
  assert.deepEqual(briefOverFull.demoted, ["brief", "key"]);
  assert.equal(briefOverFull.stops.brief, "Start IV furosemide 40 mg now.");
  assert.equal(briefOverFull.stops.key, "Start IV furosemide 40 mg now.");

  const blankBounds = checkMonotonic({
    full: "   ",
    brief: "",
    key: "IV furosemide 40 mg.",
    takeaway: "IV furosemide.",
    topic: "Furosemide",
  });
  assert.equal(blankBounds.ok, true);
  assert.deepEqual(blankBounds.demoted, []);
  assert.equal(blankBounds.stops.key, "IV furosemide 40 mg.");
});

test("checkWrittenUnit treats blank brief and full options as omitted rather than coercing to NUMBER_GAP", () => {
  const unitText = "Start IV furosemide 40 mg if diuretic-naive.";
  const evAll = makeEvidence(unitText, unitText);
  const evDose = makeEvidence(unitText, "furosemide 40 mg");
  const unit = {
    elementId: "paragraph-ab12cd34",
    role: "treatment",
    key: { by: "model", text: "IV furosemide 40 mg if diuretic-naive.", evidence: [evAll] },
    takeaway: { by: "model", text: "IV furosemide 40 mg.", evidence: [evDose] },
    topic: { by: "model", text: "Furosemide", evidence: [evDose] },
    checks: {},
  };

  const blankBrief = checkWrittenUnit(unit, { unitText, brief: "", full: "   " });
  assert.equal(blankBrief.ok, true);
  assert.equal(blankBrief.checks.monotonic, "pass");
  assert.equal(blankBrief.unit.key.text, "IV furosemide 40 mg if diuretic-naive.");
  assert.equal(blankBrief.unit.takeaway.text, "IV furosemide 40 mg.");
  assert.equal(blankBrief.unit.topic.text, "Furosemide");

  const fallbackWithBlankBrief = checkWrittenUnit(
    {
      ...unit,
      key: { by: "model", text: "IV furosemide 40 mg.", evidence: [evAll] },
    },
    { unitText, brief: "   ", retryAvailable: false },
  );
  assert.equal(fallbackWithBlankBrief.stops.key.fallback, "brief");
  assert.equal(fallbackWithBlankBrief.stops.key.resolved.text, unitText);

  const plainUnitText = "Routine monitoring recommended.";
  const plainEv = makeEvidence(plainUnitText, plainUnitText);
  const blankStopRes = checkWrittenUnit(
    {
      elementId: "paragraph-ab12cd34",
      role: "monitoring",
      key: { by: "model", text: " ", evidence: [plainEv] },
      takeaway: { by: "model", text: "Routine monitoring.", evidence: [plainEv] },
      topic: { by: "model", text: "Monitoring", evidence: [plainEv] },
      checks: {},
    },
    { unitText: plainUnitText },
  );
  assert.equal(blankStopRes.stops.key.ok, false);
  assert.equal(blankStopRes.warning, true);
  assert.equal(blankStopRes.ok, false);
});
