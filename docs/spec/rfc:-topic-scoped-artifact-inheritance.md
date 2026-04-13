# RFC: Topic-scoped artifact inheritance

## Stato

Proposta

## Obiettivo

Rendere coerenti composer, lista documenti, sidebar topics e contesto agente introducendo uno scope di discoverability basato su topic corrente + catena dei parent.

```text
read/discoverability
  = current topic + ancestors

write default
  = current topic only

global search
  = explicit opt-in
```

## Problema attuale

Oggi i riferimenti artifact lato composer sono cercati globalmente con boost locale. Questo produce:

- rumore nei suggerimenti
- link accidentali verso documenti di rami non correlati
- semantica debole del tree dei topic
- incoerenza potenziale tra UI e contesto dato all'agente

In parallelo, il tree dei topic non segnala bene dove esiste materiale locale e non espone ancora tutte le azioni minime di manutenzione del topic.

## Decisione

Il tree dei topic diventa boundary di discoverability e, lato UI, surface del contesto locale.

- Un topic vede i propri artifact.
- Un topic eredita gli artifact dei suoi parent.
- Un topic non vede di default sibling, figli o altri rami.
- I link artifact esistenti restano sempre risolvibili globalmente.
- La ricerca globale resta disponibile, ma solo come azione esplicita.
- La sidebar segnala solo la presenza di artifact locali del topic.
- Il rename topic cambia il label, non l'identità logica del nodo.

## Regole canoniche

### 1. Scope

```ts
type ArtifactScope = 'local' | 'inherited' | 'global';

function getTopicLineage(topicId: number): number[];
// [current, parent, grandparent, ..., root]

function listScopedArtifacts(topicId: number, scope: ArtifactScope): Artifact[];
// local     => artifact.topic_id === topicId
// inherited => artifact.topic_id in getTopicLineage(topicId)
// global    => tutti gli artifact
```

### 2. Ranking

Il ranking avviene dopo il filtro di scope.

Bucket:

1. Artifact del topic corrente.
2. Artifact dei parent ordinati per distanza dal topic corrente.

Ordinamento intra-bucket:

1. `pinned desc`
2. `exact title match desc`
3. `prefix title match desc`
4. `updated_at desc`
5. `artifact_id desc`

Nessun boost fuzzy cross-scope. Prima si decide il confine semantico, poi si ordina.

### 3. Cap

- Composer autocomplete: massimo 15 risultati.
- Catalogo artifact nel prompt iniziale agente: massimo 30 artifact.
- Preload contenuti automatico: massimo 2 documenti oppure 16k chars totali.

Troncamento deterministico:

1. topic corrente
2. parent per distanza
3. dentro ogni bucket: pinned, match, recency

## Semantica UI e agente

### Composer

- `[[` resta il trigger di composizione.
- Il risultato finale inserito resta Markdown standard `[label](teepee:/artifact/...)`.
- Scope default dei suggerimenti: `inherited`.
- Escape hatch per ricerca globale:
  - toggle `Tutto il DB`, oppure
  - prefisso esplicito, oppure
  - seconda sezione risultati `Global`.

### Lista documenti topic

La UI documenti del topic mostra:

- `This topic`
- `Inherited from parents`

La sezione inherited deve essere comprimibile. Il confine tra locale ed ereditato deve essere evidente.

### Sidebar topic tree

Ogni nodo topic deve poter esprimere due semantiche distinte:

- contesto locale del nodo
- relazione gerarchica di inheritance

La presenza di artifact nella sidebar deve indicare solo materiale locale del topic:

```text
icon visible
  -> esistono artifact con topic_id = current topic

no icon
  -> nessun artifact locale nel topic

inheritance
  -> influenza discoverability e contesto
  -> non sporca l'indicatore del tree
```

Regola v1:

- mostrare `has_local_artifacts`
- non mostrare `has_inherited_artifacts`

Motivo: se l'icona includesse l'inherited, quasi tutti i topic discendenti apparirebbero "pieni" e il tree perderebbe valore informativo.

### Contesto agente

Nel prompt iniziale entra solo un indice compatto degli artifact eleggibili, non i body.

Contenuto auto-preload solo per:

- artifact linkati esplicitamente nel messaggio corrente
- artifact creati o aggiornati nello stesso job
- artifact `pinned` o `required`

Tutto il resto resta lazy via `read-current`, `read-version`, `read-diff`.

## Read/write policy

Per evitare edit accidentali su documenti ereditati:

