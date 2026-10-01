/**
 * Synthetic but realistic document archive for retrieval evaluation.
 * Mostly German documents (typical Paperless user), some English ones, and a
 * few long documents where the relevant facts are deep inside the text.
 */

export interface EvalDoc {
  id: number;
  title: string;
  correspondent: string;
  type: string;
  created: string;
  tags: string[];
  content: string;
}

export interface EvalQuestion {
  q: string;
  /** ids of documents that answer the question (any of them counts). */
  expected: number[];
}

const months = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** Filler paragraphs typical for contracts/terms (to make documents long). */
const LEGAL = [
  'Die Vertragsparteien verpflichten sich, die Bestimmungen dieses Vertrages nach Treu und Glauben zu erfüllen. Änderungen und Ergänzungen bedürfen der Schriftform.',
  'Sollte eine Bestimmung dieses Vertrages unwirksam sein oder werden, so wird die Wirksamkeit der übrigen Bestimmungen hiervon nicht berührt. Die Parteien verpflichten sich, die unwirksame Bestimmung durch eine wirksame zu ersetzen, die dem wirtschaftlichen Zweck am nächsten kommt.',
  'Der Datenschutz wird gemäß den Vorschriften der Datenschutz-Grundverordnung (DSGVO) gewährleistet. Personenbezogene Daten werden ausschließlich zur Vertragserfüllung verarbeitet.',
  'Gerichtsstand für alle Streitigkeiten aus diesem Vertrag ist, soweit gesetzlich zulässig, der Sitz des Vermieters bzw. Arbeitgebers. Es gilt das Recht der Bundesrepublik Deutschland.',
  'Mündliche Nebenabreden bestehen nicht. Die Aufhebung des Schriftformerfordernisses bedarf ebenfalls der Schriftform.',
  'Die Haftung für leicht fahrlässige Pflichtverletzungen ist ausgeschlossen, sofern nicht wesentliche Vertragspflichten, Leben, Körper oder Gesundheit betroffen sind.',
];
const legal = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => LEGAL[(i + offset) % LEGAL.length]).join('\n\n');

