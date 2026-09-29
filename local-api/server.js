import express from 'express'
import { readFileSync } from 'node:fs'
import multer from 'multer'
import pg from 'pg'

const { Pool } = pg
const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
const pool = new Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'tnbcheck',
  user: process.env.PGUSER ?? 'tnbcheck',
  password: process.env.PGPASSWORD ?? 'local-dev-password',
  ssl: process.env.PGSSL_CA_FILE
    ? { ca: readFileSync(process.env.PGSSL_CA_FILE, 'utf8'), rejectUnauthorized: true }
    : undefined,
})

app.use(express.json({ limit: '100kb' }))

app.get('/healthz', async (_request, response) => {
  try {
    await pool.query('SELECT 1')
    response.json({ status: 'ok' })
  } catch {
    response.status(503).json({ status: 'database unavailable' })
  }
})

app.get('/readings', async (_request, response) => {
  try {
    const result = await pool.query(`
      SELECT id, meter_id, reading_kwh, recorded_at, previous_reading
      FROM (
        SELECT id, meter_id, reading_kwh, recorded_at,
          LAG(reading_kwh) OVER (PARTITION BY meter_id ORDER BY recorded_at, id) AS previous_reading
        FROM meter_readings
      ) AS ordered_readings
      WHERE meter_id = $1
      ORDER BY recorded_at DESC, id DESC
      LIMIT 500
    `, ['main'])
    response.json({ readings: result.rows.map((row) => {
      const readingKwh = Number(row.reading_kwh)
      const previousReading = row.previous_reading === null ? null : Number(row.previous_reading)
      return {
        id: row.id,
        readingKwh,
        previousReading,
        usageSincePrevious: previousReading === null ? null : readingKwh - previousReading,
        recordedAt: row.recorded_at,
      }
    }) })
  } catch (error) {
    console.error('Loading meter readings failed:', error)
    response.status(500).json({ error: 'Gagal memuat sejarah bacaan meter.' })
  }
})

app.get('/readings/latest', async (_request, response) => {
  try {
    const result = await pool.query(
      'SELECT reading_kwh, recorded_at FROM meter_readings WHERE meter_id = $1 ORDER BY recorded_at DESC, id DESC LIMIT 1',
      ['main'],
    )
    const latest = result.rows[0]
    response.json({
      readingKwh: latest ? Number(latest.reading_kwh) : null,
      recordedAt: latest?.recorded_at ?? null,
    })
  } catch (error) {
    console.error('Loading latest meter reading failed:', error)
    response.status(500).json({ error: 'Gagal memuat bacaan meter terakhir.' })
  }
})

