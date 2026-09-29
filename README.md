# TNB Check

Local app untuk membaca paparan meter menggunakan Google Gemini, menyemak bacaan kWh dan membandingkannya dengan rekod sebelumnya sebelum simpan ke PostgreSQL.

## Jalankan dengan Docker Compose

1. Salin `.env.example` sebagai `.env`.
2. Masukkan Google AI Studio API key pada `GOOGLE_AI_STUDIO_API_KEY` dalam `.env`. Key digunakan oleh servis backend sahaja, bukan dihantar ke browser.
3. Jalankan `docker compose up --build`.
4. Buka app di http://localhost:5173 dan n8n di http://localhost:5678.

Selepas mula kali pertama, buka n8n dan lengkapkan setup akaun di http://localhost:5678. Import workflow secara automatik; buka setiap workflow dan aktifkan dari editor n8n. Workflow scan menghantar imej meter kepada Gemini; workflow confirm menyimpan bacaan yang pengguna sahkan sahaja. n8n standalone mengimport workflow dalam keadaan tidak aktif.

Halaman Sejarah memaparkan bacaan, beza kWh dan anggaran tenaga menggunakan blok Tarif A yang ditetapkan dalam app: 200 kWh pertama pada RM0.218/kWh, 100 seterusnya pada RM0.334/kWh, kemudian blok 300 kWh pada RM0.516 dan RM0.546/kWh. Anggaran menganggap sela antara dua bacaan sebagai satu kitaran tarif; ia bukan jumlah bil rasmi dan penggunaan melebihi 900 kWh ditunjukkan sebagai belum berkadar.

Setiap rekod sejarah boleh diedit (bacaan dan masa) atau dipadam selepas pengesahan. App menolak edit yang menjadikan bacaan menurun mengikut turutan masa; bacaan sebelumnya, penggunaan dan anggaran akan dikira semula daripada sejarah.

## Konfigurasi

Semua nilai khusus deployment hidup dalam `.env` (tidak di-track). `.env.example` menyenaraikan kesemuanya. Yang paling mudah terlepas pandang:

| Pemboleh ubah | Di mana | Fungsi |
|---|---|---|
| `N8N_UPSTREAM` | container `app` | `<host>:<port>` instance n8n yang boleh dicapai oleh app, untuk laluan webhook |
| `TNBCHECK_API_BASE` | container **n8n** | sebaliknya: alamat `local-api` yang boleh dicapai oleh n8n |
| `APP_BASE_PATH` | build + runtime | subpath app disajikan, contoh `/tnbcheck` |
| `APP_PORT`, `LOCAL_API_PORT` | container | port hos yang diterbitkan |

Kedua-dua arah mesti diset, kerana app dan n8n biasanya berada atas docker network yang berbeza dan **nama container tidak resolve merentas network**. Guna alamat hos untuk kedua-duanya.

Workflow n8n membaca `TNBCHECK_API_BASE` melalui ekspresi `{{ $env.TNBCHECK_API_BASE }}`, jadi alamat sebenar tidak disimpan dalam fail workflow dan repo ini tidak perlu membawa alamat sesiapa.

## Guna Aiven untuk rekod bil

Secara default, rekod bil dan n8n menggunakan PostgreSQL local. Untuk guna Aiven bagi rekod bil sahaja, isi `BILL_DB_HOST`, `BILL_DB_PORT`, `BILL_DB_NAME`, `BILL_DB_USER`, dan `BILL_DB_PASSWORD` dalam `.env` daripada connection information Aiven.

Muat turun CA certificate Aiven ke `certs/ca.pem`, kemudian set `BILL_DB_SSL_CA_FILE=/certs/ca.pem`. Backend mengesahkan certificate TLS. Restart dengan `docker compose up --build -d`. n8n kekal menggunakan PostgreSQL local.

Role Aiven yang digunakan app perlu hak `USAGE` dan `CREATE` pada schema `public` supaya backend boleh menyediakan jadual bacaan. Jalankan sekali dalam SQL console Aiven sebagai admin, gantikan nama role dengan nilai `BILL_DB_USER`:

```sql
GRANT USAGE, CREATE ON SCHEMA public TO nama_role_app;
```

## Deploy production

Production guna `docker-compose.prod.yml`, bukan `docker-compose.yml`. Bezanya:

