# Teepee — memo per i soci

*v1 · 2026-04-18 · ~10 minuti di lettura*

---

## Tesi (1 frase)

**Teepee è un content system in cui umani e agenti AI creano, pubblicano e fanno evolvere contenuti verificabili sotto policy esplicite.** Authoring self-hosted, pubblicazione statica sul web esistente, governance integrata.

---

## Il problema, in concreto

Oggi creare e pubblicare contenuti è spezzato su 5-6 strumenti diversi (chat, docs, wiki, issue tracker, CMS, static site generator). Gli LLM contribuiscono alla produzione ma spariscono dal modello del contenuto pubblicato. Non esiste una semantica nativa di **fork, proposta, approvazione, policy** per contenuti machine-readable.

Risultato: il web pubblica risultati finali morti. Chi legge non può forkare, non può proporre modifiche in modo strutturato, non può sapere chi (o cosa) ha prodotto quel contenuto e con quale diritto derivarlo.

---

## Wedge (uno, scelto)

**Documentazione tecnica di progetti OSS medio-grandi.**

Non: editoriale, legal, enterprise KB, consulting. Quelli arrivano dopo il product-market-fit, non prima.

Perché questo wedge:
- Pubblico che ha già Node installato — `npm install teepee` è accettabile
- Cultura già accettante di fork/PR come primitive
- Frustrazione misurabile e diffusa: oggi la doc OSS vive sparsa su `issue + PR + wiki + Discord + readthedocs`
- Adozione visibile (ogni repo GitHub diventa showcase potenziale)
- Distribuzione naturale (sviluppatori parlano ad altri sviluppatori)

---

## Killer demo (30 secondi)

Un utente apre un topic Teepee con un documento a metà e il summary scrive *"next: aggiungere sezione X, chiarire Y"*. Scrive in chat: `@coder avanza questo teepee`. L'agente legge il summary, produce la sezione X, committa la nuova versione.

Nessun prompt lungo, nessun ricostruire contesto ogni volta, nessuna context window consumata. Il lavoro è un oggetto ripreso con un gesto minimo.

Questo è il gesto che **nessun altro tool fa oggi**.

---

## Core del protocollo

Tre primitive, non sei. Piccolo come HTTP.

- **fork** — deriva un topic subtree con tutto lo stato (summary, sottotopic, documenti, policy)
- **propose** — collega un fork a un target come proposta revisionabile
- **publish** — espone uno snapshot su un canale con policy esplicita

Tutto il resto (review, approval, relay, autopilot, summary, recap, governance multi-team) è **convenzione sopra** queste tre. Test di qualità: se una feature non si esprime come composizione di fork/propose/publish, non entra nel core.

Secondo principio di design: **il protocollo deve essere insegnabile a un LLM in un prompt**. Se non lo è, è troppo complicato.

---

## Come emerge il protocollo

Non per decreto, non scrivendo una spec e sperando che qualcuno la implementi. Emerge per **adozione tool-first**:

1. Teepee vince come authoring per documentazione tecnica OSS
2. Il publishing statico + badge *"Open in Teepee"* porta il protocollo sul web tradizionale senza rompere niente
3. Altri implementano perché gli agenti capiscono nativamente il formato — è progettato per questo

Parallelo storico: Git → GitHub, RSS → blog readers. Lo strumento viene prima, lo standard dopo.

---

## Go / No-Go (criteri duri, non soffici)

**GO se entro 4 mesi dal primo deploy produzione:**

- [ ] 3 progetti OSS **esterni al team fondatore** adottano Teepee per la loro documentazione
- [ ] Almeno 1 proposta esterna ricevuta e gestita in ciascuno di quei 3 progetti
- [ ] Almeno 1 team indipendente sta implementando parti del protocollo fuori da teepee

**NO-GO o pivot duro se:**

- Adozione solo interna / amici-di-fondatori dopo 4 mesi
- Il protocollo interessa più del prodotto, ma il prodotto non viene usato
- Usage si ferma all'authoring, nessuno passa al publish

Niente "percezione di superiorità" come metrica. Solo numeri osservabili.

---

## Rischio principale (esplicito)

**Scenario di consolazione:** Teepee diventa un ottimo tool di authoring per uso interno, business sostenibile ma non trasformativo. Il protocollo resta teorico perché nessuna community lo adotta *per forza di necessità*.

