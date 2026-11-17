# Materials

Materials are files you prepare once and reuse: attach them to events and present them in calls.

## Supported files

| Upload | Saved as | Preview on `/materials/:id` | Can present in a call |
| --- | --- | --- | --- |
| Images (PNG, JPG, GIF, WebP) | `image`, or `slides` for several at once | The image(s), opens in the lightbox | Yes |
| PDF | `pdf` | Page images (rendered in the browser) | Yes |
| PowerPoint `.pptx` / `.ppt` | `pptx` | Slide images (LibreOffice on the server) | Yes |
| Word `.docx` / `.doc` | `doc` | The document's text, paragraph by paragraph | No (text preview only) |
| CSV, Excel `.xlsx` / `.xls` | `sheet` | First 50 rows × 20 columns of the first sheet | No (table preview only) |
| YouTube link | `youtube` | Embedded player | Yes |

Since this release, every uploaded file also keeps its **original** (`payload.sourceUrl`). The original is used for analysis
and the "Original" download button. Materials saved before this release have no original, so they can't be analysed.
Upload them again to analyse them.

Office previews are text and tables only. Word documents show no layout, images or formatting. Spreadsheets show values,
not formulas, and only the first sheet. `.doc`, `.xls` and `.ppt` need LibreOffice on the server, which the repo
Dockerfile already installs for PPTX slides.

## Pages

- `/materials`: the library. Upload (drag and drop works), save YouTube links, and open or remove materials.
- `/materials/:id`: one material, with its preview, the original download, and AI analysis.
- Create page: the **Materials** picker is a searchable dropdown with type icons. Tick materials to attach them, or
  use **Upload materials** inside it to upload and attach a file in one step.

## Who can see a material

- **Owner** and members of the owner's **organisation** (shared library) can view it, edit it and run analysis.
- **Anyone signed in** can view a material (read-only, including a stored analysis) once it's attached to a
  **public** event, or an event they host. The event page already lists those materials.
- Everyone else gets 404. Guests who aren't signed in get 401.

## AI analysis

`POST /api/materials/:id/analyse` (owner or organisation only):

1. The server reads the original from storage (local disk or R2/S3) and extracts text with no extra npm packages:
   - DOCX, PPTX and XLSX are read as zips of XML, using a minimal reader in `src/features/materials/extract.js`.
   - CSV is parsed with a quote-aware parser that detects `,`, `;` or tab delimiters.
   - PDF text comes from `pdftotext` (poppler-utils, already in the image).
   - `.doc`, `.xls` and `.ppt` are converted by LibreOffice first.
2. For spreadsheets, **column stats are computed locally** and are exact: row count, and per column the type,
   min/max/mean/sum, distinct values, the top values and empty cells. The model only comments on them.
3. A capped excerpt (`MATERIAL_ANALYSIS_MAX_CHARS`, default 12,000 characters) goes to Replicate:
   `POST https://api.replicate.com/v1/models/meta/meta-llama-3-70b-instruct/predictions` with
   `Authorization: Bearer $REPLICATE_API_TOKEN` and `Prefer: wait`. If the prediction is still running, the server polls
   it. The model is asked for JSON: `summary`, `keyPoints` and, for spreadsheets, `dataCommentary`.
4. The result is stored in `material_analyses`, keyed by the material and its original file. Opening the page again,
   or pressing Analyse again, returns the stored result and **costs nothing**. A new file means a new analysis.
5. **AI points:** a new analysis costs the `analysis` weight (default **2**) from the user's shared daily AI pool.
   Change it in `/admin` → AI weights, or with `AI_WEIGHT_ANALYSIS`. If the AI call fails, the points are refunded.

With `AI_MOCK=true` or no `REPLICATE_API_TOKEN`, a local heuristic result with the same shape is stored instead, and the
page says "Offline preview analysis".

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `REPLICATE_API_TOKEN` | (empty) | Already used for voice typing, covers and TTS. Analysis uses the same token. |
| `REPLICATE_MODEL` | `meta/meta-llama-3-70b-instruct` | The model used for analysis. Use `owner/name`, or `owner/name:version` for community models. |
| `MATERIAL_ANALYSIS_TIMEOUT_MS` | `90000` | The longest the server waits for one analysis. |
| `MATERIAL_ANALYSIS_MAX_CHARS` | `12000` | How much extracted text the model sees. |
| `AI_WEIGHT_ANALYSIS` | `2` | Points per analysis. `/admin` overrides it. |
| `UPLOAD_MAX_OTHER_MB` | `10` | Size limit for Word, Excel and CSV uploads. PDFs use `UPLOAD_MAX_PDF_MB` (20). |

## API

- `GET /api/materials/:id` returns the material and `canEdit`.
- `GET /api/materials/:id/preview` returns `{ text }` for documents, or `{ table: { header, rows, totalRows }, sheets, stats }`.
- `GET /api/materials/:id/analysis` returns `{ analysis | null }`, the stored result.
- `POST /api/materials/:id/analyse` returns `{ analysis }`. It's limited to 6 a minute per user. `{ force: true }` re-runs it and charges again.

## Database

The migration `src/features/materials/migrations/20261120090000_material_files_analysis.sql` (Postgres) and
`migrations/sqlite/012_material_files_analysis.sql` (SQLite) add the `doc` and `sheet` kinds and create the
`material_analyses` table. It's additive only: it widens a CHECK constraint and adds one table, and changes no rows.