- `app` guna `Dockerfile.prod` — asset static yang sudah di-`npm run build`, disajikan oleh nginx. Bukan Vite dev server.
- **Tiada servis n8n di sini.** Stack ini guna instance n8n sedia ada; tetapkan `N8N_UPSTREAM` kepadanya.
- `app` dan `local-api` diterbitkan pada port hos dan menyertai docker network luaran `edge` supaya reverse proxy atas hos yang sama boleh mencapainya.

### Kenapa port hos, bukan nama container

Sesetengah reverse proxy (contohnya Nginx Proxy Manager) menjana `proxy_pass http://<nama-container>:<port>;` dengan hostname **literal**. nginx resolve nama itu **sekali sahaja** semasa config dimuatkan, kemudian simpan IP tersebut. Sebaik sahaja deploy recreate container dengan IP baru, proxy akan cuba IP lama dan pulangkan 502 (`No route to host`) sehingga nginx di-reload.

Port hos kekal stabil merentas redeploy, jadi proxy tak pernah perlu reload. Ini juga sebabnya workflow n8n memanggil alamat hos dan bukan `http://local-api:3001` — n8n sedia ada berada atas network docker sendiri, jadi nama container stack ini tak resolve di situ. Pastikan port yang dipilih bebas; semak dengan `ss -tln`.

App disajikan di bawah subpath (contoh `https://apps.example.com/tnbcheck`). Ini memerlukan `APP_BASE_PATH=/tnbcheck` semasa build; tanpanya asset akan diminta dari root domain dan 404. Routing API (`<base>/api/n8n/` dan `<base>/api/meter/`) dibuat oleh nginx dalam container app sendiri, jadi reverse proxy cuma perlu **satu** custom location setiap app.

### Setup sekali sahaja atas server

```bash
git clone https://github.com/amiramirul/tnbcheck.git ~/tnbcheck
cd ~/tnbcheck
cp .env.example .env                              # rujuk nota di bawah
docker network create edge                        # jika belum ada
docker network connect edge nginx-proxy-manager   # jika belum ada
```

**Jangan salin `.env.example` atas `.env` yang sudah berjalan.** `POSTGRES_PASSWORD` mesti kekal sama seperti semasa Postgres pertama kali diinisialisasi; menukarnya menyebabkan Postgres menolak sambungan, walaupun data dalam volume masih elok. Isi `GOOGLE_AI_STUDIO_API_KEY` dan nilai Aiven dengan **menyunting** fail itu, bukan dengan menimpanya.

### Deploy

Otomatik: push ke `main` mencetuskan `.github/workflows/deploy.yml` atas self-hosted runner. Pull request menjalankan lint dan build sahaja, tanpa deploy. Workflow deploy menarik ke dalam clone stabil di direktori `DEPLOY_DIR` (bukan direktori `_work` runner), supaya `.env` yang tidak di-track tidak dipadam oleh `git clean`. Tetapkan `DEPLOY_DIR` sebagai repository variable; lalai ialah `/srv/tnbcheck`.

Manual:

```bash
cd ~/tnbcheck
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

### Workflow n8n

Kedua-dua workflow (`n8n/workflows/*.json`) diimport ke dalam n8n sedia ada. Id workflow ada dalam fail JSON itu sendiri:

```bash
docker cp n8n/workflows/tnb-scan.json n8n:/tmp/tnb-scan.json
docker cp n8n/workflows/tnb-confirm.json n8n:/tmp/tnb-confirm.json
docker exec n8n n8n import:workflow --input=/tmp/tnb-scan.json
docker exec n8n n8n import:workflow --input=/tmp/tnb-confirm.json
# import sentiasa masuk sebagai TIDAK AKTIF — aktifkan, kemudian restart:
docker exec n8n n8n update:workflow --id=<id-dari-json> --active=true
docker restart n8n
```

`update:workflow` tidak berkuat kuasa sehingga n8n direstart. Frontend memanggil webhook melalui `<base>/api/n8n/webhook/tnb-check`, yang app nginx proksikan ke `N8N_UPSTREAM`.

`n8n` mesti mempunyai `TNBCHECK_API_BASE` dalam environment-nya sendiri — itu alamat yang workflow guna untuk memanggil `local-api`. Tanpanya, node HTTP dalam workflow gagal resolve.