app.put('/readings/:id', async (request, response) => {
  const id = Number(request.params.id)
  const meterReading = Number(request.body?.meterReading)
  const recordedAt = new Date(request.body?.recordedAt)
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(meterReading) || meterReading < 0 || !Number.isFinite(recordedAt.getTime())) {
    return response.status(400).json({ error: 'Bacaan dan tarikh/masa tidak sah.' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tnbcheck:main-meter'))")
    const updated = await client.query(
      'UPDATE meter_readings SET reading_kwh = $1, recorded_at = $2 WHERE id = $3 AND meter_id = $4 RETURNING id',
      [meterReading, recordedAt.toISOString(), id, 'main'],
    )
    if (!updated.rowCount) {
      await client.query('ROLLBACK')
      return response.status(404).json({ error: 'Rekod bacaan tidak dijumpai.' })
    }

    const invalidOrder = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM (
          SELECT reading_kwh,
            LAG(reading_kwh) OVER (ORDER BY recorded_at, id) AS previous_reading
          FROM meter_readings
          WHERE meter_id = $1
        ) AS ordered_readings
        WHERE previous_reading IS NOT NULL AND reading_kwh < previous_reading
      ) AS invalid
    `, ['main'])
    if (invalidOrder.rows[0].invalid) {
      await client.query('ROLLBACK')
      return response.status(422).json({ error: 'Edit ini menjadikan bacaan menurun mengikut masa. Semak masa atau nilai bacaan.' })
    }

    await client.query('COMMIT')
    response.json({ saved: true })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Updating meter reading failed:', error)
    response.status(500).json({ error: 'Gagal mengemas kini bacaan meter.' })
  } finally {
    client.release()
  }
})

app.delete('/readings/:id', async (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) {
    return response.status(400).json({ error: 'ID bacaan tidak sah.' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tnbcheck:main-meter'))")
    const deleted = await client.query(
      'DELETE FROM meter_readings WHERE id = $1 AND meter_id = $2 RETURNING id',
      [id, 'main'],
    )
    if (!deleted.rowCount) {
      await client.query('ROLLBACK')
      return response.status(404).json({ error: 'Rekod bacaan tidak dijumpai.' })
    }
    await client.query('COMMIT')
    response.json({ deleted: true })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Deleting meter reading failed:', error)
    response.status(500).json({ error: 'Gagal memadam bacaan meter.' })
  } finally {
    client.release()
  }
})

app.post('/ocr', upload.single('image'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Sila hantar fail imej dalam field image.' })
  if (!request.file.mimetype.startsWith('image/')) {
    return response.status(400).json({ error: 'Fail yang dihantar mestilah imej.' })
  }
  if (!process.env.GOOGLE_AI_STUDIO_API_KEY) {
    return response.status(503).json({ error: 'GOOGLE_AI_STUDIO_API_KEY belum ditetapkan dalam .env.' })
  }

  try {
    const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GOOGLE_AI_STUDIO_API_KEY,
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: 'Read the cumulative electricity energy reading shown on this physical electricity meter display. Return only a JSON object with meterReading as a number in kWh and rawText as a string. Read the displayed register value, not the meter serial number, voltage, current, date, or tariff. Preserve decimal digits. If the display is unclear or no cumulative kWh reading is visible, return meterReading as null. Do not guess.',
              },
              {
                inlineData: {
                  mimeType: request.file.mimetype,
                  data: request.file.buffer.toString('base64'),
                },
              },
            ],
          }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(60_000),
      },
    )

    const result = await geminiResponse.json()
    if (!geminiResponse.ok) {
      console.error('Gemini request failed:', result.error?.message ?? geminiResponse.statusText)
      return response.status(502).json({ error: 'Google Gemini tidak dapat membaca imej. Semak API key dan cuba lagi.' })
    }

    const rawResult = result.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim()
    if (!rawResult) throw new Error('Gemini returned no bill data')

    const parsed = JSON.parse(rawResult.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    const meterReading = Number(parsed.meterReading)
    if (parsed.meterReading == null || !Number.isFinite(meterReading) || meterReading < 0) {
      return response.status(422).json({ error: 'Bacaan kWh tidak dapat dikenal pasti. Cuba gambar yang lebih jelas.' })
    }

    const previous = await pool.query(
      'SELECT reading_kwh, recorded_at FROM meter_readings WHERE meter_id = $1 ORDER BY recorded_at DESC, id DESC LIMIT 1',
      ['main'],
    )
    const previousReading = previous.rows[0] ? Number(previous.rows[0].reading_kwh) : null
    response.json({
      meterReading,
      previousReading,
      usageSincePrevious: previousReading === null ? null : meterReading - previousReading,
      previewAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Gemini image processing failed:', error)
    response.status(502).json({ error: 'Gagal membaca imej dengan Google Gemini. Pastikan gambar jelas dan cuba lagi.' })
  }
})

app.post('/confirm', async (request, response) => {
  const meterReading = Number(request.body?.meterReading)
  if (!Number.isFinite(meterReading) || meterReading < 0) {
    return response.status(400).json({ error: 'Bacaan meter mesti nombor sifar atau lebih.' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tnbcheck:main-meter'))")
    const previous = await client.query(
      'SELECT reading_kwh FROM meter_readings WHERE meter_id = $1 ORDER BY recorded_at DESC, id DESC LIMIT 1',
      ['main'],
    )
    const previousReading = previous.rows[0] ? Number(previous.rows[0].reading_kwh) : null
    if (previousReading !== null && meterReading < previousReading) {
      await client.query('ROLLBACK')
      return response.status(422).json({ error: 'Bacaan baru lebih rendah daripada bacaan lepas. Semak nombor yang dibaca.' })
    }

    const result = await client.query(
      `INSERT INTO meter_readings (meter_id, reading_kwh)
       VALUES ($1, $2)
       RETURNING id, reading_kwh, recorded_at`,
      ['main', meterReading],
    )
    await client.query('COMMIT')
    response.status(201).json({
      saved: true,
      ...result.rows[0],
      reading_kwh: Number(result.rows[0].reading_kwh),
      previousReading,
      usageSincePrevious: previousReading === null ? null : meterReading - previousReading,
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Saving bill failed:', error)
    response.status(500).json({ error: 'Gagal menyimpan bacaan meter ke database.' })
  } finally {
    client.release()
  }
})

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meter_readings (
      id BIGSERIAL PRIMARY KEY,
      meter_id TEXT NOT NULL DEFAULT 'main',
      reading_kwh NUMERIC(14, 3) NOT NULL CHECK (reading_kwh >= 0),
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0', () => console.log('Local OCR API listening'))
}

start().catch((error) => {
  console.error('Could not start local OCR API:', error)
  process.exit(1)
})
