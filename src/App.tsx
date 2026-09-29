import { useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import './App.css'

type Reading = {
  meterReading: number
  previousReading: number | null
  usageSincePrevious: number | null
  previewAt: string
  recordedAt: string
}

type HistoryReading = {
  id: number
  readingKwh: number
  previousReading: number | null
  usageSincePrevious: number | null
  recordedAt: string
}

type LatestReading = {
  readingKwh: number | null
  recordedAt: string | null
}

type ReadingEdit = {
  id: number
  readingKwh: string
  recordedAt: string
}

const emptyReading: Reading = {
  meterReading: 0,
  previousReading: null,
  usageSincePrevious: null,
  previewAt: '',
  recordedAt: '',
}

// BASE_URL always ends with '/', so API calls stay under the app's subpath
// (e.g. /tnbcheck/api/meter) instead of the domain root.
const baseUrl = import.meta.env.BASE_URL
const webhookUrl = import.meta.env.VITE_N8N_WEBHOOK_URL || `${baseUrl}api/n8n/webhook/tnb-check`
const meterApiUrl = `${baseUrl}api/meter`
const formatDateTime = (value: string) => new Intl.DateTimeFormat('ms-MY', {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(value))
const toDateTimeInput = (value: string) => {
  const date = new Date(value)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}
const tariffBlocks = [
  { limit: 200, rate: 0.218 },
  { limit: 100, rate: 0.334 },
  { limit: 300, rate: 0.516 },
  { limit: 300, rate: 0.546 },
]
const estimateCost = (usage: number | null) => {
  if (usage === null || usage < 0) return null
  let remaining = usage
  let cost = 0
  for (const block of tariffBlocks) {
    const blockUsage = Math.min(remaining, block.limit)
    cost += blockUsage * block.rate
    remaining -= blockUsage
    if (remaining <= 0) break
  }
  return { cost, unpricedUsage: remaining }
}
const formatEstimate = (usage: number | null) => {
  const estimate = estimateCost(usage)
  if (!estimate) return '—'
  const amount = `RM ${estimate.cost.toFixed(2)}`
  return estimate.unpricedUsage > 0
    ? `${amount} + ${estimate.unpricedUsage.toFixed(3)} kWh belum berkadar`
    : amount
}

function App() {
  const [image, setImage] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const [reading, setReading] = useState<Reading>(emptyReading)
  const [step, setStep] = useState<'capture' | 'review' | 'saved'>('capture')
  const [page, setPage] = useState<'capture' | 'history'>('capture')
  const [history, setHistory] = useState<HistoryReading[]>([])
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyNotice, setHistoryNotice] = useState('')
  const [historyEdit, setHistoryEdit] = useState<ReadingEdit | null>(null)
  const [historySaving, setHistorySaving] = useState(false)
  const [manualMode, setManualMode] = useState(false)
  const [manualValue, setManualValue] = useState('')
  const [latestReading, setLatestReading] = useState<LatestReading | null>(null)
  const [manualBusy, setManualBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const chooseImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setImage(file)
    setPreview(URL.createObjectURL(file))
    setError('')
  }

  const scanImage = async (event: FormEvent) => {
    event.preventDefault()
    if (!image) return
    setBusy(true)
    setError('')

    try {
      const formData = new FormData()
      formData.append('image', image)
      const response = await fetch(webhookUrl, { method: 'POST', body: formData })
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('application/json')) {
        throw new Error(`Webhook membalas bukan JSON (HTTP ${response.status}). Semak URL webhook dan pastikan workflow n8n aktif.`)
      }
      const result = await response.json()
      if (result.error) throw new Error(result.error)
      if (!response.ok) {
        throw new Error([result.error || result.message, result.hint].filter(Boolean).join(' ') || 'n8n tidak dapat membaca meter ini.')
      }
      setReading({ ...emptyReading, ...result.data, ...result })
      setStep('review')
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : 'Sesuatu tidak kena. Cuba lagi.')
    } finally {
      setBusy(false)
    }
  }

  const confirmReading = async () => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${meterApiUrl}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meterReading: reading.meterReading }),
      })
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('application/json')) {
        throw new Error(`API database membalas bukan JSON (HTTP ${response.status}). Cuba lagi atau semak sambungan database.`)
      }
      const result = await response.json()
      if (result.error) throw new Error(result.error)
      if (!response.ok) throw new Error(result.message || 'Bacaan belum berjaya disimpan.')
      setReading((current) => ({
        ...current,
        previousReading: result.previousReading,
        usageSincePrevious: result.usageSincePrevious,
        recordedAt: result.recorded_at,
      }))
      setStep('saved')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Sesuatu tidak kena. Cuba lagi.')
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    setImage(null)
    setPreview('')
    setReading(emptyReading)
    setStep('capture')
    setManualMode(false)
    setManualValue('')
    setError('')
  }

  const updateMeterReading = (value: string) => {
    const meterReading = Number(value)
    setReading((current) => ({
      ...current,
      meterReading,
      usageSincePrevious: current.previousReading === null ? null : meterReading - current.previousReading,
    }))
  }

  const openHistory = async () => {
    setPage('history')
    setHistoryBusy(true)
    setHistoryError('')
    setHistoryNotice('')
    try {
      const response = await fetch(`${meterApiUrl}/readings`)
      const result = await response.json()
      if (!response.ok || result.error) throw new Error(result.error || 'Gagal memuat sejarah bacaan.')
      setHistory(result.readings)
    } catch (loadError) {
      setHistoryError(loadError instanceof Error ? loadError.message : 'Gagal memuat sejarah bacaan.')
    } finally {
      setHistoryBusy(false)
    }
  }

  const beginHistoryEdit = (entry: HistoryReading) => {
    setHistoryEdit({
      id: entry.id,
      readingKwh: String(entry.readingKwh),
      recordedAt: toDateTimeInput(entry.recordedAt),
    })
    setHistoryError('')
    setHistoryNotice('')
  }

  const saveHistoryEdit = async (event: FormEvent) => {
    event.preventDefault()
    if (!historyEdit) return
    setHistorySaving(true)
    setHistoryError('')
    try {
      const response = await fetch(`${meterApiUrl}/readings/${historyEdit.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meterReading: Number(historyEdit.readingKwh),
          recordedAt: new Date(historyEdit.recordedAt).toISOString(),
        }),
      })
      const result = await response.json()
      if (!response.ok || result.error) throw new Error(result.error || 'Gagal mengemas kini bacaan.')
      setHistoryEdit(null)
      await openHistory()
      setHistoryNotice('Bacaan berjaya dikemas kini.')
    } catch (saveError) {
      setHistoryError(saveError instanceof Error ? saveError.message : 'Gagal mengemas kini bacaan.')
    } finally {
      setHistorySaving(false)
    }
  }

  const deleteHistoryReading = async (entry: HistoryReading) => {
    if (!window.confirm(`Betul nak padam bacaan ${entry.readingKwh.toFixed(3)} kWh pada ${formatDateTime(entry.recordedAt)}?`)) return
    setHistoryError('')
    setHistoryNotice('')
    try {
      const response = await fetch(`${meterApiUrl}/readings/${entry.id}`, { method: 'DELETE' })
      const result = await response.json()
      if (!response.ok || result.error) throw new Error(result.error || 'Gagal memadam bacaan.')
      if (historyEdit?.id === entry.id) setHistoryEdit(null)
      await openHistory()
      setHistoryNotice('Bacaan berjaya dipadam.')
    } catch (deleteError) {
      setHistoryError(deleteError instanceof Error ? deleteError.message : 'Gagal memadam bacaan.')
    }
  }

  const openManualEntry = async () => {
    setManualMode(true)
    setManualBusy(true)
    setError('')
    try {
      const response = await fetch(`${meterApiUrl}/readings/latest`)
      const result = await response.json()
      if (!response.ok || result.error) throw new Error(result.error || 'Gagal memuat bacaan terakhir.')
      setLatestReading(result)
      setManualValue('')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Gagal memuat bacaan terakhir.')
    } finally {
      setManualBusy(false)
    }
  }

  const reviewManualEntry = (event: FormEvent) => {
    event.preventDefault()
    const meterReading = Number(manualValue)
    if (!Number.isFinite(meterReading) || meterReading < 0) {
      setError('Masukkan bacaan meter sifar atau lebih.')
      return
    }
    const previousReading = latestReading?.readingKwh ?? null
    setReading({
      meterReading,
      previousReading,
      usageSincePrevious: previousReading === null ? null : meterReading - previousReading,
      previewAt: new Date().toISOString(),
      recordedAt: '',
    })
    setError('')
    setStep('review')
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">TC</div>
        <div><strong>TNB Check</strong><span>Rekod bacaan meter</span></div>
        <nav className="page-nav" aria-label="Halaman">
          <button className={page === 'capture' ? 'nav-button selected' : 'nav-button'} type="button" onClick={() => setPage('capture')}>Bacaan baru</button>
          <button className={page === 'history' ? 'nav-button selected' : 'nav-button'} type="button" onClick={openHistory}>Sejarah</button>
        </nav>
        <div className="secure-pill"><span className="pulse-dot" /> Data anda selamat</div>
      </header>

      {page === 'capture' ? <section className="content-wrap">
        <div className="intro">
          <p className="eyebrow">BACA & SAHKAN</p>
          <h1>Rekod bacaan meter<br /><em>elektrik anda.</em></h1>
          <p className="intro-copy">Ambil gambar paparan meter. Semak bacaan dan penggunaan sejak rekod sebelumnya sebelum disimpan.</p>
        </div>

        <div className="stepper" aria-label="Kemajuan semakan">
          <div className={step === 'capture' ? 'step active' : 'step done'}><b>1</b><span>Ambil gambar</span></div>
          <div className="step-line" />
          <div className={step === 'review' ? 'step active' : step === 'saved' ? 'step done' : 'step'}><b>2</b><span>Semak butiran</span></div>
          <div className="step-line" />
          <div className={step === 'saved' ? 'step active' : 'step'}><b>3</b><span>Selesai</span></div>
        </div>

        {step === 'capture' && !manualMode && <form className="capture-card" onSubmit={scanImage}>
          <div className={preview ? 'drop-zone has-image' : 'drop-zone'}>
            {preview ? <img src={preview} alt="Pratonton bil yang dipilih" /> : <>
              <div className="camera-icon">+</div>
              <strong>Ambil gambar paparan meter</strong>
              <span>Pastikan nombor bacaan kWh jelas kelihatan</span>
            </>}
            <input type="file" accept="image/*" capture="environment" onChange={chooseImage} aria-label="Pilih gambar bil TNB" />
          </div>
          <div className="card-footer">
            <span className="hint">JPG, PNG atau HEIC · maksimum 10MB</span>
            <div className="capture-actions"><button className="secondary-button" type="button" onClick={openManualEntry}>Masuk bacaan manual</button><button className="primary-button" type="submit" disabled={!image || busy}>{busy ? 'Sedang membaca...' : 'Baca meter  →'}</button></div>
          </div>
        </form>}

        {step === 'capture' && manualMode && <form className="manual-card" onSubmit={reviewManualEntry}>
          <div className="review-heading"><div><p className="eyebrow">INPUT MANUAL</p><h2>Masukkan bacaan meter</h2></div></div>
          {manualBusy ? <p className="review-note">Memuatkan bacaan terakhir...</p> : <>
            <p className="review-note">Bacaan terakhir disimpan sebagai rujukan; masukkan bacaan meter sekarang.</p>
            <div className="fields-grid">
              <label>Bacaan terakhir<input value={latestReading?.readingKwh === null || latestReading?.readingKwh === undefined ? 'Belum ada rekod' : `${latestReading.readingKwh.toFixed(3)} kWh`} readOnly /></label>
              <label>Masa bacaan terakhir<input value={latestReading?.recordedAt ? formatDateTime(latestReading.recordedAt) : '—'} readOnly /></label>
              <label className="full-field">Bacaan meter sekarang (kWh)<input autoFocus type="number" min="0" step="0.001" value={manualValue} onChange={(event) => setManualValue(event.target.value)} placeholder="Contoh: 1234.567" required /></label>
            </div>
          </>}
          {error && <p className="error-message">{error}</p>}
          <div className="review-actions"><button className="secondary-button" type="button" onClick={() => { setManualMode(false); setError('') }}>Kembali ke gambar</button><button className="primary-button" type="submit" disabled={manualBusy || !manualValue}>Semak bacaan  →</button></div>
        </form>}

        {step === 'review' && <section className="review-layout">
          <div className="image-panel"><img src={preview} alt="Paparan meter yang sedang disemak" /><button type="button" className="change-button" onClick={reset}>↻ Tukar gambar</button></div>
          <div className="details-panel">
            <div className="review-heading"><div><p className="eyebrow">SEMAKAN METER</p><h2>Betul ke bacaan ini?</h2></div></div>
            <p className="review-note">Masa rekod: {reading.previewAt ? formatDateTime(reading.previewAt) : 'Mengambil masa...'}</p>
            <div className="fields-grid">
              <label>Bacaan sebelumnya<input value={reading.previousReading === null ? 'Bacaan pertama' : `${reading.previousReading.toFixed(3)} kWh`} readOnly /></label>
              <label>Bacaan meter sekarang (kWh)<input type="number" min="0" step="0.001" value={reading.meterReading} onChange={(event) => updateMeterReading(event.target.value)} /></label>
              <div className="usage-summary full-field"><span>Penggunaan sejak rekod lepas</span><strong>{reading.usageSincePrevious === null ? 'Belum ada perbandingan' : `${reading.usageSincePrevious.toFixed(3)} kWh`}</strong></div>
            </div>
            {error && <p className="error-message">{error}</p>}
            <div className="review-actions"><button type="button" className="secondary-button" onClick={reset}>Semak gambar lain</button><button type="button" className="primary-button" onClick={confirmReading} disabled={busy || !Number.isFinite(reading.meterReading) || reading.meterReading < 0}>{busy ? 'Menyimpan...' : 'Ya, simpan bacaan  ✓'}</button></div>
          </div>
        </section>}

        {step === 'saved' && <section className="success-card"><div className="success-icon">✓</div><p className="eyebrow">DISIMPAN</p><h2>Bacaan meter direkod.</h2><p><strong>{reading.meterReading.toFixed(3)} kWh</strong>{reading.usageSincePrevious !== null && <> · penggunaan <strong>{reading.usageSincePrevious.toFixed(3)} kWh</strong></>}<br />{reading.recordedAt ? formatDateTime(reading.recordedAt) : ''}</p><button className="primary-button" type="button" onClick={reset}>Rekod bacaan seterusnya  →</button></section>}
        {error && step === 'capture' && <p className="error-message outside-error">{error}</p>}
      </section> : <section className="content-wrap history-page">
        <div className="history-heading">
          <div><p className="eyebrow">REKOD METER</p><h1>Sejarah bacaan<br /><em>dan penggunaan.</em></h1></div>
          <div className="tariff-list"><strong>Tarif A · domestik</strong><span>0–200 kWh: RM0.218/kWh</span><span>201–300 kWh: RM0.334/kWh</span><span>301–600 kWh: RM0.516/kWh</span><span>601–900 kWh: RM0.546/kWh</span></div>
        </div>
        <p className="history-note">Anggaran blok progresif untuk penggunaan antara dua bacaan, dengan andaian tempoh itu satu kitaran tarif. Caj lain tidak termasuk; penggunaan melebihi 900 kWh belum dikira.</p>
        {historyError && <p className="error-message">{historyError}</p>}
        {historyNotice && <p className="history-notice" role="status">{historyNotice}</p>}
        {historyEdit && <form className="history-edit" onSubmit={saveHistoryEdit}>
          <div className="history-edit-title"><p className="eyebrow">EDIT REKOD</p><h2>Kemaskini bacaan</h2></div>
          <label>Bacaan meter (kWh)<input type="number" min="0" step="0.001" required value={historyEdit.readingKwh} onChange={(event) => setHistoryEdit({ ...historyEdit, readingKwh: event.target.value })} /></label>
          <label>Tarikh dan masa<input type="datetime-local" required value={historyEdit.recordedAt} onChange={(event) => setHistoryEdit({ ...historyEdit, recordedAt: event.target.value })} /></label>
          <div className="history-edit-actions"><button className="secondary-button" type="button" onClick={() => setHistoryEdit(null)}>Batal</button><button className="primary-button" type="submit" disabled={historySaving}>{historySaving ? 'Menyimpan...' : 'Simpan perubahan'}</button></div>
        </form>}
        {historyBusy ? <p className="history-empty">Memuatkan bacaan...</p> : history.length === 0 ? <p className="history-empty">Belum ada bacaan direkodkan.</p> : <div className="history-table-wrap">
          <table className="history-table">
            <thead><tr><th>Masa rekod</th><th>Bacaan lepas</th><th>Bacaan meter</th><th>Penggunaan</th><th>Anggaran</th><th>Tindakan</th></tr></thead>
            <tbody>{history.map((entry) => <tr key={entry.id}>
              <td>{formatDateTime(entry.recordedAt)}</td>
              <td>{entry.previousReading === null ? 'Bacaan pertama' : `${entry.previousReading.toFixed(3)} kWh`}</td>
              <td>{entry.readingKwh.toFixed(3)} kWh</td>
              <td>{entry.usageSincePrevious === null ? '—' : `${entry.usageSincePrevious.toFixed(3)} kWh`}</td>
              <td>{formatEstimate(entry.usageSincePrevious)}</td>
              <td className="history-row-actions"><button type="button" className="table-action" onClick={() => beginHistoryEdit(entry)}>Edit</button><button type="button" className="table-action delete-action" onClick={() => deleteHistoryReading(entry)}>Padam</button></td>
            </tr>)}</tbody>
          </table>
        </div>}
      </section>}
      <footer><span>Powered by n8n workflow</span><span>Versi 1.0</span></footer>
    </main>
  )
}

export default App