```text
read visibility = current + ancestors
write default   = current only
write inherited = solo con riferimento esplicito al doc target
global write    = mai implicito
```

Regola pratica:

- Se l'agente vede un artifact parent nell'indice, può leggerlo.
- Non deve aggiornarlo implicitamente solo perché era visibile.
- Un update su artifact parent richiede riferimento esplicito nel turno o op esplicita derivata da quel doc.

## API changes

### Nuove semantiche server

1. `GET /api/references/suggest`
- Default `scope=inherited`.
- Parametro opzionale `scope=local|inherited|global`.
- Risposta estesa con:
  - `scope`
  - `source_topic_id`
  - `lineage_distance`
  - `is_inherited`
  - `is_pinned`

2. `GET /api/topics/:topicId/artifacts`
- Aggiungere supporto a sezione locale + inherited.
- Possibili alternative:
  - una singola lista con metadata `is_inherited`, oppure
  - risposta già raggruppata in `local[]` e `inherited[]`

Raccomandazione: lista piatta con metadata, grouping lasciato al client.

3. Topic tree query
- Estendere la query/lista topic usata dalla sidebar con:
  - `has_local_artifacts: boolean`, oppure
  - `local_artifact_count: number`
- V1 raccomandata: `has_local_artifacts`, perché basta per il presence indicator.

4. Topic rename mutation
- Aggiungere una mutation esplicita, per esempio:
  - `PATCH /api/topics/:topicId`
  - body `{ name: string }`
- Oppure endpoint dedicato `POST /api/topics/:topicId/rename`.

Semantica del rename:

```text
rename topic
  -> aggiorna topic.name
  -> non cambia topic.id
  -> non sposta artifact
  -> non rompe URI o riferimenti esistenti
```

5. Context builder agente
- La funzione che costruisce il catalogo artifact deve usare `scope=inherited`.
- Deve applicare il cap da prompt e il preload separatamente.

### Compatibilità

- Default behavior cambia solo nella discoverability.
- URI `teepee:/artifact/...` non cambiano.
- Apertura artifact tramite link resta globale e backward compatible.
- Il rename non invalida riferimenti esistenti perché l'identità resta `topic.id`.

## DB e query changes

### Query primitive

Introdurre una primitive condivisa:

```ts
getTopicLineage(db, topicId): Array<{ topic_id: number; distance: number }>
```

Questa primitive deve essere riusata da:

- suggest riferimenti
- lista artifact topic
- context builder agente
- check di autorizzazione per read artifact

### Query artifact

Introdurre una query scope-aware:

```ts
searchArtifactsInScope({
  topicId,
  lineage,
  query,
  scope,
  limit
})
```

Proprietà richieste:

- filtro per `artifact.topic_id IN lineage`
- ranking che preserva il bucket `distance`
- output con `lineage_distance`
- possibilità di bypass con `scope=global`

### Query topic tree

La query per la sidebar deve evitare N+1 e precomputare il segnale locale:

```sql
select
  t.*,
  count(a.id) > 0 as has_local_artifacts,
  count(a.id) as local_artifact_count
from topics t
left join artifacts a on a.topic_id = t.id
group by t.id
```

Per v1 è sufficiente usare `has_local_artifacts`; `local_artifact_count` può restare opzionale per UI future.

### Access checks

Separare chiaramente:

- `canReadArtifact(topicId, artifactId)` => true se artifact nel lineage
- `canWriteArtifact(topicId, artifactId)` => true se artifact nel topic corrente, salvo override esplicito

Questo evita che il check attuale di topic equality governi sia read sia write.

## Migrazione dati

Non è necessaria una migrazione strutturale se si riusa il modello topic parent già presente e se `topics.name` esiste già.

Migrazione opzionale consigliata:

- aggiunta flag `pinned` su artifact o relazione topic-artifact, se si vuole ranking stabile oltre la recency

Senza `pinned`, la RFC resta implementabile con schema corrente.

## UI states

### Composer

Stati minimi:

- `default inherited results`
- `empty inherited results`
- `global search opt-in active`
- `global results returned`

Copy consigliata:

- se nessun risultato inherited: `Nessun documento in questo topic o nei parent`
- CTA secondaria: `Cerca in tutto il DB`

### Topic documents panel

Stati:

- solo documenti locali
- locali + inherited
- nessun documento
- inherited collapsed / expanded

### Topic tree sidebar

Stati minimi del nodo topic:

