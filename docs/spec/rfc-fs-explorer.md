# RFC: Filesystem Explorer

**Status**: Proposed
**Target release**: M1 (papercut fix per wedge OSS dev-doc)
**Stima**: 2-3 settimane di lavoro full-stack
**Autore**: strategic pairing session, 2026-04-18

---

## 1. Motivazione

Oggi il pannello laterale di Teepee contiene solo il **Topic Explorer**. Un utente che apre Teepee per gestire la documentazione di un progetto OSS non ha modo di:

- vedere la struttura della repository (dove si trovano `README.md`, `CONTRIBUTING.md`, la cartella `docs/`)
- capire quali file sono stati modificati dall'ultimo job dell'agente
- riferire un file all'agente senza copiare manualmente il path dal terminale
- fare browsing visivo del progetto mentre chatta con gli agenti

È un papercut visibile al primo utilizzo. Chi arriva dal mondo VS Code/IDE si aspetta un file tree e sente la mancanza come un segnale di prodotto acerbo.

Questa RFC propone un **Filesystem Explorer** minimo, posizionato accanto al Topic Explorer, che risolve questa friction senza trasformare Teepee in un IDE.

---

## 2. Scope

### Goals

1. Offrire una **tree view read-only** del progetto sincronizzata col workspace del topic attivo
2. Preview del contenuto al click (Markdown renderizzato, testo raw, immagini visualizzate inline)
3. Indicatore visivo dei file **toccati da job recenti** del topic corrente
4. Context menu con *"@coder edit questo file"* che precompila un template nel ComposeBox
5. Rispettare la policy esistente `FilesystemRootConfig` (roots, roles, blocked paths)

### Non-goals (esplicitamente esclusi)

- **Editing inline di file** — Teepee non è un editor. Se l'utente vuole modificare un file, lo chiede a un agente o apre il suo IDE.
- **Tab multipli** — preview singolo alla volta
- **Ricerca globale / grep UI** — gli agenti sanno già fare grep; l'utente chiede a loro
- **Diff viewer integrato** — per diff reali c'è `git diff` o la UI di GitHub
- **Git UI** (branch switcher, commit button, staged changes) — territorio IDE
- **LSP integration** (hover, jump-to-def, symbols) — territorio IDE
- **Creazione / rinomina / delete di file** dall'UI — operazioni che vanno attraverso agenti

La regola mentale: **fs explorer è una superficie di contesto per chattare con gli agenti, non una superficie di editing**. Ogni feature che attraversa questa linea viene rifiutata.

---

## 3. User Stories

### US-1: Browse della repo
> *"Apro Teepee su un progetto OSS nuovo per me. Voglio capire dove sta la documentazione prima di chiedere ad @architect di produrre un aggiornamento."*

L'utente clicca sul tab "Files" nella sidebar. Vede la tree della repo con le cartelle pliegabili. Naviga fino a `docs/`, clicca su `docs/README.md`. Il contenuto renderizza nel main panel.

### US-2: Review dell'output di un agente
> *"@coder ha completato un job. Voglio vedere esattamente quali file ha toccato."*

Nel Files tab, i file modificati nell'ultimo job hanno un badge "●" accanto al nome. Cliccando su ciascuno, l'utente vede il contenuto aggiornato. Il badge sparisce dopo che l'utente l'ha visitato, o resta visibile fino al prossimo job.

### US-3: Riferire un file a un agente
> *"Voglio dire ad @architect di guardare `src/auth/session.ts` senza copiare il path."*

L'utente fa right-click sul file nella tree. Menu compare con *"Reference in chat"* e *"@coder edit this file"*. Il primo inserisce `teepee:/workspace/src/auth/session.ts` nel ComposeBox. Il secondo inserisce un template `@coder please edit teepee:/workspace/src/auth/session.ts to `.

### US-4: File immagine in preview
> *"Ho un'immagine in `docs/architecture.png`. Voglio verificare che sia quella giusta prima che @architect la inserisca nel README."*

Click sul file → il main panel renderizza l'immagine. Nessun preview editing.

---