export function buildCorpus(): { docs: EvalDoc[]; questions: EvalQuestion[] } {
  const docs: EvalDoc[] = [];
  let id = 1;
  const add = (d: Omit<EvalDoc, 'id'>) => {
    docs.push({ id: id++, ...d });
    return id - 1;
  };

  // Electricity bills 2024 (monthly)
  const strom: number[] = [];
  const amounts = [91.2, 88.4, 84.2, 76.9, 70.3, 64.8, 61.1, 63.5, 69.9, 78.4, 85.6, 93.7];
  for (let m = 0; m < 12; m++) {
    strom.push(
      add({
        title: `Stromrechnung ${months[m]} 2024`,
        correspondent: 'Stadtwerke München',
        type: 'Rechnung',
        created: `2024-${String(m + 1).padStart(2, '0')}-15`,
        tags: ['Strom', 'Rechnung'],
        content: `Stadtwerke München GmbH, Emmy-Noether-Str. 2, 80992 München\nRechnung Nr. SR-2024-${String(m + 1).padStart(2, '0')}15\nAbrechnungszeitraum: ${months[m]} 2024\nVerbrauch: ${Math.round(amounts[m] * 3.2)} kWh Strom (Tarif M-Ökostrom)\nGesamtbetrag: ${amounts[m].toFixed(2).replace('.', ',')} EUR inkl. 19 % MwSt.\nDer Betrag wird per SEPA-Lastschrift von Ihrem Konto abgebucht.`,
      }),
    );
  }
  const telekom = [3, 6, 9, 12].map((m) =>
    add({
      title: `Telekom Rechnung ${months[m - 1]} 2024`,
      correspondent: 'Telekom',
      type: 'Rechnung',
      created: `2024-${String(m).padStart(2, '0')}-05`,
      tags: ['Internet', 'Rechnung'],
      content: `Telekom Deutschland GmbH\nIhre Rechnung für ${months[m - 1]} 2024, Kundennummer 4711-0815\nMagentaZuhause L (Glasfaser 250 Mbit/s): 54,95 EUR\nGesamtbetrag 54,95 EUR. Abbuchung am 15.${String(m).padStart(2, '0')}.2024.`,
    }),
  );
  const mietvertrag = add({
    title: 'Mietvertrag Leopoldstraße 12',
    correspondent: 'Hausverwaltung Schmidt & Partner',
    type: 'Vertrag',
    created: '2021-03-01',
    tags: ['Wohnung', 'Vertrag'],
    content: `Mietvertrag über Wohnraum\n\n§ 1 Vertragsparteien\nVermieter: Hausverwaltung Schmidt & Partner GmbH, vertreten durch Herrn Klaus Schmidt.\nMieter: Max Mustermann.\n\n§ 2 Mietobjekt\nVermietet wird die Wohnung im 3. OG links, Leopoldstraße 12, 80802 München, bestehend aus 3 Zimmern, Küche, Bad, Balkon, ca. 78 m².\n\n${legal(4)}\n\n§ 3 Mietzeit\nDas Mietverhältnis beginnt am 01.04.2021 und läuft auf unbestimmte Zeit. Die Kündigungsfrist beträgt drei Monate.\n\n§ 4 Miete\nDie monatliche Kaltmiete beträgt 1.250,00 EUR. Die Vorauszahlung auf die Betriebskosten beträgt 220,00 EUR.\n\n§ 5 Kaution\nDer Mieter leistet eine Mietsicherheit in Höhe von 3.750,00 EUR.\n\n${legal(6, 2)}\n\n§ 18 Unterschriften\nMünchen, den 01.03.2021 – unterzeichnet von Vermieter und Mieter.`,
  });
  const nebenkosten = add({
    title: 'Nebenkostenabrechnung 2023',
    correspondent: 'Hausverwaltung Schmidt & Partner',
    type: 'Abrechnung',
    created: '2024-06-12',
    tags: ['Wohnung'],
    content: `Betriebskostenabrechnung für den Zeitraum 01.01.2023 – 31.12.2023\nObjekt: Leopoldstraße 12, Wohnung 3. OG links\nGesamtkosten Ihres Anteils: 2.952,45 EUR\nGeleistete Vorauszahlungen: 2.640,00 EUR\nNachzahlung: 312,45 EUR, fällig bis 15.07.2024.`,
  });
  const kfz = add({
    title: 'Versicherungsschein Kfz 2025',
    correspondent: 'HUK-COBURG',
    type: 'Vertrag',
    created: '2024-12-02',
    tags: ['Versicherung', 'Auto'],
    content: `HUK-COBURG Haftpflicht-Unterstützungs-Kasse\nVersicherungsschein Nr. KH-55123\nFahrzeug: VW Golf VIII, amtl. Kennzeichen M-AB 1234\nVersicherungsumfang: Kfz-Haftpflicht und Teilkasko (SB 150 EUR)\nJahresbeitrag 2025: 438,00 EUR, Schadenfreiheitsklasse SF 12.`,
  });
  const kv = add({
    title: 'Beitragsanpassung Krankenversicherung 2025',
    correspondent: 'Allianz',
    type: 'Schreiben',
    created: '2024-11-20',
    tags: ['Versicherung', 'Gesundheit'],
    content: `Allianz Private Krankenversicherungs-AG\nIhre Beitragsanpassung zum 01.01.2025, Versicherungsnummer KV-778812\nNeuer Monatsbeitrag: 512,40 EUR (bisher 489,10 EUR).\nGrund der Anpassung sind gestiegene Leistungsausgaben im Gesundheitswesen.`,
  });
  add({
    title: 'Privathaftpflicht Versicherungsschein',
    correspondent: 'DEVK',
    type: 'Vertrag',
    created: '2022-01-10',
    tags: ['Versicherung'],
    content: `DEVK Allgemeine Versicherungs-AG\nPrivathaftpflichtversicherung, Tarif Komfort, Deckungssumme 50 Mio. EUR\nJahresbeitrag: 68,40 EUR.`,
  });
  add({
    title: 'Lohnsteuerbescheinigung 2023',
    correspondent: 'Muster AG',
    type: 'Bescheinigung',
    created: '2024-02-10',
    tags: ['Steuer'],
    content: `Ausdruck der elektronischen Lohnsteuerbescheinigung für 2023\nArbeitgeber: Muster AG\nBruttoarbeitslohn: 58.400,00 EUR\nEinbehaltene Lohnsteuer: 11.230,00 EUR\nSolidaritätszuschlag: 0,00 EUR`,
  });
  const steuer = add({
    title: 'Einkommensteuerbescheid 2023',
    correspondent: 'Finanzamt München',
    type: 'Bescheid',
    created: '2024-08-21',
    tags: ['Steuer'],
    content: `Finanzamt München, Abt. Veranlagung\nBescheid für 2023 über Einkommensteuer und Solidaritätszuschlag\nFestgesetzt werden: Einkommensteuer 9.995,44 EUR\nBereits gezahlt: 11.230,00 EUR\nErstattung: 1.234,56 EUR. Der Betrag wird auf Ihr Konto überwiesen.`,
  });
  const arbeitsvertrag = add({
    title: 'Arbeitsvertrag Muster AG',
    correspondent: 'Muster AG',
    type: 'Vertrag',
    created: '2020-02-15',
    tags: ['Arbeit', 'Vertrag'],
    content: `Arbeitsvertrag\nzwischen der Muster AG, Industriestraße 5, 81379 München (Arbeitgeber) und Herrn Max Mustermann (Arbeitnehmer)\n\n${legal(5, 1)}\n\n§ 1 Beginn des Arbeitsverhältnisses\nDas Arbeitsverhältnis beginnt am 01.04.2020. Die ersten sechs Monate gelten als Probezeit.\n\n§ 2 Tätigkeit\nDer Arbeitnehmer wird als Senior Software Engineer eingestellt.\n\n${legal(3, 3)}\n\n§ 4 Vergütung\nDas Bruttojahresgehalt beträgt 72.000,00 EUR, zahlbar in zwölf Monatsraten.\n\n§ 6 Urlaub\nDer Arbeitnehmer erhält 30 Arbeitstage Urlaub pro Kalenderjahr.\n\n${legal(4, 4)}`,
  });
  add({
    title: 'Kündigungsbestätigung Fitnessstudio',
    correspondent: 'FitX',
    type: 'Schreiben',
    created: '2024-05-03',
    tags: ['Vertrag'],
    content: `FitX Deutschland GmbH\nWir bestätigen die Kündigung Ihrer Mitgliedschaft Nr. 99812 zum 31.07.2024. Bis dahin können Sie alle Studios nutzen.`,
  });
  const zahnarzt = add({
    title: 'Rechnung Zahnarztpraxis Dr. Meier',
    correspondent: 'Dr. med. dent. Anna Meier',
    type: 'Rechnung',
    created: '2024-09-18',
    tags: ['Gesundheit', 'Rechnung'],
    content: `Zahnarztpraxis Dr. med. dent. Anna Meier\nLiquidation nach GOZ für Behandlung vom 02.09.2024\nProfessionelle Zahnreinigung: 98,50 EUR\nFüllung (Komposit), Zahn 26: 145,20 EUR\nRechnungsbetrag: 243,70 EUR`,
  });
  const autokauf = add({
    title: 'Kaufvertrag Gebrauchtwagen',
    correspondent: 'Autohaus Huber',
    type: 'Vertrag',
    created: '2019-07-22',
    tags: ['Auto', 'Vertrag'],
    content: `Kaufvertrag über ein gebrauchtes Kraftfahrzeug\nVerkäufer: Autohaus Huber GmbH\nKäufer: Max Mustermann\nFahrzeug: Volkswagen Golf VIII, Erstzulassung 03/2019, 24.300 km\nKaufpreis: 21.900,00 EUR\nÜbergabe am 22.07.2019.`,
  });
  const tuev = add({
    title: 'Prüfbericht Hauptuntersuchung',
    correspondent: 'TÜV SÜD',
    type: 'Bericht',
    created: '2024-03-08',
    tags: ['Auto'],
    content: `TÜV SÜD Auto Service GmbH\nUntersuchungsbericht Hauptuntersuchung nach § 29 StVZO\nFahrzeug M-AB 1234, VW Golf\nErgebnis: ohne Mängel. Nächste HU: 03/2026.`,
  });
  const laptop = add({
    title: 'Amazon order confirmation',
    correspondent: 'Amazon',
    type: 'Invoice',
    created: '2023-11-24',
    tags: ['Elektronik'],
    content: `Amazon EU S.à r.l.\nOrder #302-1234567-7654321, placed on 24 November 2023\nItem: Lenovo ThinkPad X1 Carbon Gen 11, 14", 32 GB RAM, 1 TB SSD\nPrice: 1,849.00 EUR (incl. VAT)\nDelivery: 27 November 2023`,
  });
  add({
    title: 'IKEA Rechnung Sofa',
    correspondent: 'IKEA',
    type: 'Rechnung',
    created: '2022-04-09',
    tags: ['Möbel', 'Rechnung'],
    content: `IKEA Deutschland GmbH & Co. KG\nRechnung 77812\nSÖDERHAMN 3er-Sofa, Bezug Tonerud grau: 899,00 EUR\nLieferung und Montage: 79,00 EUR`,
  });
  const garantie = add({
    title: 'Garantiezertifikat Waschmaschine',
    correspondent: 'BSH Hausgeräte',
    type: 'Garantie',
    created: '2022-06-01',
    tags: ['Haushalt'],
    content: `BSH Hausgeräte GmbH – Bosch\nGarantiezertifikat für Waschmaschine Serie 6, Modell WAU28P40\nKaufdatum: 01.06.2022\nHerstellergarantie: 5 Jahre, gültig bis 31.05.2027 (inkl. Garantieverlängerung).`,
  });
  add({
    title: 'Bausparvertrag Jahreskontoauszug',
    correspondent: 'LBS Bayern',
    type: 'Kontoauszug',
    created: '2024-01-15',
    tags: ['Finanzen'],
    content: `LBS Bayerische Landesbausparkasse\nJahreskontoauszug 2023, Bausparvertrag Nr. 1234567\nBausparsumme: 50.000,00 EUR\nGuthaben zum 31.12.2023: 18.430,12 EUR`,
  });
  add({
    title: 'Renteninformation 2024',
    correspondent: 'Deutsche Rentenversicherung',
    type: 'Information',
    created: '2024-07-01',
    tags: ['Rente'],
    content: `Deutsche Rentenversicherung Bund\nRenteninformation 2024\nIhre bisher erreichte Rentenanwartschaft: monatlich 1.012,34 EUR\nHochgerechnete Regelaltersrente ab 01.05.2058: 2.145,00 EUR monatlich.`,
  });
  add({
    title: 'Kindergeld Bescheid',
    correspondent: 'Familienkasse Bayern Süd',
    type: 'Bescheid',
    created: '2022-03-14',
    tags: ['Familie'],
    content: `Familienkasse Bayern Süd\nBescheid über Kindergeld für Ihr Kind Lena, geboren am 02.02.2022.\nKindergeld wird ab Februar 2022 in Höhe von 219,00 EUR monatlich festgesetzt.`,
  });
  const hund = add({
    title: 'Hundesteuerbescheid 2024',
    correspondent: 'Landeshauptstadt München',
    type: 'Bescheid',
    created: '2024-01-20',
    tags: ['Steuer'],
    content: `Landeshauptstadt München, Kassen- und Steueramt\nHundesteuerbescheid 2024 für den Hund „Bello“\nJahressteuer: 100,00 EUR, fällig am 15.02.2024.`,
  });
  const gez = add({
    title: 'Beitragsbescheid Rundfunkbeitrag',
    correspondent: 'ARD ZDF Deutschlandradio Beitragsservice',
    type: 'Bescheid',
    created: '2024-02-01',
    tags: ['Gebühren'],
    content: `ARD ZDF Deutschlandradio Beitragsservice, 50656 Köln\nZahlungsaufforderung Rundfunkbeitrag, Beitragsnummer 123 456 789\nMonatlicher Beitrag: 18,36 EUR, quartalsweise Zahlung: 55,08 EUR.`,
  });
  add({
    title: 'Kündigung Internetvertrag',
    correspondent: 'Vodafone',
    type: 'Schreiben',
    created: '2019-05-10',
    tags: ['Internet'],
    content: `Vodafone GmbH\nBestätigung Ihrer Kündigung des Kabel-Internetvertrags (Kundennummer 99-123) zum 30.06.2019.`,
  });
  const flug = add({
    title: 'Buchungsbestätigung Flug',
    correspondent: 'Lufthansa',
    type: 'Buchung',
    created: '2024-04-02',
    tags: ['Reise'],
    content: `Deutsche Lufthansa AG – Ihre Buchungsbestätigung, Buchungscode XK7Q2P\nHinflug LH 1792 München (MUC) – Lissabon (LIS) am 18.05.2024, 09:40\nRückflug LH 1793 am 25.05.2024\nGesamtpreis für 2 Personen: 612,40 EUR`,
  });
  const hotel = add({
    title: 'Hotelrechnung Lissabon',
    correspondent: 'Hotel Avenida Palace',
    type: 'Rechnung',
    created: '2024-05-25',
    tags: ['Reise', 'Rechnung'],
    content: `Hotel Avenida Palace, Lisboa\nFatura / Invoice 2024/1187\nStay 18.05.2024 – 25.05.2024, Double room, 7 nights\nTotal: 1.386,00 EUR (incl. city tax)`,
  });
  add({
    title: 'Zahnzusatzversicherung Police',
    correspondent: 'ERGO',
    type: 'Vertrag',
    created: '2021-09-01',
    tags: ['Versicherung', 'Gesundheit'],
    content: `ERGO Krankenversicherung AG\nPolice Zahnzusatzversicherung Tarif ZAB, Beginn 01.09.2021\nMonatsbeitrag: 21,90 EUR`,
  });
  add({
    title: 'Rechnung Steuerberatung',
    correspondent: 'Kanzlei Berger',
    type: 'Rechnung',
    created: '2024-07-30',
    tags: ['Steuer', 'Rechnung'],
    content: `Steuerberatungskanzlei Berger\nRechnung für die Erstellung der Einkommensteuererklärung 2023 gemäß StBVV\nHonorar: 480,00 EUR zzgl. 19 % USt = 571,20 EUR`,
  });
  const heizung = add({
    title: 'Rechnung Wartung',
    correspondent: 'Haustechnik Gruber',
    type: 'Rechnung',
    created: '2024-10-14',
    tags: ['Haushalt', 'Rechnung'],
    content: `Haustechnik Gruber GmbH\nRechnung 2024-311 für die jährliche Wartung Ihrer Gasbrennwerttherme Viessmann Vitodens 200\nArbeitszeit 1,5 h, Ersatzteile Dichtungssatz\nGesamtbetrag: 236,81 EUR`,
  });
  add({
    title: 'Rechnung Schornsteinfeger',
    correspondent: 'Bezirksschornsteinfeger Wagner',
    type: 'Rechnung',
    created: '2024-10-02',
    tags: ['Haushalt', 'Rechnung'],
    content: `Bezirksschornsteinfegermeister Thomas Wagner\nFeuerstättenschau und Abgaswegeüberprüfung am 01.10.2024\nGebühr: 74,30 EUR`,
  });
  const streaming = add({
    title: 'Netflix receipt',
    correspondent: 'Netflix',
    type: 'Invoice',
    created: '2024-08-04',
    tags: ['Abo'],
    content: `Netflix International B.V.\nYour receipt for August 2024\nPlan: Standard with ads\nAmount charged: 4.99 EUR`,
  });
  add({
    title: 'Apple iCloud invoice',
    correspondent: 'Apple',
    type: 'Invoice',
    created: '2024-08-11',
    tags: ['Abo'],
    content: `Apple Distribution International Ltd.\nInvoice MLZ12345: iCloud+ 200 GB storage plan, monthly\nTotal: 2.99 EUR`,
  });
  const gehalt = add({
    title: 'Entgeltabrechnung Dezember 2024',
    correspondent: 'Muster AG',
    type: 'Abrechnung',
    created: '2024-12-27',
    tags: ['Arbeit'],
    content: `Muster AG – Entgeltabrechnung für den Monat Dezember 2024\nGesamtbrutto: 6.000,00 EUR (inkl. Weihnachtsgeld 0,00)\nSteuerrechtliche Abzüge: 1.312,44 EUR, Sozialversicherung: 1.245,30 EUR\nAuszahlungsbetrag (netto): 3.442,26 EUR`,
  });
  const riester = add({
    title: 'Bescheinigung Altersvorsorgevertrag 2023',
    correspondent: 'Allianz Lebensversicherung',
    type: 'Bescheinigung',
    created: '2024-02-28',
    tags: ['Rente', 'Steuer'],
    content: `Allianz Lebensversicherungs-AG\nBescheinigung nach § 92 EStG über Riester-Vertrag Nr. RV-55801 für das Beitragsjahr 2023\nEigenbeiträge: 1.925,00 EUR, gutgeschriebene Zulagen: 175,00 EUR`,
  });
  const mahnung = add({
    title: 'Zahlungserinnerung',
    correspondent: 'Stadtwerke München',
    type: 'Mahnung',
    created: '2023-09-12',
    tags: ['Strom'],
    content: `Stadtwerke München GmbH\nZahlungserinnerung zur Rechnung SR-2023-0715\nOffener Betrag: 72,10 EUR. Bitte überweisen Sie den Betrag bis zum 26.09.2023, um Mahngebühren zu vermeiden.`,
  });
  // A long insurance terms document whose relevant clause is at the end.
  const hausrat = add({
    title: 'Hausratversicherung Versicherungsbedingungen',
    correspondent: 'Allianz',
    type: 'Bedingungen',
    created: '2023-01-02',
    tags: ['Versicherung'],
    content: `Allgemeine Hausrat-Versicherungsbedingungen (VHB 2022)\n\n${legal(10, 2)}\n\nAbschnitt A § 1 Versicherte Gefahren\nEntschädigt werden versicherte Sachen, die durch Brand, Blitzschlag, Einbruchdiebstahl, Leitungswasser, Sturm oder Hagel zerstört oder beschädigt werden.\n\n${legal(8, 1)}\n\nAbschnitt B § 9 Fahrraddiebstahl\nFahrräder sind gegen Diebstahl bis zu einer Entschädigungsgrenze von 1.500 EUR je Fahrrad versichert, wenn das Fahrrad zur Zeit des Diebstahls durch ein verkehrsübliches Schloss gesichert war.`,
  });

  const questions: EvalQuestion[] = [
    { q: 'Wann habe ich den Mietvertrag unterschrieben?', expected: [mietvertrag] },
    { q: 'When did I sign my rental agreement?', expected: [mietvertrag] },
    { q: 'Wie hoch ist meine Kaltmiete?', expected: [mietvertrag] },
    { q: 'Wie hoch war die letzte Stromrechnung?', expected: [strom[11]] },
    { q: 'How much was my electricity bill in March 2024?', expected: [strom[2]] },
    { q: 'Wie viel muss ich bei der Betriebskostenabrechnung nachzahlen?', expected: [nebenkosten] },
    { q: 'Was kostet meine Autoversicherung pro Jahr?', expected: [kfz] },
    { q: 'Wie hoch ist mein neuer Beitrag zur Krankenversicherung?', expected: [kv] },
    { q: 'Seit wann arbeite ich bei der Muster AG?', expected: [arbeitsvertrag] },
    { q: 'What is my annual salary according to my employment contract?', expected: [arbeitsvertrag] },
    { q: 'Wie viel Steuern bekomme ich für 2023 zurück?', expected: [steuer] },
    { q: 'Which laptop did I buy?', expected: [laptop] },
    { q: 'Wann läuft die Garantie meiner Waschmaschine ab?', expected: [garantie] },
    { q: 'Wann ist die nächste Hauptuntersuchung für mein Auto fällig?', expected: [tuev] },
    { q: 'Wohin bin ich 2024 geflogen?', expected: [flug] },
    { q: 'Was hat das Hotel in Lissabon gekostet?', expected: [hotel] },
    { q: 'Wie viel zahle ich für den Rundfunkbeitrag?', expected: [gez] },
    { q: 'Hundesteuer 2024', expected: [hund] },
    { q: 'Wer hat meine Heizung gewartet?', expected: [heizung] },
    { q: 'dentist invoice', expected: [zahnarzt] },
    { q: 'What do I pay for video streaming?', expected: [streaming] },
    { q: 'Wie viel habe ich im Dezember netto verdient?', expected: [gehalt] },
    { q: 'Riester Zulage 2023', expected: [riester] },
    { q: 'Habe ich eine Mahnung von den Stadtwerken bekommen?', expected: [mahnung] },
    { q: 'Wann habe ich mein Auto gekauft und was hat es gekostet?', expected: [autokauf] },
    { q: 'Ist mein Fahrrad gegen Diebstahl versichert?', expected: [hausrat] },
    { q: 'Telekom Kundennummer', expected: telekom },
  ];
  return { docs, questions };
}
