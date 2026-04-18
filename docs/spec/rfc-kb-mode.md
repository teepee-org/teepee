# RFC: Teepee KB Mode

**Status**: Parked / Post-PMF
**Target release**: N/A (implementazione condizionale — vedi § 3)
**Stima**: 4-6 mesi di engineering per implementazione completa
**Autore originale**: documento utente condiviso durante strategic pairing 2026-04-18
**Revisione critica**: stessa sessione, con estrazione sub-set per M1

> ⚠️ **Questa RFC non è approvata per implementazione completa.** Il documento originale (§ 4+) è intellettualmente valido e tecnicamente ragionevole, ma l'implementazione integrale costituirebbe un secondo prodotto (Teepee-come-wiki) concorrente con Obsidian/Notion/MediaWiki, fuori dal wedge M1 (documentazione tecnica OSS).
>
> Un sub-set ristretto è stato **estratto per M1** (vedi § 2). Il resto resta documento di riferimento per decisioni future.

---

## 1. Summary esecutivo

L'utente ha prodotto un documento architetturale completo proponendo Teepee come control plane per una knowledge base ispirata al pattern di Karpathy (`raw sources → persistent wiki → schema/governance`). Il documento distingue correttamente:

- **Topic tree** = workflow / ownership / ACL
- **Artifact network** = canonical wiki / links / metadata / retrieval

Questa separazione è architetturalmente sana ed evita di trasformare la gerarchia dei topic in un'ontologia rigida.

**Il problema non è la qualità del design**, ma il match con la fase attuale del prodotto:

- Introduce 9 page type logici (`source`, `entity`, `concept`, ...)
- Richiede FTS infrastructure, link graph normalizzato, metadata ricchi
- Propone 4-6 workflow operativi (ingest, query, lint, review)
- Suggerisce 4 fasi di implementazione da ~6 mesi totali

Questa complessità è ragionevole *dopo* product-market-fit, non *prima*. Il memo ai soci (`docs/memo-soci-v1.md`) commette esplicitamente Teepee al wedge documentazione tecnica OSS — un wedge che *non richiede* KB Mode per riuscire.

**Decisione**: park integrale, estrazione chirurgica di 3 elementi per M1.

---

## 2. Cosa è stato estratto per M1 (implementato o da implementare)

Dal documento originale sono stati identificati tre elementi che costano poco, servono davvero a M1, e sono indipendenti dal resto dell'architettura KB:

### 2.1 Campo `slug` su artifact

Ogni artifact ha uno `slug` oltre al title:
- Auto-generato dal title alla creazione (lowercase, `-` come separatore, no spazi)
- Override manuale opzionale
- **Non auto-update** quando cambia il title (il title può evolvere, lo slug no)

**Motivazione**: abilita identificatori umani stabili per linking ergonomico, indipendentemente dalla storia editoriale del title.

**Costo stimato**: ~1 giorno di lavoro. Migration schema + util di generazione + UI che lo mostra.

**Status M1**: non ancora implementato. Candidato per prossimo sprint se M1 vuole supportare linking inter-artifact.

### 2.2 Lifecycle documentale esplicito

