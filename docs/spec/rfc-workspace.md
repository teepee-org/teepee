# RFC: Workspace as First-Class Entity

**Status**: Parked / Post-M1
**Target release**: N/A (implementazione condizionale — vedi § 12)
**Stima**: 2.5 - 4 mesi di engineering dedicato (~11-16 settimane realistic)
**Autore**: strategic pairing session, 2026-04-18

> ⚠️ **Questa RFC non è approvata per implementazione.** È archivio del pensiero fatto durante una sessione di analisi strategica. Viene implementata solo se e quando si verificano le condizioni di § 12. Fino ad allora resta documento di riferimento, non roadmap.

---

## 1. Problema

Teepee oggi ha un **collo di bottiglia di concorrenza filesystem**:

- Una singola istanza Teepee gira su un singolo `basePath` (il project directory)
- Tutti i job agent — in qualunque topic — eseguono con `cwd = basePath`
- Se due job writer partono in topic diversi simultaneamente, condividono lo stesso filesystem live → race

Il writer-lock esistente (`findRunningWriterJob` in `packages/core/src/orchestrator.ts:436`) è globale per chain, non per topic. Blocca job legittimi in topic non correlati mentre un altro sta scrivendo altrove.

**Conseguenze pratiche**:
- Due utenti che lavorano in parallelo su feature diverse si ostacolano
- Il team non può fare *"Alice su feature A, Bob su feature B"* in vero parallelo
- Il positioning *"team workspace per lavoro AI coordinato"* non regge oltre 2-3 utenti senza workaround manuali

Questa RFC propone un modello di **workspace come first-class entity**, separato dal topic, che abilita source-code isolation per utente/task.

---

## 2. Status: perché parked

Il memo ai soci (`docs/memo-soci-v1.md`) si impegna a:
- **Wedge M1**: documentazione tecnica OSS
- **Criterio go/no-go (4 mesi)**: 3 progetti OSS esterni adottano Teepee per doc + 1 proposta esterna ciascuno
- **Scelta esplicita**: *non competiamo su code-coordination, quella è pivot secondario condizionale*

Il wedge documentazione **non soffre del bottleneck di concorrenza** (i doc entrano raramente in conflitto simultaneo, e il writer-lock di oggi è accettabile). Implementare workspace pre-M1 significa:

1. Spendere 2.5-4 mesi di engineering su infrastruttura per utente immaginato
2. Costruire astrazione prima che un utente reale l'abbia richiesta
3. Rimandare di 2-4 mesi tutto il lavoro M1 necessario ad adozione doc

**Per questo la RFC è parked**. Il pensiero fatto è prezioso, ma deve restare fermo fino a quando le condizioni di § 12 lo sbloccano.

---

## 3. Modello concettuale

### 3.1 La distinzione chiave: Workspace ≠ Topic

Teepee oggi confonde tre cose che la coincidenza del topic nasconde:

| Ruolo | Oggi | Dovrebbe essere |
|---|---|---|
| Thread di discussione | Topic | Topic |
| Spazio di coordinazione (artifact, summary) | Topic | Topic |
| Stato del filesystem (branch, worktree) | Basepath globale | **Workspace** (nuovo) |

Il workspace è una nuova entità distinta che **incarna uno stato del filesystem**. I topic vi si attaccano (o lo ereditano dal parent). Quando un topic diverge nello stato del codice, forka esplicitamente un nuovo workspace.

### 3.2 Struttura

```
Workspace = {
  id: <numeric>,
  branch: "teepee/feature-a",
  worktree_path: "~/teepee-workspaces/feature-a",
  policy: { readonly | readwrite | trusted },
  lifecycle_hooks: { on_create, on_destroy },
  env_vars: { DATABASE_URL, PORT, ... },
  port_allocation: { app_port: 3042, db_port: 5442, ... }
}

Topic = {
  ...existing fields...,
  workspace_id: <numeric | null>  // null = inherit from parent, or use project root
}
```

### 3.3 Relazione workspace ↔ topic

