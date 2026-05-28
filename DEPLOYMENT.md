# Deploy Web

L'app puo girare come singolo servizio Node.js che serve sia frontend statico sia API.

## Variabili ambiente

Impostare sul provider:

```text
NODE_ENV=production
DATA_BACKEND=postgres
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DB_NAME
PORT=<fornita dal provider>
ALLOWED_ORIGIN=*
UPLOADS_DIR=/var/data/uploads
```

`ALLOWED_ORIGIN=*` va bene se frontend e backend sono lo stesso servizio. Se separi frontend e backend, imposta il dominio frontend.

## Comandi

Build command:

```text
nessuno
```

Start command:

```text
npm start
```

Health check:

```text
/health
```

## Database

Il server crea automaticamente le tabelle mancanti usando lo schema equivalente a `db/schema.sql`.

## File CV su Render

Per i CV/allegati serve un Persistent Disk Render. Configura il disco, ad esempio:

```text
Mount path: /var/data
UPLOADS_DIR=/var/data/uploads
```

Se `UPLOADS_DIR` non punta a un Persistent Disk, i file caricati possono sparire dopo deploy/riavvii e il download mostrera "File non trovato".

Per preparare un nuovo database PostgreSQL su Render dalla shell del servizio:

```text
npm run setup:render-db
```

Se il database Render esiste gia e devi solo aggiungere la funzionalita CV:

```text
npm run update:render-db-cv
```

Se vuoi anche importare i CSV iniziali:

```text
npm run setup:render-db -- --import-csv
```

Se vuoi svuotare e ricaricare tutto dai CSV:

```text
npm run setup:render-db -- --import-csv --truncate
```

Per importare i dati iniziali dai CSV prima del deploy o da una shell del provider:

```text
npm run migrate:postgres -- --truncate
```

Usare `--truncate` solo quando si vuole sostituire il contenuto del database con quello dei CSV.

## Locale

Gli script Windows restano disponibili:

```powershell
.\start-local.cmd
.\start-postgres.cmd
```

In locale puoi usare `.env`. In produzione usa le variabili ambiente del provider.
