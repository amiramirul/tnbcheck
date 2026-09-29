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

## Guna Aiven untuk rekod bil

Secara default, rekod bil dan n8n menggunakan PostgreSQL local. Untuk guna Aiven bagi rekod bil sahaja, isi `BILL_DB_HOST`, `BILL_DB_PORT`, `BILL_DB_NAME`, `BILL_DB_USER`, dan `BILL_DB_PASSWORD` dalam `.env` daripada connection information Aiven.

Muat turun CA certificate Aiven ke `certs/ca.pem`, kemudian set `BILL_DB_SSL_CA_FILE=/certs/ca.pem`. Backend mengesahkan certificate TLS. Restart dengan `docker compose up --build -d`. n8n kekal menggunakan PostgreSQL local.

Role Aiven yang digunakan app perlu hak `USAGE` dan `CREATE` pada schema `public` supaya backend boleh menyediakan jadual bacaan. Jalankan sekali dalam SQL console Aiven sebagai admin, gantikan nama role dengan nilai `BILL_DB_USER`:

```sql
GRANT USAGE, CREATE ON SCHEMA public TO nama_role_app;
```

Untuk berhenti, jalankan `docker compose down`. Data PostgreSQL dan konfigurasi n8n kekal dalam Docker volumes. Untuk padam data local juga, jalankan `docker compose down -v`.