- **Root topic** di default: workspace "main" (= `basePath` attuale, branch `main` o quello che c'è)
- **Topic figlio**: eredita il workspace del parent **di default**
- **Topic può forkare il workspace esplicitamente**: crea un nuovo workspace (branch + worktree) che deriva da quello corrente
- **Topic può adottare un workspace esistente** (join): utile per collaboration multi-topic sullo stesso stato

Il workspace tree è **più piatto** del topic tree. In progetti reali attesi: 10-20 workspace attivi in un repo con 100+ topic.

### 3.4 Esempio concreto

```
Topic "My Project" (root)         → workspace "main" (default)
├── "Architecture discussion"      → eredita "main"
├── "Bug #123 investigation"       → eredita "main" (read-only)
├── "Feature A implementation"     → FORK → workspace "feature-a"
│   ├── "Feature A API design"     → eredita "feature-a"
│   ├── "Feature A tests"          → eredita "feature-a"
│   └── "Feature A refactor try"   → FORK → workspace "feature-a-refactor"
└── "Feature B implementation"     → FORK → workspace "feature-b"
```

3 workspace totali per 7 topic. Il 90% dei topic eredita, solo quelli che *divergono davvero* forkano.

---

## 4. Semantica del parallel work

### 4.1 Cosa funziona davvero in parallelo

| Scenario | Risultato |
|---|---|
| Alice in ws-A, Bob in ws-B (task diversi) | **Parallel vero** ✓ |
| Alice writer in ws-A, Bob reader in ws-A | Parallel con ruoli differenziati ✓ |
| Alice + Bob entrambi writer in ws-A | **Serializzati** (writer-lock per-workspace) |
| Alice in child topic di ws-A, Bob in parent topic di ws-A | Condividono ws-A → serializzazione writer |

### 4.2 Principio

> **Different workspaces → parallel. Same workspace → serialized writers.**

La scelta di condividere o forkare è esplicita dell'utente, con default ragionevole (inherit from parent).

### 4.3 Quello che NON viene fornito

- **Real-time co-editing** (VS Code Live Share): esplicitamente fuori scope. Nel mondo agent-driven 2026 non è il gesto dominante.
- **Merge automatico** di conflitti: Teepee produce le branch, l'utente mergia via workflow abituale (PR su GitHub, `git merge` manuale, ecc.)
- **Sync real-time cross-workspace**: Alice in ws-A non vede i cambi di Bob in ws-B finché non si fa merge esplicito. Normale workflow git.

---

## 5. Il problema environment isolation (DB, services, ecc.)

### 5.1 Classificazione dei progetti

Il 65% dei progetti OSS realistici per il wedge cade in categorie che workspace risolve out-of-the-box:

| Tipo progetto | Frequenza | Soluzione |
|---|---|---|
| Zero DB (CLI, libreria, static site) | ~40% | Nessun problema |
| SQLite file-based | ~20% | File copiato nel worktree |
| Dev via `docker-compose up` | ~25% | Hook `on_create` lancia `docker-compose -p ws-N` |
| DB locale senza container | ~10% | Postgres schemas per workspace, o Neon branching esterno |
| Postgres shared esterno | ~5% | Non solve magicamente (problema pre-esistente in ogni team) |

### 5.2 Il pattern lifecycle hooks

Workspace **non risolve** DB isolation internamente. **Espone hook** che permettono all'utente di plugin la sua strategia:

```yaml
# .teepee/workspace.yaml
workspace:
  on_create:
    - docker-compose -p ${workspace.id} up -d
    - npm run db:migrate
    - npm run seed
  on_destroy:
    - docker-compose -p ${workspace.id} down -v
  env:
    DATABASE_URL: "postgres://localhost:${workspace.port_db}/${workspace.db_name}"
    REDIS_URL: "redis://localhost:${workspace.port_redis}"
    PORT: "${workspace.port_app}"
  port_allocation:
    port_app: auto
    port_db: auto
    port_redis: auto
```

Analogia architetturale: **Kubernetes PersistentVolume + StorageClass**. K8s definisce il contratto, cloud/local driver plugano la soluzione.

### 5.3 Cosa resta doloroso

Il 5% di progetti con Postgres condiviso senza docker-compose e senza branching DB esterno. Per questi workspace non dà valore extra: **ma è lo stesso dolore che hanno già oggi su git branches**. Non peggiora, solo non migliora.

### 5.4 Test isolation

Per test suite moderni ben scritti (random port, DB isolato, mock per esterni): **isolamento ~100%**. Per legacy con hardcoded port e shared DB: parziale. Workspace fornisce l'infrastruttura corretta (TMPDIR per-ws, env vars, service ports), non aggiusta test scritti male.

---

## 6. I 15 problemi operativi da affrontare

Dall'analisi durante la sessione. Nessuno è un deal-breaker, ma ciascuno va risolto esplicitamente in implementazione.

1. **Lifecycle worktree**: quando creo (da che branch base)? Quando distruggo (merge / abandon)?
2. **Branch namespace collision**: due istanze Teepee sullo stesso repo condividono branch name space — richiede prefisso univoco per istanza
3. **node_modules explosion**: 10 workspace × 500MB = 5GB. Opzioni: copia completa, symlink (rompe Vite/webpack), pnpm (forza tool upstream)
4. **Stato non committato a fine job**: auto-commit? Lascio dirty? Squash strategy?
5. **Git ops esterne dell'utente**: `git worktree prune` manuale distrugge stato Teepee
6. **Cambi cross-topic su stesso file**: workspace A modifica README, B legge README — non si vedono finché non si mergia
7. **Merge conflicts**: chi risolve? Utente via UI? Via `git merge` manuale?
8. **Filesystem references (`teepee://workspace/...`)**: single-rooted oggi → dopo workspace lo stesso file esiste a N path
9. **Backup / migrazione**: path assoluti nel worktree cambiano se si sposta Teepee
10. **Permission crossover**: readonly può shared read-only mount, readwrite no
11. **Agent context staleness**: round 1 fa `rg --files`, utente mergia main, round 2 parte stantio
12. **Tooling assumptions**: pre-commit hooks, build cache, tool che assumono layout repo
13. **Observability**: UI per diff ws-branch..main, stato dirty, merge status
14. **Concorrenza intra-workspace**: come serializzare writer di due job simultanei nello stesso ws?
15. **Non-git projects**: cosa succede se il progetto non è un repo git?

---

## 7. Touch points di codice

Dall'exploration (`packages/core/src/orchestrator.ts`, ecc.), 8 punti portanti da refactorare:

| # | File | Cosa | Cambio |
|---|------|------|--------|
| 1 | `packages/server/src/index.ts:56` | `basePath` computato una volta | Diventa workspace resolver |
| 2 | `packages/core/src/orchestrator.ts:114` | `this.basePath` immutabile | Diventa per-topic lookup |
| 3 | `packages/core/src/orchestrator.ts:543` | `projectRoot` hardcoded in SandboxOptions | Parametrizzato per job |
| 4 | `packages/core/src/sandbox/linux-bwrap.ts:79` | Mount hardcoded | Parametrizzato |
| 5 | `packages/core/src/sandbox/container-runner.ts:83` | Come sopra | Come sopra |
| 6 | `packages/core/src/executor.ts:838` | `cwd: this.basePath` | `cwd: resolveWorkspacePath(topicId)` |
| 7 | `packages/core/src/references.ts:280` | URI resolution single-root | Workspace-scoped URI |
| 8 | `packages/server/src/http/api-routes.ts:506` | API project ritorna single `path` | Lista workspace + default |

---

## 8. Implementation plan (stimata quando sbloccata)

### Stage 1 — Design docs + schema DB (2-3 settimane)
Workspace table, topic.workspace_id, port allocation, lifecycle hooks schema.

### Stage 2 — Core: workspace resolver (3-4 settimane)
Refactor di basePath → workspace lookup per job. Tutti i 8 touch point.

### Stage 3 — Lifecycle (2-3 settimane)
Git worktree create/destroy, branch management, hook execution.

### Stage 4 — Environment isolation (1-2 settimane)
Port allocation, env var injection, hook runner.

### Stage 5 — UI (3-4 settimane)
Fork/merge buttons, workspace indicator per topic, stato dirty, diff viewer minimo.

### Stage 6 — Testing + edge cases (3-4 settimane)
I 15 problemi operativi di § 6, ciascuno con test case e handling esplicito.

**Totale**: 14-20 settimane (3.5-5 mesi) lavoro serio single-engineer.

---

## 9. Alternatives considerate

### 9.1 Worktree per topic (ogni topic, qualsiasi livello)
**Rifiutata**: worktree proliferation, il 90% dei topic non modifica codice. Overhead per nulla.

### 9.2 Worktree per root topic
**Rifiutata**: non risolve il problema, lo sposta di un livello (figli dello stesso root collidono).

### 9.3 Worktree per topic-foglia
**Rifiutata**: "foglia" non è stabile. Aggiungi un figlio e smette di essere foglia.

### 9.4 Copy-on-write filesystem (overlayfs Linux, APFS snapshot macOS)
**Rifiutata come primaria**: platform-specific, merge semantics complesse. Possibile come ottimizzazione futura se worktree troppo lento.

### 9.5 Nessun isolamento, solo writer lock globale migliorato
**Rifiutata per eventual pivot**: non dà true parallel work, solo meno collisioni.

### 9.6 Worktree per-job (non per-topic)
**Rifiutata**: churn enorme, merge ad ogni fine job, semantica confusa.

### 9.7 Workspace come first-class (questa RFC)
**Scelta**: composable, matcha mental model git dev, il 90% dei topic non paga overhead.

---

## 10. Alternative incrementali (da valutare se workspace viene rimandato)

Se post-M1 si decide di *non* implementare workspace ma serve comunque migliorare la concorrenza:

### 10.1 Topic-level writer lock (1 settimana)
Sostituire il chain-wide lock con per-topic. Topic diversi possono avere writer concorrenti (ma race su stesso filesystem). Pragmatico, parziale.

### 10.2 Per-job ephemeral dir + review UI (2-3 settimane)
Agenti scrivono in `$TEEPEE_OUTPUT_DIR` esteso, Teepee mostra diff per applicazione manuale. Evita race al costo di un click.

Queste sono mitigazioni, non soluzioni. Restano valide come fallback se workspace resta parked a lungo.

---

## 11. Non-goals esplicitati

- Non competiamo con Codespaces, Gitpod, dev containers sul territorio dev-environment-as-a-service
- Non risolviamo la gestione DB (solo hook)
- Non forniamo merge UI avanzata (delegato a git o GitHub PR)
- Non facciamo real-time co-editing
- Non astraiamo git dietro a interfaccia proprietaria: l'utente vede branch normali

---

## 12. Criteri di unpark

Implementare workspace solo se **tutti e quattro** i seguenti sono veri:

1. **M1 validato** — i criteri go/no-go del memo (`docs/memo-soci-v1.md`) sono verificati (3 progetti OSS esterni adottano + 1 proposta ciascuno)
2. **Pivot code-coordination deciso** — scelta esplicita di estendere Teepee oltre documentazione verso coordinamento di lavoro di codice
3. **Almeno un early adopter ha esplicitamente lamentato** il limite di concorrenza su codebase condivisa
4. **3.5-5 mesi di engineering time disponibili** — budget reale, non wishful thinking

Se anche *uno* di questi manca, workspace resta parked. Non "rimandato di 3 mesi". Parked.

---

## 13. Rischi di implementazione

- **Tempo reale più di 4 mesi**: i 15 problemi operativi tendono a esplodere in edge case. Buffer realistico +50% sulla stima.
- **Operational burden post-release**: worktree corruption, branch pollution, utenti che fanno operazioni git fuori da Teepee e rompono lo stato. Support costante richiesto.
- **Resource cost per utente**: ogni workspace attivo = directory + node_modules + branch. Su laptop dev medi, limite pratico ~20 workspace attivi simultanei.
- **Hook di lifecycle falliti**: se `docker-compose up` fallisce all'on_create, il workspace è in stato mezzo-creato. Serve rollback robusto.
- **Il feature può essere visto dall'utente come "over-engineering"**: se un early adopter si aspetta "apri Teepee, modifica, committa", l'aggiunta del concetto di workspace diventa cognitive load. Serve UI che lo nasconda bene quando non serve.

---

## 14. Open questions (da decidere quando si sblocca)

1. Nomenclatura branch: `teepee/ws-<id>` numerico o `teepee/<topic-slug>` leggibile?
2. Default "fork at topic creation": mai (solo opt-in manuale), smart (solo se agente richiede scrittura), sempre?
3. Cleanup policy: worktree abbandonati per N giorni vengono rimossi automaticamente?
4. Integration con GitHub PR: Teepee può auto-aprire PR al merge del workspace, o solo spingere la branch?
5. Gestione di `.gitignore` aggiuntivo per workspace (es. escludere `.teepee-workspace-state`)?
6. Migrazione da installazioni esistenti: come si "ricategorizza" basePath come workspace default?

---

## 15. Riferimenti

- Memo strategico: `docs/memo-soci-v1.md` (§ 11 include workspace come rischio architetturale esplicitato)
- RFC indipendenti e precedenti: `rfc-fs-explorer.md` (fs explorer resta valido con o senza workspace)
- Codice touch points: `packages/core/src/orchestrator.ts`, `packages/core/src/sandbox/*`, `packages/core/src/references.ts`

---

## 16. Decisioni cristallizzate da questa sessione (per memoria)

Durante l'analisi strategica 2026-04-18 sono state prese queste decisioni che un futuro implementatore deve conoscere:

1. **Non è "worktree per topic"**. È "workspace come concetto separato, topic vi si attacca o eredita dal parent".
2. **Non risolviamo DB isolation magicamente**. Lifecycle hooks + env vars + template per stack comuni.
3. **Writer lock per-workspace, non per-topic**. Due topic nello stesso workspace condividono il lock.
4. **Parallel vero = workspace diversi**. Pair-programming-like = stesso workspace. Entrambi legittimi, scelta esplicita.
5. **Real-time co-editing è fuori scope**. Non è Live Share, non è Google Docs.
6. **Non-git projects**: fallback a `git init` forzato, o opt-out con messaggio esplicito. Da decidere all'implementazione.