- nodo normale
- nodo con `has_local_artifacts`
- nodo selected
- nodo context menu aperto
- nodo renaming

Menu contestuale minimo:

- `Rename`

Vincoli UX per `Rename`:

- rename inline o modal leggera
- nome non vuoto
- trim automatico
- collision policy coerente con create topic
- optimistic update consentito con rollback su errore

### Agent context inspection

Se esiste una UI debug/inspection del contesto:

- distinguere `visible in scope`
- distinguere `preloaded`
- distinguere `lazy-only`

Questo è importante per spiegare i costi token.

## Efficienza token

La policy è efficiente se si separano visibilità e preload.

```text
visible catalog
  -> molti doc, metadati minimi

preloaded bodies
  -> pochissimi doc, solo se espliciti o required
```

Implicazioni:

- lo scope `current + ancestors` è sostenibile
- il costo vero è il preload automatico dei body
- il catalogo deve restare minimale: `artifact_id`, `kind`, `title`, `topic_id`, `lineage_distance`, `current_version`

L'indicatore `has_local_artifacts` nella sidebar è efficiente perché aggiunge un segnale booleano aggregato, non contenuto documentale.

## Trade-off

Pro:

- meno rumore nel composer
- meno cross-link accidentali
- semantica più forte del tree
- migliore prevedibilità del contesto agente
- migliore efficienza token rispetto a preload globale
- il tree segnala dove esiste conoscenza locale
- il rename topic rende il tree manutenzionabile senza rompere identità o riferimenti

Contro:

- minore discoverability cross-topic
- necessità di un escape hatch globale chiaro
- maggiore complessità nei check read/write
- una query topic tree più ricca rispetto alla semplice lista topic

## Topic Tree UX Contract

Il tree dei topic ha tre responsabilità distinte e non sovrapposte:

1. mostrare gerarchia
2. segnalare presenza di artifact locali
3. offrire azioni locali sul topic

Regole:

- l'inheritance governa discoverability e contesto
- il presence indicator governa solo il contenuto locale del topic
- il rename governa solo il label del topic

Quindi:

```text
tree structure
  -> relation between topics

artifact icon
  -> local knowledge presence

rename
  -> label mutation only
```

Questa separazione evita che un singolo segnale UI comunichi troppe cose insieme.

## Piano di implementazione

1. Introdurre `getTopicLineage()` nel core.
2. Rifattorizzare suggest references a `scope=inherited`.
3. Rifattorizzare lista artifact topic con metadata di inherited.
4. Estendere la query topic tree con `has_local_artifacts`.
5. Aggiungere mutation `renameTopic`.
6. Separare check read e write artifact.
7. Allineare context builder agente alla stessa semantica.
8. Aggiungere opt-in globale nel composer.

## Test necessari

### Core / DB

- `getTopicLineage()` restituisce ordine e distanza corretti.
- `searchArtifactsInScope(inherited)` include current + ancestors ed esclude sibling/children.
- `canReadArtifact()` consente lineage read.
- `canWriteArtifact()` blocca inherited write impliciti.
- la query topic tree calcola correttamente `has_local_artifacts`.

### API

- `/api/references/suggest` defaulta a `inherited`.
- `scope=global` allarga il set.
- metadata `is_inherited` e `lineage_distance` sono corretti.
- `/api/topics/:topicId/artifacts` distingue locale ed inherited.
- la query/lista topic restituisce `has_local_artifacts` coerente.
- la mutation di rename aggiorna `topic.name` senza cambiare `topic.id`.

### Web UI

- composer mostra prima artifact locali, poi parent
- composer non mostra sibling di default
- toggle globale espande davvero il set
- link artifact già esistenti continuano ad aprirsi
- panel documenti rende correttamente sezioni locale/inherited
- sidebar mostra icona per topic con artifact locali
- sidebar non mostra icona per topic senza artifact locali ma con parent che ne hanno
- `Rename` aggiorna il label del topic senza alterare selezione, routing o artifact associati
- `Rename` fallisce correttamente su nome invalido o collisione

### Agent orchestration

- il catalogo iniziale include artifact inherited come metadati
- i body non vengono preloadati salvo casi previsti
- un artifact parent può essere letto
- un artifact parent non può essere scritto implicitamente

## Decisione raccomandata

Adottare questa regola come semantica unica di sistema:

```text
tree = boundary di discoverability
link esplicito = override intenzionale
prompt iniziale = indice compatto
body documenti = lazy by default
write inherited = explicit only
artifact icon = local only
rename topic = label only
```
