# Candidate & Needs Manager Locale

App locale per gestire need e candidati usando PostgreSQL come archivio principale.

## Avvio

Da PowerShell, nella cartella del progetto:

```powershell
.\start-local.ps1
```

Poi apri:

```text
http://localhost:5173
```

## PostgreSQL

PostgreSQL e' il backend predefinito. Nel file `.env` puoi impostare:

```text
DATA_BACKEND=postgres
DATABASE_URL=postgres://postgres:admin@localhost:5432/needs_manager
```

Se `DATA_BACKEND` non e' presente, l'app usa comunque PostgreSQL. Usa `DATA_BACKEND=csv` solo per test o recuperi temporanei.

Lo schema e' in `db/schema.sql`. Il server crea le tabelle mancanti automaticamente all'avvio.

Per preparare un nuovo database Render:

```powershell
npm run setup:render-db
```

Se il database Render e' gia popolato e devi solo aggiungere la tabella per i CV:

```powershell
npm run update:render-db-cv
```

Per prepararlo e importare anche i CSV iniziali:

```powershell
npm run setup:render-db -- --import-csv
```

## Import CSV in PostgreSQL

I CSV possono essere usati per popolare PostgreSQL. Modifica `.env` per puntare ai CSV reali:

```text
NEEDS_CSV_PATH=C:\Users\cesco\OneDrive - AURA Technologies srl\...\NeedsManager_Needs.csv
CANDIDATES_CSV_PATH=C:\Users\cesco\OneDrive - AURA Technologies srl\...\NeedsManager_Candidates.csv
APPLICATIONS_CSV_PATH=C:\Users\cesco\OneDrive - AURA Technologies srl\...\NeedsManager_Applications.csv
```

`NeedsManager_Applications.csv` contiene le associazioni candidato-need. Questo permette di proporre lo stesso candidato su piu need senza sovrascrivere il dato nel CSV candidati.

Per importare i CSV correnti nel database:

```powershell
$env:DATA_BACKEND="postgres"
$env:DATABASE_URL="postgres://postgres:admin@localhost:5432/needs_manager"
C:\Users\cesco\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe .\migrate-to-postgres.mjs --truncate
```

## Export PostgreSQL

Per esportare il database PostgreSQL in file leggibili:

```powershell
$env:DATABASE_URL="postgres://postgres:admin@localhost:5432/needs_manager"
C:\Users\cesco\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe .\export-postgres-db.mjs
```

Lo script crea una nuova cartella sotto `exports` con:

- `needs.csv`
- `candidates.csv`
- `applications.csv`
- `database.json`

## Import Excel o CSV

Dalla barra in alto puoi importare need e candidati da file `.xlsx` o `.csv`.
L'import usa la prima tabella del file e non crea duplicati:

- i need gia presenti vengono riconosciuti dal titolo
- i candidati gia presenti vengono riconosciuti dal nome o dall'email

## CV e allegati candidati

Nel form candidato puoi caricare uno o piu file CV/allegati. I file vengono salvati nella cartella configurata con `UPLOADS_DIR` (`uploads` in locale), mentre PostgreSQL conserva i metadati nella tabella `candidate_files`.
Nel riepilogo del candidato compare la sezione `CV` con link per scaricare i file caricati.

Su Render imposta `UPLOADS_DIR` su un Persistent Disk, per esempio `/var/data/uploads`, altrimenti i file possono sparire dopo deploy o riavvii.

## Notifiche mail

Quando viene creato un nuovo candidato o un nuovo need, l'app puo inviare una mail a uno o piu contatti configurati in `.env`.
Se i destinatari non sono configurati, il salvataggio funziona normalmente senza inviare mail.

Esempio:

```text
NOTIFICATION_TO=hr@azienda.it,manager@azienda.it
NOTIFICATION_FROM=needs-manager@azienda.it
SMTP_HOST=smtp.azienda.it
SMTP_TLS_SERVERNAME=smtp.azienda.it
SMTP_PORT=587
SMTP_SECURE=false
SMTP_STARTTLS=true
SMTP_USER=needs-manager@azienda.it
SMTP_PASS=password-o-app-password
```

Per piu destinatari usa virgole o punti e virgola.

Se il server SMTP risponde con un certificato intestato a un nome diverso dall'host di connessione, lascia `SMTP_HOST` sull'host raggiungibile e imposta `SMTP_TLS_SERVERNAME` con il nome indicato dal certificato.

Per verificare se l'invio funziona senza creare un candidato o un need:

```powershell
C:\Users\cesco\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe .\test-email.mjs
```

Se la configurazione e' corretta, nel terminale compare `Mail di test inviata...` e i destinatari ricevono una mail di prova. Se qualcosa non va, lo script mostra l'errore SMTP.

## Avvio alternativo

`start-local.cmd` avvia l'app sulla porta `5173`. `start-postgres.cmd` avvia l'app sulla porta `5200`.

## Deploy web

Per mettere online l'app usa un servizio Node.js con PostgreSQL gestito. Le istruzioni generiche sono in `DEPLOYMENT.md`.