## 4. UI Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Header (user, topic name, agents)                              │
├─────────────┬───────────────────────────────────────────────────┤
│             │                                                   │
│ [Topics]    │                                                   │
│ [Files]     │         Main panel (chat o file preview)          │
│ ─ ─ ─ ─ ─   │                                                   │
│             │                                                   │
│ • Topic A   │                                                   │
│   • Child1  │                                                   │
│             │                                                   │
│ [O]         │                                                   │
│  ▼ docs     │                                                   │
│    README.md│                                                   │
│    ●api.md  │                                                   │
│  ▼ src      │                                                   │
│             │                                                   │
│             │                                                   │
└─────────────┴───────────────────────────────────────────────────┤
│ ComposeBox                                                      │
└─────────────────────────────────────────────────────────────────┘
```

- Sidebar con due tab: `Topics` (esistente) e `Files` (nuovo)
- Tab `Files` mostra la tree del root attivo
- Main panel mostra il chat OR il preview file (mutually exclusive)
- Breadcrumb del path corrente sopra il preview
- Click su una row del topic tree → torna al chat
- Click su un file → mostra preview

### Indicatori visivi

- `●` (dot colorato) accanto a file modificati dall'ultimo job nel topic corrente
- `○` dot più pallido per modifiche di job precedenti nel topic
- Nessun indicatore per file non toccati da nessun job del topic
- Colori allineati al theme esistente di Teepee

---

## 5. API Endpoints (nuovi)

Sfruttano il modulo esistente `packages/core/src/filesystem.ts` + `FilesystemRootConfig` + ACL.

### `GET /api/fs/tree?root=<root-name>&path=<relative-path>`

Ritorna la struttura di una directory (single level, lazy loading children).

**Request**:
- `root`: nome del filesystem root configurato (default: root workspace del progetto)
- `path`: path relativo dentro il root (default: `""` = radice)

**Response**:
```json
{
  "root": "workspace",
  "path": "docs",
  "entries": [
    { "name": "README.md", "type": "file", "size": 4521 },
    { "name": "api", "type": "directory" },
    { "name": "architecture.png", "type": "file", "size": 80123, "binary": true }
  ]
}
```

**Errori**: `403` se ruolo utente non permette il root; `404` se path non esiste; `400` se path fuori dal root (path traversal).

### `GET /api/fs/file?root=<root-name>&path=<relative-path>`

Ritorna il contenuto del file per preview.

**Request**:
- `root`, `path`: come sopra

**Response**:
- Content-Type: `text/markdown`, `text/plain`, `image/*`, etc.
- Body: contenuto raw del file
- Headers custom:
  - `X-Teepee-File-Size`: bytes
  - `X-Teepee-Truncated`: `true` se il file è >1MB e il body è troncato

**Limiti**:
- File binari non-immagine: risposta con metadata ma non body (UI mostra "binary file, N bytes")
- File >10MB: `413 Payload Too Large`, UI mostra messaggio
- File >1MB testo: body troncato a 1MB + flag

**Errori**: `403`, `404`, `400` come sopra.

### `GET /api/fs/touched?topicId=<id>&jobId=<id>`

Ritorna la lista dei file modificati da un job specifico (per gli indicatori).

**Request**:
- `topicId`: topic corrente
- `jobId`: opzionale, se assente ritorna l'ultimo job writer del topic

**Response**:
```json
{
  "jobId": 524,
  "files": [
    { "path": "docs/api.md", "operation": "modified" },
    { "path": "docs/new-section.md", "operation": "created" }
  ]
}
```

**Nota**: richiede che l'orchestrator tracci i file scritti dai job. Se non esiste già, vedi Sezione 9 (Open Questions).

---

## 6. Frontend

### Componenti nuovi

- `packages/web/src/components/FilesystemExplorer.tsx` — tab principale
- `packages/web/src/components/FileTree.tsx` — tree view ricorsivo con lazy loading
- `packages/web/src/components/FilePreview.tsx` — preview pane (Markdown/raw/immagine)
- `packages/web/src/hooks/useFilesystemTree.ts` — fetching + caching della tree

### Componenti modificati

- `packages/web/src/App.tsx` — aggiunta del tab Files nella sidebar
- `packages/web/src/components/TopicTree.tsx` — invariato (sta su un tab separato)
- `packages/web/src/components/ChatView.tsx` — main panel diventa opzionale, alterna con `FilePreview`

### State management

- Tab attivo (`topics` | `files`) nello store locale
- File preview corrente: `{ root, path } | null`
- Tree expansion state: `Set<string>` dei path espansi
- Touched files del topic corrente: fetched al cambio topic, invalidato su `agent.job.completed`

---

## 7. Sicurezza e Permessi

### Riuso del layer esistente

Il modulo `packages/core/src/filesystem.ts` implementa già:
- `resolveFileTarget(config, role, root, relativePath)` — valida root + path + ACL del ruolo
- `FileAccessError` con status code
- Blocked host segments (`/proc`, `/sys`, `/dev`)
- Symlink detection

Gli endpoint `/api/fs/*` **devono** passare per `resolveFileTarget` prima di fare qualsiasi I/O.

### Role-based access

- `observer` → vede solo root pubblici (se definiti nel config)
- `collaborator` → vede root configurati come `readwrite` o `readonly` per quel ruolo
- `owner`, `trusted` → accesso completo ai root configurati

Nessuna nuova policy introdotta. Questa RFC non estende il modello permessi, solo l'UI.

### Limiti di sicurezza espliciti

- File size >10MB → 413, mai caricato in memory
- File binari non-immagine → solo metadata, no body
- Path traversal → già gestito da `resolveFileTarget`
- Lista di directory ignorate (`node_modules`, `.git`, `dist`, ...) già definita in `filesystem.ts:IGNORED_DIRS`

---

## 8. Implementation Plan (staged, testable)

### Stage 1 — Backend API (3-4 giorni)

1. Aggiungere endpoint `GET /api/fs/tree` in `packages/server/src/http/api-routes.ts`
2. Aggiungere endpoint `GET /api/fs/file`
3. Reuse di `resolveFileTarget` per validazione
4. Test integration in `packages/server/src/api-filesystem.test.ts`
5. Limits: file size cap, binary detection, truncation

### Stage 2 — Tree view frontend (4-5 giorni)

1. Componente `FileTree` con lazy loading (fetch solo alla espansione)
2. Componente `FilesystemExplorer` come wrapper con tab switching
3. Integrazione in `App.tsx` con stato tab attivo
4. Styling allineato al theme
5. Keyboard navigation (arrow keys, enter per expand/preview)

### Stage 3 — File preview (3-4 giorni)

1. Componente `FilePreview` con branch su content-type:
   - Markdown → `MarkdownRenderer` esistente
   - Testo → `<pre>` con syntax highlighting (usa `highlight.js` già presente)
   - Immagine → `<img>` con size limit
   - Binary → placeholder con metadata
2. Gestione errori (403, 404, 413)
3. Messaggio di troncamento se >1MB

### Stage 4 — Touched files indicator (2-3 giorni)

1. Backend: endpoint `/api/fs/touched` che query i file scritti dai job
   - Richiede tracking nel orchestrator (vedi Open Questions)
2. Frontend: fetch al cambio topic + on `agent.job.completed` event
3. UI: dot badge accanto ai file modificati nella tree

### Stage 5 — Context menu e reference (1-2 giorni)

1. Right-click sul file → menu contestuale
2. Azioni: *"Reference in chat"*, *"@coder edit this file"*
3. Integrazione con ComposeBox esistente (`insertText`)

### Stage 6 — Polish (2-3 giorni)

1. Loading states, skeleton UI
2. Errore network con retry
3. Keyboard accessibility full
4. Mobile responsive (ragionevole, non perfetto)
5. Test E2E base

**Totale**: ~15-20 giorni = 3-4 settimane. Stima pessimistica per tenere margine.

---

## 9. Open Questions

1. **Tracking dei file scritti dai job**: Teepee oggi traccia in DB quali *artifact* sono stati creati/modificati da un job, ma non i file del filesystem puri. Serve un meccanismo nuovo?
   - **Opzione A**: snapshot directory prima e dopo il job, diff per identificare i file toccati. Costo runtime: trascurabile su progetti piccoli, problematico su repo grandi.
   - **Opzione B**: hook nel sandbox che logga le write syscalls. Accurato ma complesso.
   - **Opzione C**: git status nel workspace del topic alla fine del job (richiede git init). Pulito ma requisito.
   - **Raccomandazione**: Stage 4 è opzionale per M1. Se è complesso, rilasciare Stage 1-3+5 senza indicator. Il papercut principale (browsing e preview) è risolto.

2. **Multi-root**: `FilesystemRootConfig` supporta più root (es. `workspace` + `home`). L'UI mostra un dropdown per scegliere il root? O mostra tutti i root visibili come entry di primo livello della tree?
   - **Raccomandazione**: entry di primo livello della tree. Zero UI extra. Il root name è visibile come nodo radice.

3. **Refresh della tree**: quando aggiornare la tree cache? On topic change, on job completion, manualmente? Polling?
   - **Raccomandazione**: on topic change + on job completion + manual refresh button nell'header della tab. No polling.

4. **File grossi in preview**: soft cap a 1MB con truncation o hard cap a 10MB con rifiuto?
   - **Raccomandazione**: entrambi. 1MB → truncate e mostra avviso. 10MB → rifiuta con messaggio chiaro.

5. **Simboli speciali** nei nomi file (emoji, UTF-8 complessi): supportare in UI o fallback a nome escaped?
   - **Raccomandazione**: supportare nativamente. Teepee è già UTF-8 dappertutto.

---

## 10. Alternatives Considered

### Alt 1: Solo ricerca file, niente tree
Sostituire tree con una searchbar fuzzy. Rapido per chi sa cosa cerca, ma non risolve il "non so cosa c'è nel progetto" che è il papercut principale. **Rifiutata**.

### Alt 2: Iframe Monaco/VS Code Web
Integrare Monaco editor o VS Code Web come file explorer completo. Apre la porta a editing, tabs, search, git UI — esattamente le cose che non vogliamo. **Rifiutata**: pulling in too much.

### Alt 3: Aspettare l'integrazione workspace
Implementare fs explorer dopo che il workspace feature è built, così è per-topic dall'inizio. **Rifiutata**: fs explorer ha valore *oggi* senza workspace (mostra la single directory del progetto). Non bloccarsi su dipendenza non ancora confermata.

### Alt 4: CLI only
Solo comandi `/ls docs` e `/cat docs/README.md` da ComposeBox, zero UI. Leggero ma contro-intuitivo per il pubblico M1 che viene da IDE. **Rifiutata**.

---

## 11. Success Criteria

- Un utente che apre Teepee per la prima volta può navigare la repo e aprire un file in <30 secondi senza leggere docs
- Almeno 2 dei 3 progetti OSS early adopter di M1 usano attivamente la tab Files (osservabile via frontend telemetry)
- Nessun incidente di sicurezza correlato a path traversal o file disclosure nei primi 3 mesi dopo il rilascio
- Riduzione del 30% dei messaggi tipo "dov'è il file X?" negli early adopter (qualitativo)

---

## 12. Riferimenti

- Codice esistente: `packages/core/src/filesystem.ts`, `packages/web/src/hooks/useFileSelector.ts`, `packages/web/src/components/ReferenceViewer.tsx`
- Memo strategico: `docs/memo-soci-v1.md` (wedge: documentazione tecnica OSS, M1)
- RFC correlato (parked): futuro RFC Workspace first-class per multi-topic isolation — fs explorer è indipendente e precede

---

## 13. Decisioni da prendere prima dell'implementazione

1. [ ] Stage 4 (touched files indicator) incluso in M1 o rimandato?
2. [ ] Tree view lazy loading o eager (fetch tutto il tree all'apertura)?
3. [ ] Preview di file binari non-immagine: placeholder solo, o offrire download?
4. [ ] Policy refresh: solo manuale/eventi, o anche polling soft (ogni 30s)?

Default proposti: 1) rimandare; 2) lazy; 3) placeholder solo; 4) manuale+eventi.