Stati su artifact (o topic, da decidere al momento dell'implementazione):
- `draft` — in lavorazione, non pronto
- `active` — current, valid
- `withdrawn` — ritirato, non più valido
- `superseded` — sostituito da un altro (link esplicito a `superseded_by_artifact_id`)

Comportamento viewer:
- `withdrawn`: banner "documento ritirato"
- `superseded`: banner con link al successore
- Discoverability: esclusi da suggerimenti ordinari di default

**Motivazione**: il memo M1 cita esplicitamente *"primi stati documentali"* come feature Fase 1. Questo è quello.

**Costo stimato**: ~2-3 giorni. Schema + enum validation + UI badge + filtro default nei listing.

**Status M1**: parzialmente presente (c'è già concetto di "current version" ma non lifecycle). Da completare.

### 2.3 Sintassi `#topic/slug` come lookup umano

Nel ComposeBox, l'utente può digitare `#12/auth-flow-v2` come riferimento.

Regola di canonicalizzazione:
1. L'utente digita `#12/auth-flow-v2`
2. Teepee risolve a un `artifact_id`
3. Il messaggio persistito usa comunque `teepee:/artifact/<id>` (identità stabile)
4. In UI il label leggibile resta visibile

**Motivazione**: rende il linking ergonomico senza introdurre dipendenza da naming instabile. Da input umano → identità canonica → label leggibile. Matcha pattern noto (GitHub `#123`, Jira `PROJ-42`).

**Costo stimato**: ~2 giorni. Parser nel ComposeBox + resolver backend + rendering label.

**Status M1**: non implementato. Candidato per sprint post-fs-explorer.

### 2.4 Totale sub-set M1

~5-6 giorni di lavoro. Tre feature piccole, indipendenti, **tutte allineate al wedge documentazione**. Nessuna richiede infrastruttura nuova (no FTS, no link graph, no metadata schema, no workflow operativi).

---

## 3. Criteri di unpark del full KB Mode

Implementare l'integrale KB Mode solo se **tutti** i seguenti sono veri:

1. **M1 è validato** (3 progetti OSS adottano doc + 1 proposta ciascuno)
2. **Un early adopter sta usando Teepee come knowledge base**, non solo come doc platform, e sta sperimentando i limiti del modello artifact-only
3. **Emerge segnale forte per FTS/retrieval** — gli utenti chiedono ricerca sul contenuto, non solo su title
4. **6 mesi di engineering time disponibili** senza ritirare risorse da altre aree strategiche
5. **Scelta strategica esplicita di estendere Teepee verso il territorio wiki/knowledge-base** (competenza con Notion/Obsidian/MediaWiki, che cambia positioning)

Se anche uno manca, resta parked. L'estrazione M1 (§ 2) è **sufficiente per 6-12 mesi di evoluzione del prodotto** senza toccare il full KB Mode.

---

## 4. Documento originale (archiviato integrale)

*La sezione seguente è il documento originale dell'utente preservato intatto come archivio del pensiero architetturale. La lettura critica e le decisioni di scope sono in § 1-3 sopra.*

---

### 4.1 Stato

Spec architetturale proposta. Questa specifica descrive un modello per usare Teepee come control plane di un wiki operativo e scalabile, ispirato al pattern `raw sources -> persistent wiki -> schema/governance`, ma adattato al modello artifact/topic già presente nel sistema.

### 4.2 Obiettivo

Usare Teepee per mantenere una knowledge base incrementale, versionata e interrogabile, senza piegare la gerarchia dei topic a ruolo di knowledge graph.

L'obiettivo non è clonare un wiki filesystem-first tipo Obsidian. L'obiettivo è:

- mantenere fonti grezze immutabili
- costruire pagine canoniche versionate
- supportare workflow operativi di ingest, query, review e lint
- separare identità stabile dei documenti da riferimenti umani ergonomici
- poter scalare oltre un semplice PoC

### 4.3 Decisione Architetturale Centrale

La separazione fondamentale è:

```text
TOPIC TREE = workflow / scope / ownership / ACL
ARTIFACT NETWORK = canonical wiki / links / metadata / retrieval
```

Questa è la regola che evita di trasformare la gerarchia dei topic in una ontologia rigida.

### 4.4 Modello Concettuale

```text
raw sources
    |
    v
operational topics
  ingest/*
  query/*
  lint/*
  review/*
    |
    v
teepee control plane
  jobs
  ACL
  versioning
  concurrency
    |
    +--------------------+
    |                    |
    v                    v
canonical artifacts   derived indexes
wiki pages            FTS / links / metadata / facts
    \                    /
     \                  /
      +---- retrieval --+
             |
             v
     synthesis / answers / review output
```

### 4.5 Principi

1. `artifact_id` è l'identità canonica interna dei documenti.
2. I topic non modellano la knowledge graph.
3. I documenti canonici sono artifact Markdown versionati.
4. I riferimenti umani devono essere leggibili, ma non devono sostituire gli identificatori stabili.
5. Il sistema deve privilegiare `many readers, very few canonical writers`.
6. `withdrawn` e `superseded` sono stati del documento, non scorciatoie di redirect.
7. Search e retrieval devono essere first-class sui contenuti canonici, non solo su title/path.

### 4.6 Scope di Teepee nel Pattern

Teepee viene usato come control plane e store dei documenti canonici:

- orchestration dei job
- visibilità e lineage tramite topic tree
- versioning dei documenti
- concorrenza e controllo di scrittura
- workflow di review e promozione

Il wiki non deve essere modellato come albero di topic. Deve essere modellato come rete di artifact con metadata e link espliciti.

### 4.7 Struttura Logica Proposta

```text
Knowledge Base (root topic)
  canonical artifacts:
    Index
    Log
    Overview
    Entity/*
    Concept/*
    Source/*
    Synthesis/*

  child topics operativi:
    ingest/<source-id>
    query/<question-id>
    lint/<run-id>
    review/<change-id>
```

### 4.8 Tipi di Documento

L'insieme attuale dei kind artifact è troppo stretto per una knowledge base. Per la KB servono almeno questi page type logici:

- `source`
- `entity`
- `concept`
- `index`
- `overview`
- `log`
- `synthesis`
- `query-answer`
- `review-report`

Se i kind persistenti restano inizialmente quelli attuali, la KB può partire usando `kind=spec` o `kind=report` come contenitore tecnico, ma il modello target deve introdurre metadata più ricchi per distinguere il tipo semantico della pagina.

### 4.9 Modello Dati Proposto

#### Artifact canonico

Ogni pagina wiki canonica è un artifact Markdown versionato.

Campi concettuali richiesti:

- `artifact_id`
- `topic_id`
- `kind`
- `title`
- `status`
- `current_version`
- metadata strutturati

Metadata desiderati:

- `slug`
- `page_type`
- `aliases`
- `tags`
- `source_ids`
- `review_status`
- `last_reviewed_at`
- `owner`
- `confidence`

#### Indici derivati

Per scalare servono tabelle o viste derivate, aggiornate a ogni modifica canonica:

- `artifact_current_fts` — full-text index del body della current version
- `artifact_links` — link normalizzati tra artifact
- `artifact_metadata` — attributi di retrieval e governance
- opzionale `artifact_facts` o `artifact_claims` — utile per lint, contradiction detection, source coverage

### 4.10 Identità e Naming

#### Identità canonica

L'identità forte del documento deve restare:

```text
teepee:/artifact/<artifact_id>
```

Questo garantisce stabilità sotto rename, move e riorganizzazione.

#### Riferimento umano

Il riferimento umano consigliato è:

```text
#<topic-id>/<slug>
```

Esempio:

```text
#12/auth-flow-v2
```

Questo riferimento è una sintassi di lookup umana. Non è l'identità del documento.

#### Regola di canonicalizzazione

Flusso consigliato:

1. L'utente o l'agente digita `#12/auth-flow-v2`.
2. Teepee risolve il riferimento a un `artifact_id`.
3. Il messaggio o il link salvato usa comunque `teepee:/artifact/<id>`.
4. In UI si può mostrare il ref umano come label o path leggibile.

Con questa regola:

- i link persistiti restano stabili
- lo slug resta un layer di ergonomia
- move e rename non rompono i link già salvati

### 4.11 Title vs Slug

#### Title

Il `title` è il nome visibile del documento.

Regole:

- libero
- può contenere spazi
- può cambiare anche per motivi editoriali

#### Slug

Lo `slug` è l'identificatore umano stabile.

Regole consigliate:

- lowercase
- numeri consentiti
- separatore `-`
- niente spazi
- niente dipendenza dal title dopo la creazione iniziale

Esempio:

- `title`: `Auth Flow V2`
- `slug`: `auth-flow-v2`
- ref umano: `#12/auth-flow-v2`

#### Policy di generazione

Policy raccomandata:

- creazione automatica dello slug dal title
- override manuale opzionale
- nessun auto-update dello slug quando cambia il title

Motivazione:

- il title può evolvere spesso
- lo slug deve cambiare raramente
- i rename cosmetici non devono spezzare i riferimenti umani

### 4.12 Rename, Move e Alias

#### Distinzione semantica

Bisogna distinguere nettamente:

- `rename` o `move` — stesso documento, nuova collocazione o nuovo slug
- `withdrawn` — documento non più valido
- `superseded` — documento non più valido perché sostituito da un altro

`rename/move` appartengono alla storia del naming e della collocazione.
`withdrawn/superseded` appartengono al lifecycle del documento.

#### Alias storici

Serve una storia dei riferimenti umani.

Schema logico:

- `artifact_aliases`
- `artifact_id`
- `topic_id`
- `slug`
- `is_current`
- `created_at`
- opzionale `retired_at`

Nota di design:

- nella v1 non conviene introdurre `redirect_to_artifact_id` negli alias
- rename/move e supersession vanno tenuti separati

#### Regole di risoluzione

Risoluzione raccomandata:

1. match sui current alias
2. se assente, fallback su alias storici
3. se match storico, UI con banner `moved from ...` o `renamed from ...`
4. il link persistito finale resta sempre su `artifact_id`

#### Riuso dello slug

Se il sistema canonicalizza subito a `artifact_id`, il vecchio slug non deve bloccare per sempre il riuso.

Trade-off:

- i messaggi già salvati restano stabili perché puntano all'id
- un ref umano copiato a mano come puro `#topic/slug` non ha stabilità forte eterna se lo slug viene riusato

Questa è una limitazione intrinseca del riferimento umano corto.

### 4.13 Lifecycle dei Documenti

Il documento deve avere uno stato esplicito.

Stati consigliati:

- `draft`
- `active`
- `withdrawn`
- `superseded`

Metadata aggiuntivi consigliati:

- `withdrawn_at`
- `withdrawn_reason`
- `superseded_by_artifact_id`

#### Comportamento dei link

`teepee:/artifact/<id>` deve continuare sempre a risolversi.

Comportamento viewer:

- se `withdrawn`: banner esplicito che il documento è ritirato
- se `superseded`: banner con link al successore
- nessun redirect automatico dal link canonico

#### Discoverability

Per default:

- `withdrawn` e `superseded` esclusi dai suggerimenti ordinari
- inclusi con match esatto, toggle dedicato o link esplicito
- non inseriti automaticamente nel contesto agente salvo riferimento esplicito o policy specifica

### 4.14 Ruoli Agente

Per la KB non conviene partire con molti agenti writer.

#### Raccomandazione iniziale

`v1`: un solo agente `wiki-maintainer` con tre modalità operative:

- `ingest`
- `curate`
- `lint`

#### Evoluzione successiva

Solo quando il volume cresce:

- `canonical writer`
- `query synthesizer`
- `linter/reviewer`

#### Regola architetturale

```text
many readers
few writers
idealmente one canonical writer per knowledge area
```

Motivazioni:

- meno conflitti di scrittura
- meno duplicati semantici
- più coerenza editoriale
- più semplice controllo di qualità

### 4.15 Workflow Operativi

#### Ingest

```text
raw source -> topic ingest/<source-id> -> candidate analysis -> canonical update
```

#### Query

```text
user question -> topic query/<question-id> -> retrieval -> synthesis artifact
```

Regola: la query produce per default output non canonico o derivato. Nuova conoscenza potenzialmente canonica passa da review o canonical writer.

#### Lint

```text
scheduled/manual lint -> topic lint/<run-id> -> findings -> review/report artifacts
```

Controlli tipici: pagine orfane, contraddizioni, tag mancanti, fonti non collegate, pagine stale, overview incoerenti con entity/concept pages.

#### Review

```text
candidate change -> topic review/<change-id> -> validation -> canonical promotion
```

### 4.16 Retrieval e Search

Per un wiki a scala la search sugli artifact deve lavorare sul contenuto della current version.

#### Requisiti minimi

- FTS sul body corrente degli artifact canonici
- ranking per titolo, body, tag, page type, freshness
- supporto a filtri per lineage/topic quando serve contesto operativo
- supporto a match espliciti su alias e slug

### 4.17 Knowledge Graph implicita

La knowledge graph non deve vivere nei topic. Deve emergere da:

- link tra artifact
- metadata
- tabelle derivate
- opzionalmente facts/claims estratti

### 4.18 Topic Tree: Limiti e Uso Corretto

Uso corretto:

- scope operativo
- ownership
- ACL
- lineage
- separazione dei workflow

Uso scorretto:

- topic = pagina wiki
- topic tree = tassonomia semantica primaria
- relazioni concettuali modellate come parent/child topic

### 4.19 Source of Truth ed Export

La soluzione consigliata è:

- DB artifact come source of truth
- export filesystem opzionale come materializzazione

### 4.20 Roadmap Raccomandata (dal documento originale)

#### Fase 1: PoC coerente

- usare artifact come pagine wiki
- usare topic come workflow `ingest/query/lint`
- mantenere `artifact_id` come identità canonica
- introdurre ref umano `#topic/slug` come input di lookup

#### Fase 2: KB mode minimo

- metadata wiki su artifact
- slug auto-generato con override manuale
- alias storici
- stati `active/withdrawn/superseded`
- suggerimenti che escludono ritirati di default

#### Fase 3: Scalabilità reale

- FTS sul body canonico
- link extraction
- ranking ibrido
- candidate/review/canonical promotion
- lint strutturale e contradiction detection

#### Fase 4: Ecosistema

- export/sync filesystem opzionale
- viste specialized per browsing
- strumenti di governance per stale content e coverage

### 4.21 Non-Obiettivi

- trasformare Teepee in clone 1:1 di Obsidian
- usare il topic tree come knowledge graph primaria
- consentire a molti agenti di scrivere direttamente nel canonico senza governance
- basare la stabilità dei link su slug o title

### 4.22 Rischi Principali

- conflitti di scrittura se si moltiplicano i writer troppo presto
- duplicazione semantica se manca review canonica
- retrieval debole se non si indicizza il body corrente
- drift editoriale se il lifecycle non è esplicito
- ambiguità dei riferimenti umani se si confonde slug con identità

### 4.23 Sintesi Finale

La soluzione corretta per supportare il pattern di Karpathy in Teepee è usare:

- topic gerarchici come control plane operativo
- artifact versionati come pagine wiki canoniche
- `artifact_id` come identità stabile
- `#topic/slug` come riferimento umano
- lifecycle documentale esplicito
- layer di search/indexing/linking sopra gli artifact

In breve:

```text
Teepee should orchestrate the wiki, not become the wiki's ontology.
```

### 4.24 Riferimenti

- [Karpathy gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

---

## 5. Decisioni cristallizzate per futuro implementatore

Se un giorno questa RFC verrà sbloccata per implementazione integrale:

1. **Non trasformare il topic tree in ontologia** — è stato tentato implicitamente da altri sistemi e fallisce. Topic = workflow, artifact network = conoscenza.
2. **Partire dal sub-set M1 (§ 2) come foundation** — slug + lifecycle + `#topic/slug` lookup sono pre-requisiti, non opzionali.
3. **FTS + link graph + metadata sono fase tardi**, non early. Prima validare che il modello base regge su utenti reali.
4. **Many readers, few writers è una regola sociale, non tecnica** — va applicata come convenzione + UI che la favorisce, non come lock hardcoded che costringe.
5. **Evitare redirect automatici** nel canonical URI — il link resta stabile, il viewer mostra banner "moved/renamed/withdrawn/superseded" esplicito.
6. **Non competere con Obsidian su filesystem-first** — Teepee è DB-first con export opzionale.

---

## 6. Riferimenti

- Documento originale (preservato integrale in § 4)
- Memo strategico: `docs/memo-soci-v1.md` (§ 11 conferma wedge documentazione OSS come priorità, KB mode come pivot post-PMF)
- RFC correlate: `rfc-workspace.md` (indipendente, anche parked), `rfc-fs-explorer.md` (attiva M1)
- Inspiration originale: pattern Karpathy su KB incremental (link nel documento utente)