Probabilità stimata: ~40%.

Mitigazione: identificare presto un **kernel user** — un progetto OSS specifico per cui Teepee è *l'unica opzione sensata*, analogo a come Git serviva al kernel Linux. Senza una forcing function, il protocollo non emerge mai.

---

## Cosa NON facciamo (esplicito, per evitare drift)

- Non costruiamo motori di ricerca, ranking algorithms ("ForkRank"), o indexer — è lavoro di Google/altri
- Non imponiamo scelte infrastrutturali ideologiche (IPv6-only, blockchain, federated protocols obbligatori)
- Non scriviamo una spec formale prima del prodotto
- Non inseguiamo contemporaneamente mercati editorial/legal/enterprise
- Non competiamo con Notion, Obsidian, Cursor sul loro terreno — siamo **a valle** (pubblicare e far evolvere il risultato), non **a monte** (scrivere il primo draft)

---

## Cosa esiste già (stato tecnico)

- v0.2.x funzionante in produzione interna
- Topic + mention-based agent execution (gli agenti si chiamano con `@nome`, eseguono in parallelo)
- Artifact versioning con op `create/update/edit/rewrite/restore` (edit = patch-based per ridurre latenza 10x)
- Sandbox: bubblewrap (Linux) e Docker (macOS), esecuzione di codice sicura
- Self-hosted multi-utente, mode `private` o `shared` con magic-link invite
- Codebase TypeScript, test coverage ragionevole, deploy via `npm install`

L'architettura è già pronta per:
- Static publish (Fase 2)
- Topic snapshots (Fase 3 — serve per proposal)
- Relay notice-only (Fase 4 — pochi endpoint, Rust+SQLite in appendice)

---

## Roadmap in 3 milestone

**M1 — Authoring superiore (0-4 mesi)**
Obiettivo: primi 3 progetti OSS esterni usano Teepee per la loro doc. Include: summary/recap policy per topic, linking umano stabile, stati documentali (draft/active/withdrawn/superseded), documentazione per adoption.

**M2 — Publishing chiuso (4-8 mesi)**
Obiettivo: quei 3 progetti pubblicano statici con badge "Open in Teepee" che porta lettori nel workflow di proposta. Include: static export, metadata Teepee nella pagina, protocollo copia/incolla per import.

**M3 — Proposte asincrone (8-12 mesi)**
Obiettivo: relay leggero in produzione, proposte circolano tra Teepee offline, review/approval multi-persona. Include: proposal notice spec, relay reference implementation, lifecycle completo.

La Fase 5 (formalizzazione protocollo) è conseguenza di M3, non obiettivo in sé.

---

## Competitor, inquadrati onestamente

| Categoria | Esempi | Perché Teepee è diverso |
|---|---|---|
| Note/KB personale o team | Notion, Obsidian, Logseq, Coda | Non pubblicano sul web aperto con governance; niente fork esterno |
| Static site generator | Hugo, Docusaurus, MkDocs | Niente fork/proposal nativo, authoring non AI-nativo |
| Dev docs platform | GitBook, readthedocs, Mintlify | Governance delegata a GitHub PR (fuori dal tool), AI bolt-on |
| Decentralizzati | Nostr, AT Protocol, ActivityPub | Non pensati per contenuti long-form governati, focus su social |
| AI coding/writing | Cursor, Aider, Claude Projects | A monte del publish, non risolvono distribuzione o governance |
| Wiki collaborativi | MediaWiki, Scrapbox | Centralizzati, niente AI nativa, niente machine-readable export |

**Nessuno oggi copre il loop completo: creazione AI-nativa → publish statico → fork/propose/governance sul pubblicato.** Questa è la scommessa.

---

## Investimento richiesto

*[Sezione da completare con il fondatore prima della presentazione]*

- **Team:** [2-3 engineers?]
- **Runway M1 (4 mesi, go/no-go):** [€/stima]
- **Runway M1+M2+M3 (12 mesi):** [€/stima]
- **Costi infrastruttura:** minimi (self-hosted, static publish, relay economici Rust+SQLite)
- **Use of funds:** 70% engineering, 20% developer relations per wedge OSS, 10% infrastruttura e legal

---

## In una frase

*Vinciamo prima come tool, il protocollo vince dopo. Se non vinciamo come tool entro M1, pivottiamo, non spingiamo avanti.*
